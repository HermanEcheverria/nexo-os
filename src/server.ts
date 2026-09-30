import { and, desc, eq } from 'drizzle-orm'
import { Hono, type Context } from 'hono'
import { cors } from 'hono/cors'
import { streamSSE } from 'hono/streaming'

import type { Db } from './kernel/db/client'
import { z } from 'zod'

import { journal, memory, processes } from './kernel/db/schema'
import type { Answer, Assistant, AssistantContext } from './llm/assistant'
import { ConversationService } from './llm/conversations'
import { ModelUnavailableError } from './llm/ollama'
import type { Kernel } from './kernel/kernel'
import { buildReport } from './kernel/report'
import type { Registry } from './kernel/tools'
import { APP_ORIGINS, hostGuard, tokenGuard } from './security'

/**
 * API local del servicio. Solo escucha en 127.0.0.1: nada fuera de tu PC puede hablarle.
 * El comando `nexo` la usa cuando el servicio está corriendo.
 */
export function createServer<R extends Registry>(
  db: Db,
  kernel: Kernel<R>,
  {
    token,
    port,
    assistant,
    name = 'amigo',
  }: { token: string; port: number; assistant?: Assistant; name?: string },
) {
  const app = new Hono()

  const summaryKey = and(eq(memory.agent, 'nexo'), eq(memory.key, 'resumen'))
  async function assistantContext(): Promise<AssistantContext> {
    return {
      report: await buildReport(db, kernel.listAgents()),
      pending: await kernel.actions.list(['pending']),
      agents: kernel.listAgents(),
      now: new Date(),
    }
  }
  /** Lo único que hace el servidor con una respuesta: lanzar al agente pedido (que solo lee). */
  async function act(answer: Answer): Promise<number | null> {
    if (answer.intencion === 'ejecutar_agente' && answer.agente) return kernel.runNow(answer.agente)
    return null
  }
  const chats = assistant
    ? new ConversationService(db, assistant, {
        context: assistantContext,
        act,
        log: (t, d) => kernel.log(t, d),
      })
    : null

  /** El resumen redactado por el modelo local; si no está disponible, el parte sigue igual. */
  async function refreshSummary() {
    if (!assistant) return
    try {
      const { text, source } = await assistant.summarize(await assistantContext())
      const value = { text, source, at: new Date().toISOString() }
      await db
        .insert(memory)
        .values({ agent: 'nexo', key: 'resumen', value })
        .onConflictDoUpdate({
          target: [memory.agent, memory.key],
          set: { value, updatedAt: new Date() },
        })
      await kernel.log('summary', { chars: text.length, source })
    } catch (error) {
      await kernel.log('summary_failed', { error: String(error) })
    }
  }

  // Orden: primero el Host, luego CORS (solo la app), luego el token
  app.use('*', hostGuard(port))
  app.use('*', cors({ origin: APP_ORIGINS, allowHeaders: ['Authorization', 'Content-Type'] }))

  // Sin token: solo dice si el servicio está vivo (la app lo usa antes de encenderlo)
  app.get('/estado', (c) => c.json({ ok: true, version: 1 }))

  app.use('*', tokenGuard(token))

  app.get('/agentes', async (c) =>
    c.json(
      kernel.listAgents().map((a) => ({
        name: a.name,
        title: a.title,
        description: a.description,
        everyMinutes: a.everyMinutes,
        onLogin: a.onLogin,
        capabilities: a.capabilities,
      })),
    ),
  )

  // Bitácora en vivo (Server-Sent Events): cada evento del núcleo llega al instante
  app.get('/eventos', (c) =>
    streamSSE(c, async (stream) => {
      const send = (event: unknown) =>
        stream.writeSSE({ event: 'bitacora', data: JSON.stringify(event) })
      const onEvent = (event: unknown) => void send(event)
      kernel.events.on('event', onEvent)
      stream.onAbort(() => void kernel.events.off('event', onEvent))
      // Latido para que la conexión no se cierre por inactividad
      while (!stream.aborted) {
        await stream.writeSSE({ event: 'latido', data: '{}' })
        await stream.sleep(15_000)
      }
    }),
  )
  app.get('/parte', async (c) =>
    c.json({
      ...(await buildReport(db, kernel.listAgents())),
      pendingActions: await kernel.actions.pendingCount(),
      summary: ((await db.select().from(memory).where(summaryKey))[0]?.value ?? null) as {
        text: string
        at: string
      } | null,
      assistant: Boolean(assistant),
      userName: name,
    }),
  )
  app.get('/ps', async (c) =>
    c.json(
      await db
        .select()
        .from(processes)
        .orderBy(desc(processes.pid))
        .limit(Number(c.req.query('n') ?? 15)),
    ),
  )
  app.get('/logs', async (c) => {
    const pid = c.req.query('pid')
    const rows = await db
      .select()
      .from(journal)
      .where(pid ? eq(journal.pid, Number(pid)) : undefined)
      .orderBy(desc(journal.id))
      .limit(Number(c.req.query('n') ?? 40))
    return c.json(rows.reverse())
  })
  app.post('/ejecutar/:agente', async (c) => {
    const agent = c.req.param('agente')
    if (!kernel.listAgents().some((a) => a.name === agent))
      return c.json({ error: `No existe "${agent}"` }, 404)
    return c.json({ pid: await kernel.runNow(agent) })
  })
  app.post('/iniciar-sesion', async (c) => {
    await kernel.login()
    await refreshSummary()
    return c.json({ ok: true })
  })

  // Preguntas en español al modelo local. Solo puede responder, lanzar un agente
  // (que solo lee) o llevarte a Aprobaciones: nunca cambia la PC por su cuenta.
  app.post('/preguntar', async (c) => {
    if (!assistant)
      return c.json({ error: 'El modelo local está desactivado en la configuración' }, 503)
    const body = z
      .object({ texto: z.string().trim().min(2).max(500) })
      .safeParse(await c.req.json().catch(() => null))
    if (!body.success) return c.json({ error: 'Escribe una pregunta (hasta 500 caracteres)' }, 400)
    await kernel.log('question', { texto: body.data.texto })
    try {
      const answer = await assistant.ask(body.data.texto, await assistantContext())
      await kernel.log('answer', { intencion: answer.intencion, agente: answer.agente })
      return c.json({ ...answer, pid: await act(answer) })
    } catch (error) {
      await kernel.log('answer_failed', { error: String(error) })
      if (error instanceof ModelUnavailableError)
        return c.json({ error: error.message, code: 'iniciando' }, 503)
      return c.json({ error: 'El modelo local no respondió. ¿Está abierto Ollama?' }, 502)
    }
  })
  // Conversaciones con el asistente (historial local, como un chat)
  const idParam = (c: Context) => {
    const id = Number(c.req.param('id'))
    return Number.isInteger(id) && id > 0 ? id : null
  }
  app.get('/conversaciones', async (c) => c.json(chats ? await chats.list() : []))
  app.post('/conversaciones', async (c) => {
    if (!chats)
      return c.json({ error: 'El modelo local está desactivado en la configuración' }, 503)
    return c.json(await chats.create(), 201)
  })
  app.get('/conversaciones/:id', async (c) => {
    const id = idParam(c)
    const found = id && chats ? await chats.get(id) : null
    return found ? c.json(found) : c.json({ error: 'No existe esa conversación' }, 404)
  })
  app.delete('/conversaciones/:id', async (c) => {
    const id = idParam(c)
    return id && chats && (await chats.remove(id))
      ? c.json({ ok: true })
      : c.json({ error: 'No existe esa conversación' }, 404)
  })
  app.post('/conversaciones/:id/mensajes', async (c) => {
    const id = idParam(c)
    if (!id || !chats) return c.json({ error: 'No existe esa conversación' }, 404)
    const body = z
      .object({ texto: z.string().trim().min(2).max(500) })
      .safeParse(await c.req.json().catch(() => null))
    if (!body.success) return c.json({ error: 'Escribe un mensaje (hasta 500 caracteres)' }, 400)
    try {
      return c.json(await chats.send(id, body.data.texto))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message.startsWith('No existe')) return c.json({ error: message }, 404)
      await kernel.log('answer_failed', { conversation: id, error: message })
      if (error instanceof ModelUnavailableError)
        return c.json({ error: error.message, code: 'iniciando' }, 503)
      return c.json({ error: 'El modelo local no respondió. ¿Está abierto Ollama?' }, 502)
    }
  })

  // Cola de aprobaciones
  app.get('/acciones', async (c) => {
    const filtro = c.req.query('estado')
    if (filtro === 'pendientes') return c.json(await kernel.actions.list(['pending']))
    if (filtro === 'deshacibles') return c.json(await kernel.actions.undoable())
    return c.json(await kernel.actions.list(undefined, Number(c.req.query('n') ?? 50)))
  })
  const decide = (verb: 'approve' | 'reject' | 'undo') => async (c: Context) => {
    const id = Number(c.req.param('id'))
    if (!Number.isInteger(id) || id <= 0) return c.json({ error: 'Id inválido' }, 400)
    try {
      return c.json(await kernel.actions[verb](id))
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 409)
    }
  }
  app.post('/acciones/:id/aprobar', decide('approve'))
  app.post('/acciones/:id/rechazar', decide('reject'))
  app.post('/acciones/:id/deshacer', decide('undo'))

  app.post('/detener/:pid', (c) => c.json({ stopped: kernel.kill(Number(c.req.param('pid'))) }))

  return app
}
