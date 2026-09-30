import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'

import { centinela } from '../src/agents/centinela'
import { salud } from '../src/agents/salud'
import { defaultConfig } from '../src/config'
import { openDatabase, type Database } from '../src/kernel/db/client'
import { Kernel } from '../src/kernel/kernel'
import { PrivacyGuard } from '../src/kernel/privacy'
import { buildReport } from '../src/kernel/report'
import { defineTool, type Registry } from '../src/kernel/tools'
import type { Tools } from '../src/tools'
import { batteryHealth, parseNvidiaSmi } from '../src/tools/health'
import {
  classifyPorts,
  decodeProductState,
  SAFE_FILES,
  SECRET_FILES,
  securityTools,
} from '../src/tools/security'

describe('funciones de seguridad y salud', () => {
  it('lee el estado de los antivirus como lo reporta Windows', () => {
    expect(decodeProductState(0x041000)).toEqual({ enabled: true, upToDate: true }) // Norton 360 real
    expect(decodeProductState(0x060100)).toMatchObject({ enabled: false }) // Defender en pausa
    expect(decodeProductState(0x061110)).toEqual({ enabled: true, upToDate: false })
  })

  it('marca como riesgosos solo los puertos que no deberían estar abiertos a la red', () => {
    const ports = classifyPorts([
      { port: 445, process: 'System' },
      { port: 5432, process: 'postgres' },
      { port: 11434, process: 'ollama' },
    ])
    expect(ports.filter((p) => p.risk).map((p) => p.risk)).toEqual(['PostgreSQL', 'Ollama'])
  })

  it('calcula el desgaste de la batería y lee nvidia-smi', () => {
    expect(batteryHealth(84292, 40003)).toBeCloseTo(0.4746, 3)
    expect(batteryHealth(null, 40003)).toBeNull()
    expect(
      parseNvidiaSmi('NVIDIA GeForce RTX 3070 Ti Laptop GPU, 46, 3, 4157, 8192, 13.06, P8'),
    ).toMatchObject({
      temperature: 46,
      utilization: 3,
      pstate: 'P8',
    })
  })

  it('reconoce archivos sensibles y deja pasar las plantillas', () => {
    expect(
      ['.env', 'api/.env.production', 'keys/id_rsa', 'cert.pem'].every((f) => SECRET_FILES.test(f)),
    ).toBe(true)
    expect(SAFE_FILES.test('.env.example')).toBe(true)
    expect(SECRET_FILES.test('src/environment.ts')).toBe(false)
  })

  it('encuentra secretos versionados en un repositorio, sin guardar su valor', async () => {
    const root = mkdtempSync(join(tmpdir(), 'nexo-repos-'))
    const repo = join(root, 'proyecto')
    mkdirSync(repo)
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', repo, ...args], { stdio: 'ignore' })
    git('init', '-q')
    // El token se arma al ejecutar la prueba: así no queda un "secreto" literal en el repositorio
    const fakeToken = ['ghp', '_', 'x'.repeat(36)].join('')
    writeFileSync(join(repo, 'config.ts'), `export const token = '${fakeToken}'\n`)
    writeFileSync(join(repo, '.env'), 'CLAVE=algo\n')
    writeFileSync(join(repo, '.env.example'), 'CLAVE=\n')
    git('add', '.')

    const hits = await securityTools['seguridad.secretos'].run(
      {},
      {
        config: defaultConfig({ projectRoots: [root] }),
        privacy: new PrivacyGuard([], '.nexo-privado'),
        signal: new AbortController().signal,
      },
    )
    expect(hits).toEqual([
      { repo: 'proyecto', file: '.env', line: null, type: 'archivo sensible' },
      { repo: 'proyecto', file: 'config.ts', line: 1, type: 'token de GitHub' },
    ])
    expect(JSON.stringify(hits)).not.toContain(fakeToken)
  })
})

describe('agentes Centinela y Salud', () => {
  let database: Database
  beforeEach(async () => {
    database = await openDatabase()
  })
  afterEach(() => database.close())

  function fakeTools(overrides: Partial<Record<string, () => Promise<unknown>>>) {
    const fake = (name: string, run: () => Promise<unknown>) =>
      defineTool({ name, risk: 'read', description: name, input: z.object({}), run })
    const base: Record<string, () => Promise<unknown>> = {
      'seguridad.antivirus': async () => ({
        antivirus: [
          { name: 'Norton 360', enabled: true, upToDate: true },
          { name: 'Windows Defender', enabled: false, upToDate: true },
        ],
        firewall: [{ name: 'Public', enabled: true }],
      }),
      'seguridad.puertos': async () => classifyPorts([{ port: 5432, process: 'postgres' }]),
      'seguridad.inicio': async () => [{ name: 'OneDrive', location: 'Run' }],
      'seguridad.secretos': async () => [],
      'salud.bateria': async () => ({
        present: true,
        charging: false,
        percent: 60,
        designMwh: 84292,
        fullMwh: 40003,
        health: 0.47,
        cycles: null,
      }),
      'salud.gpu': async () => ({
        name: 'GPU',
        temperature: 50,
        utilization: 0,
        memoryUsedMb: 1024,
        memoryTotalMb: 8192,
        powerW: 10,
        pstate: 'P8',
      }),
      'salud.sistema': async () => ({
        ramFreeGb: 10,
        ramTotalGb: 32,
        bootedAt: new Date().toISOString(),
        disks: [{ name: 'NVMe', health: 'Healthy' }],
        top: [{ name: 'chrome', memoryMb: 2048, cpuSeconds: 5 }],
      }),
      ...overrides,
    }
    return Object.fromEntries(
      Object.entries(base).map(([k, v]) => [k, fake(k, v!)]),
    ) as unknown as Tools & Registry
  }

  it('Centinela alerta del puerto expuesto y aclara que Defender en pausa es normal', async () => {
    const kernel = new Kernel(
      database.db,
      [centinela],
      fakeTools({}),
      defaultConfig(),
      new PrivacyGuard([], '.p'),
    )
    await kernel.runNow('centinela')
    const { items } = await buildReport(database.db, [centinela])
    expect(items.filter((i) => i.level === 'warning').map((i) => i.title)).toEqual([
      'PostgreSQL acepta conexiones desde toda la red (puerto 5432)',
    ])
    expect(items.find((i) => i.title.startsWith('Antivirus'))?.detail).toMatch(
      /en pausa porque otro antivirus/,
    )
  })

  it('Centinela avisa si no hay ningún antivirus activo', async () => {
    const tools = fakeTools({
      'seguridad.antivirus': async () => ({
        antivirus: [{ name: 'Windows Defender', enabled: false, upToDate: true }],
        firewall: [],
      }),
    })
    const kernel = new Kernel(
      database.db,
      [centinela],
      tools,
      defaultConfig(),
      new PrivacyGuard([], '.p'),
    )
    await kernel.runNow('centinela')
    const { items } = await buildReport(database.db, [centinela])
    expect(items[0]).toMatchObject({ level: 'warning', title: 'No hay ningún antivirus activo' })
  })

  it('Salud sugiere revisar la batería desgastada y explica el efecto de estar sin cargador', async () => {
    const kernel = new Kernel(
      database.db,
      [salud],
      fakeTools({}),
      defaultConfig(),
      new PrivacyGuard([], '.p'),
    )
    await kernel.runNow('salud')
    const { items } = await buildReport(database.db, [salud])
    const battery = items.find((i) => i.title.includes('batería'))!
    expect(battery).toMatchObject({
      level: 'suggestion',
      title: 'La batería conserva el 47 % de su capacidad original',
    })
    expect(battery.detail).toMatch(/el modelo local responde más lento/)
  })
})
