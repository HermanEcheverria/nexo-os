import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'

import { defaultConfig } from '../src/config'
import { defineAgent } from '../src/kernel/agent'
import { openDatabase, type Database } from '../src/kernel/db/client'
import { Kernel } from '../src/kernel/kernel'
import { PrivacyGuard } from '../src/kernel/privacy'
import { defineTool } from '../src/kernel/tools'
import { quarantineTool, type QuarantineResult } from '../src/tools/quarantine'

const DAY = 86_400_000
let database: Database
let clock: Date
let calls: { input: unknown; actionId?: number }[]
let purged: number

const tools = {
  'leer.algo': defineTool({
    name: 'leer.algo',
    risk: 'read',
    description: '',
    input: z.object({}),
    run: async () => 1,
  }),
  'cambiar.algo': defineTool({
    name: 'cambiar.algo',
    risk: 'write',
    description: '',
    input: z.object({ n: z.number() }),
    async run(input, env) {
      calls.push({ input, actionId: env.actionId })
      if (input.n < 0) throw new Error('número inválido')
      return { hecho: input.n }
    },
    undo: async (result) => result,
    purge: async () => void (purged += 1),
  }),
}
type Tools = typeof tools

beforeEach(async () => {
  database = await openDatabase()
  clock = new Date('2026-09-29T08:00:00Z')
  calls = []
  purged = 0
})
afterEach(() => database.close())

function setup(proposals: { tool: keyof Tools & string; input: Record<string, unknown> }[]) {
  const agent = defineAgent<Tools>({
    name: 'proponente',
    title: 'Proponente',
    description: '',
    capabilities: ['leer.algo', 'cambiar.algo'],
    everyMinutes: 60,
    onLogin: true,
    async run(ctx) {
      for (const p of proposals)
        await ctx.propose({ ...p, title: `Cambiar ${JSON.stringify(p.input)}` })
    },
  })
  return new Kernel(database.db, [agent], tools, defaultConfig(), new PrivacyGuard([], '.p'), {
    now: () => clock,
  })
}

describe('cola de aprobaciones', () => {
  it('una propuesta NO se ejecuta hasta que la apruebas, y se ejecuta tal cual', async () => {
    const kernel = setup([{ tool: 'cambiar.algo', input: { n: 7 } }])
    await kernel.runNow('proponente')
    expect(calls).toEqual([])

    const [pending] = await kernel.actions.list(['pending'])
    const done = await kernel.actions.approve(pending!.id)
    expect(done.state).toBe('done')
    expect(done.result).toEqual({ hecho: 7 })
    expect(calls).toEqual([{ input: { n: 7 }, actionId: pending!.id }])
  })

  it('no repite lo pendiente ni lo que rechazaste hace poco', async () => {
    const kernel = setup([{ tool: 'cambiar.algo', input: { n: 1 } }])
    await kernel.runNow('proponente')
    await kernel.runNow('proponente')
    const pending = await kernel.actions.list(['pending'])
    expect(pending).toHaveLength(1)

    await kernel.actions.reject(pending[0]!.id)
    clock = new Date(clock.getTime() + 10 * DAY)
    await kernel.runNow('proponente')
    expect(await kernel.actions.list(['pending'])).toHaveLength(0)

    clock = new Date(clock.getTime() + 25 * DAY) // pasó el mes de silencio
    await kernel.runNow('proponente')
    expect(await kernel.actions.list(['pending'])).toHaveLength(1)
  })

  it('un agente no puede proponer herramientas de solo lectura ni con entrada inválida', async () => {
    const lectura = setup([{ tool: 'leer.algo', input: {} }])
    await lectura.runNow('proponente')
    const invalida = setup([{ tool: 'cambiar.algo', input: { n: 'muchos' } }])
    await invalida.runNow('proponente')
    expect(await lectura.actions.list()).toHaveLength(0)
  })

  it('si la herramienta falla, la acción queda como fallida con el motivo', async () => {
    const kernel = setup([{ tool: 'cambiar.algo', input: { n: -1 } }])
    await kernel.runNow('proponente')
    const [pending] = await kernel.actions.list(['pending'])
    const failed = await kernel.actions.approve(pending!.id)
    expect(failed.state).toBe('failed')
    expect(failed.error).toBe('número inválido')
  })

  it('se puede deshacer, y a los 30 días se vuelve definitivo', async () => {
    const kernel = setup([
      { tool: 'cambiar.algo', input: { n: 1 } },
      { tool: 'cambiar.algo', input: { n: 2 } },
    ])
    await kernel.runNow('proponente')
    const [b, a] = await kernel.actions.list(['pending'])
    await kernel.actions.approve(a!.id)
    await kernel.actions.approve(b!.id)

    expect((await kernel.actions.undo(a!.id)).state).toBe('undone')
    await expect(kernel.actions.undo(a!.id)).rejects.toThrow(/Solo se puede deshacer/)

    clock = new Date(clock.getTime() + 31 * DAY)
    expect(await kernel.actions.purgeExpired()).toEqual([b!.id])
    expect(purged).toBe(1)
  })
})

describe('herramienta de cuarentena (WSL)', () => {
  function env(projectRoot: string, quarantineDir: string, forbidden: string[] = []) {
    return {
      config: defaultConfig({ projectRoots: [projectRoot], quarantineDir }),
      privacy: new PrivacyGuard(forbidden, '.nexo-privado'),
      signal: new AbortController().signal,
      actionId: 42,
    }
  }

  function project() {
    const root = mkdtempSync(join(tmpdir(), 'nexo-proyectos-'))
    const modules = join(root, 'viejo', 'node_modules')
    mkdirSync(join(modules, 'paquete'), { recursive: true })
    writeFileSync(join(modules, 'paquete', 'index.js'), 'x'.repeat(5000))
    return { root, modules, quarantine: mkdtempSync(join(tmpdir(), 'nexo-cuarentena-')) }
  }

  it('mueve node_modules a la cuarentena y lo devuelve al deshacer', async () => {
    const { root, modules, quarantine } = project()
    const e = env(root, quarantine)
    const result = (await quarantineTool.run({ paths: [modules] }, e)) as QuarantineResult

    expect(existsSync(modules)).toBe(false)
    expect(result.items[0]).toMatchObject({
      ok: true,
      zone: 'wsl',
      quarantined: join(quarantine, '42', '0-node_modules'),
    })
    expect(result.freedBytes).toBeGreaterThanOrEqual(5000)

    await quarantineTool.undo!(result, e)
    expect(existsSync(join(modules, 'paquete', 'index.js'))).toBe(true)
  })

  it('se niega a mover rutas fuera de lo permitido aunque se haya aprobado', async () => {
    const { root, quarantine } = project()
    const outside = mkdtempSync(join(tmpdir(), 'nexo-otro-'))
    await expect(quarantineTool.run({ paths: [outside] }, env(root, quarantine))).rejects.toThrow(
      /No permitido/,
    )
    await expect(
      quarantineTool.run({ paths: [`${root}/viejo/../../etc`] }, env(root, quarantine)),
    ).rejects.toThrow(/No permitido/)
    expect(existsSync(outside)).toBe(true)
  })

  it('respeta las zonas privadas', async () => {
    const { root, modules, quarantine } = project()
    await expect(
      quarantineTool.run({ paths: [modules] }, env(root, quarantine, [root])),
    ).rejects.toThrow(/zona privada/)
    expect(existsSync(modules)).toBe(true)
  })

  it('al vencer el plazo borra de verdad lo que estaba en cuarentena', async () => {
    const { root, modules, quarantine } = project()
    const e = env(root, quarantine)
    const result = (await quarantineTool.run({ paths: [modules] }, e)) as QuarantineResult
    await quarantineTool.purge!(result, e)
    expect(existsSync(result.items[0]!.quarantined)).toBe(false)
  })
})
