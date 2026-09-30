import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'

import { defaultConfig } from '../src/config'
import { defineAgent } from '../src/kernel/agent'
import { openDatabase, type Database } from '../src/kernel/db/client'
import { Kernel } from '../src/kernel/kernel'
import { PrivacyGuard } from '../src/kernel/privacy'
import { compareRuns, lastRunSummary, runDetails } from '../src/kernel/runs'
import { defineTool } from '../src/kernel/tools'

describe('qué cambió entre revisiones', () => {
  it('distingue nuevo, resuelto y cambiado (un número distinto no es un hallazgo nuevo)', () => {
    const before = [
      { level: 'warning' as const, title: 'nexo-os: 12 archivos sin commit' },
      { level: 'info' as const, title: 'Memoria: 69 % en uso' },
    ]
    const after = [
      {
        level: 'warning' as const,
        title: 'PostgreSQL acepta conexiones desde toda la red (puerto 5432)',
      },
      { level: 'info' as const, title: 'Memoria: 71 % en uso' },
    ]
    expect(compareRuns(before, after)).toEqual([
      {
        kind: 'nuevo',
        level: 'warning',
        title: 'PostgreSQL acepta conexiones desde toda la red (puerto 5432)',
      },
      { kind: 'resuelto', level: 'warning', title: 'nexo-os: 12 archivos sin commit' },
      {
        kind: 'cambio',
        level: 'info',
        before: 'Memoria: 69 % en uso',
        after: 'Memoria: 71 % en uso',
      },
    ])
  })
})

describe('detalle de una ejecución', () => {
  let database: Database
  beforeEach(async () => {
    database = await openDatabase()
  })
  afterEach(() => database.close())

  it('reúne pasos, hallazgos, resumen y cambios respecto de la revisión anterior', async () => {
    let round = 0
    const tools = {
      mirar: defineTool({
        name: 'mirar',
        risk: 'read',
        description: '',
        input: z.object({}),
        run: async () => round,
      }),
    }
    const agent = defineAgent<typeof tools>({
      name: 'vigia',
      title: 'Vigía',
      description: '',
      capabilities: ['mirar'],
      everyMinutes: 60,
      onLogin: true,
      async run(ctx) {
        round += 1
        await ctx.tools.call('mirar')
        if (round === 2) await ctx.finding({ level: 'warning', title: 'Algo nuevo' })
        await ctx.finding({ level: 'info', title: `Vuelta ${round}` })
      },
    })
    const kernel = new Kernel(
      database.db,
      [agent],
      tools,
      defaultConfig(),
      new PrivacyGuard([], '.p'),
    )
    await kernel.runNow('vigia')
    const pid = await kernel.runNow('vigia')

    const details = (await runDetails(database.db, pid))!
    expect(details.steps.map((s) => s.type)).toEqual([
      'spawn',
      'start',
      'tool_call',
      'finding',
      'finding',
      'exit',
    ])
    expect(details.summary).toEqual({ warning: 1, suggestion: 0, info: 1 })
    expect(details.changes).toEqual([
      { kind: 'nuevo', level: 'warning', title: 'Algo nuevo' },
      { kind: 'cambio', level: 'info', before: 'Vuelta 1', after: 'Vuelta 2' },
    ])
    expect(await lastRunSummary(database.db, 'vigia')).toMatchObject({
      pid,
      state: 'done',
      summary: { warning: 1 },
    })
    expect(kernel.toolRisk('mirar')).toBe('read')
  })
})
