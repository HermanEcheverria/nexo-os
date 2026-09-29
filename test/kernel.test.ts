import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'

import { defaultConfig } from '../src/config'
import { defineAgent, type Agent } from '../src/kernel/agent'
import { openDatabase, type Database } from '../src/kernel/db/client'
import { findings, journal, processes } from '../src/kernel/db/schema'
import { Kernel } from '../src/kernel/kernel'
import { PrivacyGuard } from '../src/kernel/privacy'
import { defineTool } from '../src/kernel/tools'

const tools = {
  'leer.numero': defineTool({
    name: 'leer.numero',
    risk: 'read',
    description: 'Devuelve un número',
    input: z.object({ n: z.number().default(1) }),
    run: async ({ n }) => n * 2,
  }),
  'borrar.todo': defineTool({
    name: 'borrar.todo',
    risk: 'write',
    description: 'Peligrosa',
    input: z.object({}),
    run: async () => 'borrado',
  }),
}
type Tools = typeof tools

let database: Database
let clock: Date
const guard = new PrivacyGuard([], '.nexo-privado')

function kernel(agents: Agent<Tools>[], options = {}) {
  return new Kernel(database.db, agents, tools, defaultConfig(), guard, {
    retryDelayMs: 5,
    now: () => clock,
    ...options,
  })
}

async function processRows() {
  return database.db.select().from(processes).orderBy(processes.pid)
}
async function events(type: string) {
  return database.db.select().from(journal).where(eq(journal.type, type))
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

beforeEach(async () => {
  database = await openDatabase()
  clock = new Date('2026-09-29T08:00:00Z')
})
afterEach(() => database.close())

const base = { title: 'Prueba', description: '', everyMinutes: 60, onLogin: true } as const

describe('Kernel', () => {
  it('corre un agente, guarda hallazgos y memoria, y deja rastro en la bitácora', async () => {
    const agent = defineAgent<Tools>({
      ...base,
      name: 'contador',
      capabilities: ['leer.numero'],
      async run(ctx) {
        const n = await ctx.tools.call('leer.numero', { n: 21 })
        const before = (await ctx.memory.get<number>('veces')) ?? 0
        await ctx.memory.set('veces', before + 1)
        await ctx.finding({ level: 'info', title: `Resultado ${n}` })
      },
    })
    const k = kernel([agent])
    await k.runNow('contador')
    await k.runNow('contador')

    expect((await processRows()).map((p) => p.state)).toEqual(['done', 'done'])
    const rows = await database.db.select().from(findings)
    expect(rows.map((f) => f.title)).toEqual(['Resultado 42', 'Resultado 42'])
    expect(await events('tool_call')).toHaveLength(2)
  })

  it('niega herramientas que el agente no declaró, y las que cambian la PC', async () => {
    const curioso = defineAgent<Tools>({
      ...base,
      name: 'curioso',
      capabilities: ['leer.numero'],
      run: async (ctx) => void (await ctx.tools.call('borrar.todo')),
    })
    const atrevido = defineAgent<Tools>({
      ...base,
      name: 'atrevido',
      capabilities: ['borrar.todo'],
      run: async (ctx) => void (await ctx.tools.call('borrar.todo')),
    })
    const k = kernel([curioso, atrevido], { maxAttempts: 1 })
    await k.runNow('curioso')
    await k.runNow('atrevido')

    const [p1, p2] = await processRows()
    expect(p1?.state).toBe('failed')
    expect(p1?.error).toMatch(/no tiene permiso/)
    expect(p2?.error).toMatch(/necesita tu aprobación/)
    const denied = await events('tool_denied')
    expect(denied.map((e) => e.data.reason)).toEqual(['not-granted', 'needs-approval'])
  })

  it('reintenta un agente que falla, con límite de intentos', async () => {
    let calls = 0
    const fragil = defineAgent<Tools>({
      ...base,
      name: 'fragil',
      capabilities: [],
      async run() {
        calls += 1
        if (calls < 3) throw new Error('falla temporal')
      },
    })
    const k = kernel([fragil], { maxAttempts: 3 })
    await k.runNow('fragil')
    await wait(60)

    const rows = await processRows()
    expect(rows.map((p) => [p.state, p.trigger, p.attempt])).toEqual([
      ['failed', 'manual', 1],
      ['failed', 'retry', 2],
      ['done', 'retry', 3],
    ])
  })

  it('retoma lo que quedó a medias si el sistema se apagó', async () => {
    const agent = defineAgent<Tools>({
      ...base,
      name: 'lento',
      capabilities: [],
      run: async () => {},
    })
    // Simula un proceso que estaba corriendo cuando se apagó la PC
    await database.db
      .insert(processes)
      .values({ agent: 'lento', state: 'running', trigger: 'login' })

    const k = kernel([agent])
    const retried = await k.recover()

    expect(retried).toHaveLength(1)
    expect((await processRows()).map((p) => p.state)).toEqual(['interrupted', 'done'])
  })

  it('detiene un proceso a pedido y por tiempo máximo', async () => {
    const eterno = defineAgent<Tools>({
      ...base,
      name: 'eterno',
      capabilities: [],
      timeoutMs: 50,
      run: () => new Promise(() => {}),
    })
    const k = kernel([eterno], { maxAttempts: 1 })

    const pid = await k.spawn('eterno', 'manual')
    const running = k.execute(pid)
    await wait(5)
    expect(k.kill(pid)).toBe(true)
    await running
    await k.runNow('eterno')

    const [killed, timedOut] = await processRows()
    expect(killed?.state).toBe('killed')
    expect(timedOut?.state).toBe('failed')
    expect(timedOut?.error).toMatch(/tiempo máximo/)
  })

  it('el planificador lanza solo a los que les toca según su horario', async () => {
    const cada10 = defineAgent<Tools>({
      ...base,
      name: 'cada10',
      everyMinutes: 10,
      capabilities: [],
      run: async () => {},
    })
    const cadaHora = defineAgent<Tools>({
      ...base,
      name: 'cadaHora',
      everyMinutes: 60,
      capabilities: [],
      run: async () => {},
    })
    const k = kernel([cada10, cadaHora])

    await k.tick() // primera vez: corren los dos
    clock = new Date(clock.getTime() + 15 * 60_000)
    await k.tick() // 15 minutos después: solo el de cada 10

    const rows = await processRows()
    expect(rows.map((p) => p.agent)).toEqual(['cada10', 'cadaHora', 'cada10'])
  })

  it('al iniciar sesión corren los agentes marcados para eso', async () => {
    const a = defineAgent<Tools>({ ...base, name: 'a', capabilities: [], run: async () => {} })
    const b = defineAgent<Tools>({
      ...base,
      name: 'b',
      onLogin: false,
      capabilities: [],
      run: async () => {},
    })
    await kernel([a, b]).login()
    expect((await processRows()).map((p) => [p.agent, p.trigger])).toEqual([['a', 'login']])
  })
})
