import { createHash } from 'node:crypto'
import { and, desc, eq, gte, inArray, lt } from 'drizzle-orm'

import type { Config } from '../config'
import type { Db } from './db/client'
import { actions } from './db/schema'
import type { PrivacyGuard } from './privacy'
import { CapabilityError, type Registry, type ToolEnv } from './tools'

export type Action = typeof actions.$inferSelect

export type Proposal = {
  tool: string
  input: Record<string, unknown>
  title: string
  detail?: string
  bytes?: number
}

const DAY = 86_400_000
/** Plazo para deshacer: después, lo que está en cuarentena se borra de verdad. */
export const UNDO_DAYS = 30
/** Si rechazas algo, el agente no lo vuelve a proponer durante este tiempo. */
export const QUIET_DAYS = 30

type Log = (
  type: string,
  data: Record<string, unknown>,
  pid?: number,
  agent?: string,
) => Promise<void>

/**
 * Gobierno de los cambios: los agentes solo PROPONEN; ejecutar, rechazar, deshacer
 * y purgar pasa por aquí, y todo queda en la bitácora.
 */
export class ActionManager<R extends Registry> {
  constructor(
    private readonly db: Db,
    private readonly tools: R,
    private readonly config: Config,
    private readonly privacy: PrivacyGuard,
    private readonly log: Log,
    private readonly now: () => Date,
  ) {}

  private env(actionId: number): ToolEnv {
    return {
      config: this.config,
      privacy: this.privacy,
      signal: new AbortController().signal,
      actionId,
    }
  }

  /**
   * Registra una propuesta de un agente. Se valida que el agente tenga la capacidad,
   * que la herramienta de verdad cambie algo y que la entrada sea válida.
   * Devuelve el id, o null si ya estaba pendiente o la rechazaste hace poco.
   */
  async propose(
    pid: number,
    agent: string,
    granted: readonly string[],
    p: Proposal,
  ): Promise<number | null> {
    const tool = this.tools[p.tool]
    if (!tool) throw new CapabilityError(p.tool, 'unknown')
    if (!granted.includes(p.tool)) throw new CapabilityError(p.tool, 'not-granted')
    if (tool.risk === 'read') throw new Error(`"${p.tool}" solo lee: no hace falta proponerla`)
    const input = tool.input.parse(p.input) as Record<string, unknown>

    const fingerprint = createHash('sha256')
      .update(JSON.stringify([agent, p.tool, input]))
      .digest('hex')
    const quietSince = new Date(this.now().getTime() - QUIET_DAYS * DAY)
    const [existing] = await this.db
      .select({ id: actions.id, state: actions.state, decidedAt: actions.decidedAt })
      .from(actions)
      .where(eq(actions.fingerprint, fingerprint))
      .orderBy(desc(actions.id))
      .limit(1)
    if (existing?.state === 'pending') return null
    if (existing?.state === 'rejected' && existing.decidedAt && existing.decidedAt >= quietSince)
      return null

    const [row] = await this.db
      .insert(actions)
      .values({
        pid,
        agent,
        tool: p.tool,
        input,
        fingerprint,
        title: p.title,
        detail: p.detail,
        bytes: p.bytes,
        state: 'pending',
        createdAt: this.now(),
      })
      .returning({ id: actions.id })
    await this.log('proposal', { action: row!.id, tool: p.tool, title: p.title }, pid, agent)
    return row!.id
  }

  async list(states?: Action['state'][], limit = 100): Promise<Action[]> {
    return this.db
      .select()
      .from(actions)
      .where(states ? inArray(actions.state, states) : undefined)
      .orderBy(desc(actions.id))
      .limit(limit)
  }

  private async get(id: number): Promise<Action> {
    const [row] = await this.db.select().from(actions).where(eq(actions.id, id))
    if (!row) throw new Error(`No existe la acción ${id}`)
    return row
  }

  /** Ejecuta EXACTAMENTE la entrada que aprobaste. */
  async approve(id: number): Promise<Action> {
    const action = await this.get(id)
    if (action.state !== 'pending')
      throw new Error(`La acción ${id} no está pendiente (${action.state})`)
    const tool = this.tools[action.tool]!
    await this.db
      .update(actions)
      .set({ state: 'running', decidedAt: this.now() })
      .where(eq(actions.id, id))
    await this.log('approved', { action: id, tool: action.tool }, action.pid, action.agent)

    try {
      const result = await tool.run(tool.input.parse(action.input), this.env(id))
      await this.db
        .update(actions)
        .set({ state: 'done', executedAt: this.now(), result })
        .where(eq(actions.id, id))
      await this.log('action_done', { action: id, tool: action.tool }, action.pid, action.agent)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await this.db
        .update(actions)
        .set({ state: 'failed', error: message })
        .where(eq(actions.id, id))
      await this.log('action_failed', { action: id, error: message }, action.pid, action.agent)
    }
    return this.get(id)
  }

  async reject(id: number): Promise<Action> {
    const action = await this.get(id)
    if (action.state !== 'pending')
      throw new Error(`La acción ${id} no está pendiente (${action.state})`)
    await this.db
      .update(actions)
      .set({ state: 'rejected', decidedAt: this.now() })
      .where(eq(actions.id, id))
    await this.log('rejected', { action: id }, action.pid, action.agent)
    return this.get(id)
  }

  /** Deshace una acción ejecutada, mientras no haya vencido su plazo. */
  async undo(id: number): Promise<Action> {
    const action = await this.get(id)
    if (action.state !== 'done')
      throw new Error(`Solo se puede deshacer una acción ejecutada (está ${action.state})`)
    const tool = this.tools[action.tool]!
    if (!tool.undo) throw new Error(`"${action.tool}" no se puede deshacer`)
    const restored = await tool.undo(action.result as never, this.env(id))
    await this.db
      .update(actions)
      .set({ state: 'undone', decidedAt: this.now() })
      .where(eq(actions.id, id))
    await this.log('undone', { action: id, restored: restored as never }, action.pid, action.agent)
    return this.get(id)
  }

  /** Mantenimiento: vuelve definitivo lo que ya pasó su plazo para deshacer. */
  async purgeExpired(): Promise<number[]> {
    const limit = new Date(this.now().getTime() - UNDO_DAYS * DAY)
    const expired = await this.db
      .select()
      .from(actions)
      .where(and(eq(actions.state, 'done'), lt(actions.executedAt, limit)))
    const purged: number[] = []
    for (const action of expired) {
      const tool = this.tools[action.tool]
      if (!tool?.purge) continue
      try {
        await tool.purge(action.result as never, this.env(action.id))
        await this.db.update(actions).set({ state: 'purged' }).where(eq(actions.id, action.id))
        await this.log('purged', { action: action.id }, action.pid, action.agent)
        purged.push(action.id)
      } catch (error) {
        await this.log(
          'purge_failed',
          { action: action.id, error: String(error) },
          action.pid,
          action.agent,
        )
      }
    }
    return purged
  }

  async pendingCount(): Promise<number> {
    return (
      await this.db.select({ id: actions.id }).from(actions).where(eq(actions.state, 'pending'))
    ).length
  }

  /** Acciones ejecutadas que todavía se pueden deshacer. */
  async undoable(): Promise<Action[]> {
    const since = new Date(this.now().getTime() - UNDO_DAYS * DAY)
    return this.db
      .select()
      .from(actions)
      .where(and(eq(actions.state, 'done'), gte(actions.executedAt, since)))
      .orderBy(desc(actions.id))
  }
}
