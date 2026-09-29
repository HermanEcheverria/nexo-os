import { desc, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { streamSSE } from 'hono/streaming'

import type { Db } from './kernel/db/client'
import { journal, processes } from './kernel/db/schema'
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
  { token, port }: { token: string; port: number },
) {
  const app = new Hono()

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
  app.get('/parte', async (c) => c.json(await buildReport(db, kernel.listAgents())))
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
    return c.json({ ok: true })
  })
  app.post('/detener/:pid', (c) => c.json({ stopped: kernel.kill(Number(c.req.param('pid'))) }))

  return app
}
