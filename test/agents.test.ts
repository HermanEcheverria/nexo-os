import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'

import { inventario } from '../src/agents/inventario'
import { jardinero } from '../src/agents/jardinero'
import { limpiador } from '../src/agents/limpiador'
import { defaultConfig } from '../src/config'
import { openDatabase, type Database } from '../src/kernel/db/client'
import { Kernel } from '../src/kernel/kernel'
import { PrivacyGuard } from '../src/kernel/privacy'
import { buildReport } from '../src/kernel/report'
import { defineTool, type Registry } from '../src/kernel/tools'
import type { Tools } from '../src/tools'
import { renderReport } from '../src/render'

const GB = 1024 ** 3
const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString()

/** Herramientas falsas con los mismos nombres y formas que las reales. */
function fakeTools(state: {
  downloads: { name: string; bytes: number; modified: string; accessed: string }[]
}) {
  const fake = <N extends keyof Tools>(name: N, run: () => Promise<unknown>) =>
    defineTool({ name, risk: 'read', description: name, input: z.object({}), run })
  return {
    'sistema.discos': fake('sistema.discos', async () => [
      { name: 'C:', totalBytes: 1000 * GB, freeBytes: 100 * GB },
      { name: 'WSL', totalBytes: 1000 * GB, freeBytes: 900 * GB },
    ]),
    'windows.descargas': fake('windows.descargas', async () => ({
      path: 'C:\\Users\\x\\Downloads',
      private: false,
      items: state.downloads.map((d) => ({ ...d, isDir: false })),
    })),
    'sistema.caches': fake('sistema.caches', async () => [
      { id: 'win-npm', label: 'npm', path: 'x', bytes: 5 * GB, regenerable: true },
      { id: 'tiny', label: 'pequeña', path: 'x', bytes: 1024, regenerable: true },
      { id: 'win-docker', label: 'Docker', path: 'x', bytes: 30 * GB, regenerable: false },
    ]),
    'proyectos.revisar': fake('proyectos.revisar', async () => [
      {
        path: '/p/activo',
        name: 'activo',
        branch: 'main',
        lastCommit: daysAgo(1),
        dirtyFiles: 3,
        unpushed: 2,
        bytes: GB,
        nodeModulesBytes: GB,
      },
      {
        path: '/p/viejo',
        name: 'viejo',
        branch: 'main',
        lastCommit: daysAgo(90),
        dirtyFiles: 0,
        unpushed: 0,
        bytes: GB,
        nodeModulesBytes: 2 * GB,
      },
    ]),
    'paquetes.apt': fake('paquetes.apt', async () => []),
    'paquetes.winget': fake('paquetes.winget', async () => []),
  } as unknown as Tools & Registry
}

let database: Database
beforeEach(async () => {
  database = await openDatabase()
})
afterEach(() => database.close())

describe('agentes', () => {
  it('Inventario avisa del disco lleno, lo viejo en Descargas y lo nuevo desde ayer', async () => {
    const state = {
      downloads: [
        { name: 'juego.zip', bytes: 30 * GB, modified: daysAgo(200), accessed: daysAgo(200) },
        { name: 'tarea.pdf', bytes: 1024, modified: daysAgo(1), accessed: daysAgo(1) },
        // Modificado hace mucho pero abierto ayer: no se sugiere
        { name: 'manual.pdf', bytes: GB, modified: daysAgo(300), accessed: daysAgo(2) },
      ],
    }
    const kernel = new Kernel(
      database.db,
      [inventario],
      fakeTools(state),
      defaultConfig(),
      new PrivacyGuard([], '.p'),
    )
    await kernel.runNow('inventario')
    state.downloads.push({
      name: 'nuevo.iso',
      bytes: 4 * GB,
      modified: daysAgo(0),
      accessed: daysAgo(0),
    })
    await kernel.runNow('inventario')

    const report = await buildReport(database.db, [inventario])
    const titles = report.items.map((i) => i.title)
    expect(report.items.find((i) => i.title.startsWith('Disco C:'))?.level).toBe('warning') // 90 % usado
    expect(titles).toContain('1 cosa en Descargas sin usar hace más de 90 días')
    expect(report.items.find((i) => i.title.startsWith('Descargas:'))?.detail).toMatch(
      /1 nuevo desde la última revisión \(4 GB\)/,
    )
    expect(report.reclaimableBytes).toBe(30 * GB)
  })

  it('Limpiador separa lo regenerable, ignora lo pequeño y solo informa Docker', async () => {
    const kernel = new Kernel(
      database.db,
      [limpiador],
      fakeTools({ downloads: [] }),
      defaultConfig(),
      new PrivacyGuard([], '.p'),
    )
    await kernel.runNow('limpiador')
    const { items } = await buildReport(database.db, [limpiador])
    expect(items.map((i) => [i.level, i.title])).toEqual([
      ['suggestion', '5 GB en cachés y temporales que se regeneran solos'],
      ['info', 'Docker: 30 GB'],
    ])
  })

  it('Jardinero alerta de trabajo sin respaldar y sugiere limpiar proyectos inactivos', async () => {
    const kernel = new Kernel(
      database.db,
      [jardinero],
      fakeTools({ downloads: [] }),
      defaultConfig(),
      new PrivacyGuard([], '.p'),
    )
    await kernel.runNow('jardinero')
    const report = await buildReport(database.db, [jardinero])
    expect(report.items.filter((i) => i.level === 'warning').map((i) => i.title)).toEqual([
      'activo: 3 archivos sin commit',
      'activo: 2 commits sin subir',
    ])
    expect(report.items.find((i) => i.level === 'suggestion')?.detail).toMatch(
      /^viejo \(90 días sin commits, 2 GB\)$/,
    )

    // El parte en texto: lo urgente primero, sin repetir el tamaño
    const text = renderReport(report, 'Andrés', new Date('2026-09-29T08:00:00'))
    expect(text).toMatch(/Buenos días, Andrés/)
    expect(text.indexOf('Requiere atención')).toBeLessThan(text.indexOf('Podrías hacer'))
    expect(text).not.toMatch(/\[2 GB\]/)
  })
})
