import { desc, eq } from 'drizzle-orm'
import { Hono } from 'hono'

import type { Db } from './kernel/db/client'
import { journal, processes } from './kernel/db/schema'
import type { Kernel } from './kernel/kernel'
import { buildReport } from './kernel/report'
import type { Registry } from './kernel/tools'

/**
 * API local del servicio. Solo escucha en 127.0.0.1: nada fuera de tu PC puede hablarle.
 * El comando `nexo` la usa cuando el servicio está corriendo.
 */
export function createServer<R extends Registry>(db: Db, kernel: Kernel<R>) {
  const app = new Hono()

  app.get('/estado', (c) => c.json({ ok: true, pid: process.pid }))
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
