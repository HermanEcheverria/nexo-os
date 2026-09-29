import { and, desc, eq, inArray } from 'drizzle-orm'
import { EventEmitter } from 'node:events'

import type { Config } from '../config'
import { ActionManager } from './actions'
import type { Agent, AgentContext } from './agent'
import type { Db } from './db/client'
import { findings, journal, memory, processes } from './db/schema'
import type { PrivacyGuard } from './privacy'
import { createToolbox, type Registry } from './tools'

type Trigger = (typeof processes.$inferSelect)['trigger']

export type KernelOptions = {
  /** Cuántos agentes pueden trabajar a la vez. */
  concurrency?: number
  /** Intentos por ejecución antes de darla por fallida. */
  maxAttempts?: number
  /** Espera antes de reintentar; crece con cada intento. */
  retryDelayMs?: number
  now?: () => Date
  /** Espera antes de revisar de nuevo tras aprobar o deshacer (agrupa varias decisiones). */
  followUpDelayMs?: number
}

/**
 * El núcleo de Nexo. Guarda todo en la base (procesos, bitácora, hallazgos, memoria),
 * así que si la PC se apaga a medio trabajo, al volver sabe qué quedó pendiente.
 */
export type JournalEvent = typeof journal.$inferSelect

export class Kernel<R extends Registry> {
  /** Cada entrada de la bitácora se emite aquí: la app la recibe en vivo por SSE. */
  readonly events = new EventEmitter<{ event: [JournalEvent] }>()
  private readonly agents: Map<string, Agent<R>>
  private readonly running = new Map<number, AbortController>()
  private readonly retryTimers = new Set<NodeJS.Timeout>()
  private timer: NodeJS.Timeout | undefined
  private stopping = false
  private lastHousekeeping = 0
  private readonly followups = new Map<string, NodeJS.Timeout>()
  /** Cola de aprobaciones: lo que proponen los agentes y lo que decides tú. */
  readonly actions: ActionManager<R>
  private readonly concurrency: number
  private readonly maxAttempts: number
  private readonly retryDelayMs: number
  private readonly now: () => Date
  private readonly followUpDelayMs: number

  constructor(
    private readonly db: Db,
    agents: Agent<R>[],
    private readonly tools: R,
    private readonly config: Config,
    private readonly privacy: PrivacyGuard,
    options: KernelOptions = {},
  ) {
    this.agents = new Map(agents.map((a) => [a.name, a]))
    this.concurrency = options.concurrency ?? 2
    this.maxAttempts = options.maxAttempts ?? 3
    this.retryDelayMs = options.retryDelayMs ?? 30_000
    this.now = options.now ?? (() => new Date())
    this.actions = new ActionManager(
      db,
      tools,
      config,
      privacy,
      (t, d, pid, a) => this.log(t, d, pid, a),
      this.now,
      (agent) => this.followUp(agent),
    )
    this.followUpDelayMs = options.followUpDelayMs ?? 3000
  }

  listAgents(): Agent<R>[] {
    return [...this.agents.values()]
  }

  async log(type: string, data: Record<string, unknown> = {}, pid?: number, agent?: string) {
    const [row] = await this.db
      .insert(journal)
      .values({ type, data, pid, agent, at: this.now() })
      .returning()
    this.events.emit('event', row!)
  }

  /**
   * Al arrancar: lo que quedó "ejecutando" o "listo" de la vez anterior se marca como
   * interrumpido y se vuelve a lanzar. Es la ejecución durable del sistema.
   */
  async recover(): Promise<number[]> {
    const orphans = await this.db
      .select()
      .from(processes)
      .where(inArray(processes.state, ['running', 'ready']))
    const pids: number[] = []
    for (const p of orphans) {
      await this.db
        .update(processes)
        .set({ state: 'interrupted', finishedAt: this.now() })
        .where(eq(processes.pid, p.pid))
      await this.log('interrupted', { reason: 'el sistema se detuvo' }, p.pid, p.agent)
      if (this.agents.has(p.agent)) pids.push(await this.spawn(p.agent, 'retry', p.attempt + 1))
    }
    await Promise.all(pids.map((pid) => this.execute(pid)))
    return pids
  }

  async spawn(name: string, trigger: Trigger, attempt = 1): Promise<number> {
    if (!this.agents.has(name)) throw new Error(`No existe el agente "${name}"`)
    const [row] = await this.db
      .insert(processes)
      .values({ agent: name, state: 'ready', trigger, attempt, createdAt: this.now() })
      .returning({ pid: processes.pid })
    await this.log('spawn', { trigger, attempt }, row!.pid, name)
    return row!.pid
  }

  /** Lanza un agente ya y espera a que termine. Devuelve el pid. */
  async runNow(name: string, trigger: Trigger = 'manual'): Promise<number> {
    const pid = await this.spawn(name, trigger)
    await this.execute(pid)
    return pid
  }

  /**
   * Tras aprobar o deshacer, el agente que propuso vuelve a revisar para que el parte
   * refleje la PC real. Varias decisiones seguidas se agrupan en una sola revisión.
   */
  private followUp(agent: string) {
    if (this.stopping || !this.agents.has(agent)) return
    clearTimeout(this.followups.get(agent))
    const timer = setTimeout(async () => {
      this.followups.delete(agent)
      await this.execute(await this.spawn(agent, 'followup'))
    }, this.followUpDelayMs)
    this.followups.set(agent, timer)
  }

  /** Detiene un proceso en marcha. */
  kill(pid: number): boolean {
    const controller = this.running.get(pid)
    if (!controller) return false
    controller.abort(new Error('detenido por el usuario'))
    return true
  }

  private context(pid: number, agent: Agent<R>, signal: AbortSignal): AgentContext<R> {
    const env = { config: this.config, privacy: this.privacy, signal }
    return {
      pid,
      config: this.config,
      signal,
      tools: createToolbox(this.tools, agent.capabilities, env, (event) =>
        this.log(event.type, { ...event }, pid, agent.name),
      ),
      finding: async (f) => {
        await this.db
          .insert(findings)
          .values({ ...f, pid, agent: agent.name, createdAt: this.now() })
        await this.log('finding', { level: f.level, title: f.title }, pid, agent.name)
      },
      propose: (proposal) => this.actions.propose(pid, agent.name, agent.capabilities, proposal),
      memory: {
        get: async <T>(key: string) => {
          const [row] = await this.db
            .select()
            .from(memory)
            .where(and(eq(memory.agent, agent.name), eq(memory.key, key)))
          return row?.value as T | undefined
        },
        set: async (key, value) => {
          await this.db
            .insert(memory)
            .values({ agent: agent.name, key, value, updatedAt: this.now() })
            .onConflictDoUpdate({
              target: [memory.agent, memory.key],
              set: { value, updatedAt: this.now() },
            })
        },
      },
      log: (message, data = {}) => this.log('message', { message, ...data }, pid, agent.name),
    }
  }

  /** Corre un proceso. Si falla, el supervisor lo reintenta con espera creciente. */
  async execute(pid: number): Promise<void> {
    const [proc] = await this.db.select().from(processes).where(eq(processes.pid, pid))
    if (!proc || proc.state !== 'ready') return
    const agent = this.agents.get(proc.agent)!

    const controller = new AbortController()
    this.running.set(pid, controller)
    const timeout = setTimeout(
      () => controller.abort(new Error('se pasó del tiempo máximo')),
      agent.timeoutMs ?? 5 * 60_000,
    )
    await this.db
      .update(processes)
      .set({ state: 'running', startedAt: this.now() })
      .where(eq(processes.pid, pid))
    await this.log('start', {}, pid, agent.name)

    try {
      const work = agent.run(this.context(pid, agent, controller.signal))
      // Si se aborta (tiempo o kill), no se espera a que el agente coopere
      await Promise.race([
        work,
        new Promise((_, reject) =>
          controller.signal.addEventListener('abort', () => reject(controller.signal.reason)),
        ),
      ])
      await this.finish(pid, 'done')
      await this.log('exit', { state: 'done' }, pid, agent.name)
    } catch (error) {
      const killed =
        controller.signal.aborted && String(controller.signal.reason).includes('usuario')
      // Si el sistema se apaga, queda interrumpido: recover() lo retoma al volver
      const state = this.stopping ? 'interrupted' : killed ? 'killed' : 'failed'
      const message = error instanceof Error ? error.message : String(error)
      await this.finish(pid, state, message)
      await this.log('exit', { state, error: message }, pid, agent.name)
      if (state === 'failed' && proc.attempt < this.maxAttempts) {
        this.scheduleRetry(agent.name, proc.attempt + 1)
      }
    } finally {
      clearTimeout(timeout)
      this.running.delete(pid)
    }
  }

  private async finish(
    pid: number,
    state: 'done' | 'failed' | 'killed' | 'interrupted',
    error?: string,
  ) {
    await this.db
      .update(processes)
      .set({ state, finishedAt: this.now(), error: error ?? null })
      .where(eq(processes.pid, pid))
  }

  private scheduleRetry(name: string, attempt: number) {
    const delay = this.retryDelayMs * 2 ** (attempt - 2)
    const timer = setTimeout(async () => {
      this.retryTimers.delete(timer)
      await this.execute(await this.spawn(name, 'retry', attempt))
    }, delay)
    this.retryTimers.add(timer)
  }

  /** Agentes a los que ya les toca trabajar según su horario. */
  async due(): Promise<Agent<R>[]> {
    const result: Agent<R>[] = []
    for (const agent of this.agents.values()) {
      if ([...this.running.keys()].length >= this.concurrency) break
      const [last] = await this.db
        .select({ createdAt: processes.createdAt, state: processes.state })
        .from(processes)
        .where(eq(processes.agent, agent.name))
        .orderBy(desc(processes.createdAt))
        .limit(1)
      if (last?.state === 'running' || last?.state === 'ready') continue
      const elapsed = last ? this.now().getTime() - last.createdAt.getTime() : Infinity
      if (elapsed >= agent.everyMinutes * 60_000) result.push(agent)
    }
    return result
  }

  /** Una vuelta del planificador: lanza a los que les toca, sin pasarse del límite. */
  async tick(): Promise<void> {
    // Una vez por hora: se vuelve definitivo lo que pasó su plazo para deshacer
    if (this.now().getTime() - this.lastHousekeeping >= 60 * 60_000) {
      this.lastHousekeeping = this.now().getTime()
      await this.actions.purgeExpired()
    }
    const free = this.concurrency - this.running.size
    const due = (await this.due()).slice(0, Math.max(0, free))
    await Promise.all(due.map(async (a) => this.execute(await this.spawn(a.name, 'schedule'))))
  }

  /** Al iniciar sesión: corren todos los agentes marcados para eso. */
  async login(): Promise<void> {
    await this.log('login')
    const agents = this.listAgents().filter((a) => a.onLogin)
    for (let i = 0; i < agents.length; i += this.concurrency) {
      await Promise.all(
        agents.slice(i, i + this.concurrency).map((a) => this.runNow(a.name, 'login')),
      )
    }
  }

  start(intervalMs = 30_000) {
    this.timer = setInterval(() => void this.tick(), intervalMs)
  }

  async stop() {
    this.stopping = true
    clearInterval(this.timer)
    this.retryTimers.forEach(clearTimeout)
    this.followups.forEach(clearTimeout)
    for (const controller of this.running.values())
      controller.abort(new Error('el sistema se apagó'))
  }
}
