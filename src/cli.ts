import { styleText } from 'node:util'
import { parseArgs } from 'node:util'
import { desc, eq } from 'drizzle-orm'
import { serve } from '@hono/node-server'

import { boot } from './boot'
import { loadConfig, PATHS } from './config'
import { journal, processes } from './kernel/db/schema'
import { buildReport, type Report } from './kernel/report'
import { renderReport } from './render'
import { createServer } from './server'
import { loadOrCreateToken, mirrorToken, windowsTokenPath } from './security'
import { tools } from './tools'
import { agents } from './agents'

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    actualizar: { type: 'boolean', short: 'a' },
    'iniciar-sesion': { type: 'boolean' },
    rotar: { type: 'boolean' },
    n: { type: 'string' },
  },
})
const [command = 'parte', ...rest] = positionals
const config = loadConfig()
const base = `http://127.0.0.1:${config.port}`
const dim = (s: string) => styleText('dim', s)

/** ¿Está corriendo el servicio? Si sí, todo pasa por él (la base solo admite un proceso). */
async function service(): Promise<boolean> {
  try {
    return (await fetch(`${base}/estado`, { signal: AbortSignal.timeout(500) })).ok
  } catch {
    return false
  }
}

async function api<T>(path: string, method = 'GET'): Promise<T> {
  const token = loadOrCreateToken(PATHS.token)
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`)
  return (await res.json()) as T
}

/** Sin servicio: arranca el sistema dentro de este comando y lo apaga al terminar. */
async function direct<T>(fn: (sys: Awaited<ReturnType<typeof boot>>) => Promise<T>): Promise<T> {
  const sys = await boot(config)
  try {
    return await fn(sys)
  } finally {
    await sys.kernel.stop()
    await sys.database.close()
  }
}

const stateColor: Record<string, Parameters<typeof styleText>[0]> = {
  done: 'green',
  running: 'cyan',
  ready: 'cyan',
  failed: 'red',
  killed: 'yellow',
  interrupted: 'yellow',
}

async function main() {
  const online = await service()

  switch (command) {
    case 'parte': {
      let report: Report
      if (online) {
        if (values.actualizar) await api('/iniciar-sesion', 'POST')
        report = await api<Report>('/parte')
      } else {
        report = await direct(async ({ kernel, database }) => {
          const first = await buildReport(database.db, kernel.listAgents())
          if (values.actualizar || first.items.length === 0) {
            process.stderr.write(dim('Los agentes están revisando tu PC…\n'))
            await kernel.login()
            return buildReport(database.db, kernel.listAgents())
          }
          return first
        })
      }
      console.log(renderReport(report))
      break
    }

    case 'ps': {
      type Row = typeof processes.$inferSelect
      const rows: Row[] = online
        ? await api<Row[]>(`/ps?n=${values.n ?? 15}`)
        : await direct(({ database }) =>
            database.db
              .select()
              .from(processes)
              .orderBy(desc(processes.pid))
              .limit(Number(values.n ?? 15)),
          )
      console.log(dim(`  PID  AGENTE       ESTADO       CAUSA     INICIO     DURACIÓN`))
      for (const p of rows.reverse()) {
        const started = p.startedAt ? new Date(p.startedAt) : null
        const ms =
          started && p.finishedAt ? new Date(p.finishedAt).getTime() - started.getTime() : null
        console.log(
          `${String(p.pid).padStart(5)}  ${p.agent.padEnd(12)} ${styleText(stateColor[p.state] ?? 'white', p.state.padEnd(12))} ${p.trigger.padEnd(9)} ${started ? started.toLocaleTimeString('es-GT') : '—'.padEnd(10)} ${ms === null ? '' : `${(ms / 1000).toFixed(1)} s`}${p.error ? dim(`  ${p.error}`) : ''}`,
        )
      }
      console.log(dim(online ? '\n  Servicio: activo' : '\n  Servicio: detenido (nexo servicio)'))
      break
    }

    case 'logs': {
      type Row = typeof journal.$inferSelect
      const pid = rest[0]
      const rows: Row[] = online
        ? await api<Row[]>(`/logs?n=${values.n ?? 40}${pid ? `&pid=${pid}` : ''}`)
        : await direct(async ({ database }) =>
            (
              await database.db
                .select()
                .from(journal)
                .where(pid ? eq(journal.pid, Number(pid)) : undefined)
                .orderBy(desc(journal.id))
                .limit(Number(values.n ?? 40))
            ).reverse(),
          )
      for (const e of rows) {
        const time = new Date(e.at).toLocaleTimeString('es-GT')
        const who = e.agent ? `${e.agent}#${e.pid}` : 'nexo'
        console.log(
          `${dim(time)} ${who.padEnd(16)} ${e.type.padEnd(12)} ${dim(JSON.stringify(e.data))}`,
        )
      }
      break
    }

    case 'agentes': {
      for (const a of agents) {
        console.log(`\n${styleText('bold', a.title)} ${dim(`(${a.name})`)} — ${a.description}`)
        console.log(
          dim(
            `  cada ${a.everyMinutes >= 60 ? `${a.everyMinutes / 60} h` : `${a.everyMinutes} min`}${a.onLogin ? ' y al iniciar sesión' : ''}`,
          ),
        )
        for (const cap of a.capabilities) {
          const tool = tools[cap as keyof typeof tools]
          console.log(
            `  ${styleText(tool.risk === 'read' ? 'green' : 'yellow', tool.risk === 'read' ? 'lee   ' : 'cambia')} ${cap} ${dim(`— ${tool.description}`)}`,
          )
        }
      }
      console.log(
        dim(
          `\n  Zonas privadas: ${config.forbidden.join(' · ')} · y cualquier carpeta con ${config.privateMarker}\n`,
        ),
      )
      break
    }

    case 'ejecutar': {
      const name = rest[0]
      if (!name) throw new Error('Uso: nexo ejecutar <agente>')
      const pid = online
        ? (await api<{ pid: number }>(`/ejecutar/${name}`, 'POST')).pid
        : await direct(({ kernel }) => kernel.runNow(name))
      console.log(`Listo: proceso ${pid}. Mira el detalle con: nexo logs ${pid}`)
      break
    }

    case 'servicio': {
      if (online) {
        console.log('El servicio ya está corriendo.')
        break
      }
      const { kernel, database, windows } = await boot(config)
      const token = loadOrCreateToken(PATHS.token)
      // La app de escritorio corre en Windows y lee su copia del token en %LOCALAPPDATA%\Nexo
      if (windows) mirrorToken(token, windowsTokenPath(windows.userProfile))
      if (database.recoveredFrom) {
        console.warn(
          `La base estaba dañada: la aparté en ${database.recoveredFrom} y empecé una nueva.`,
        )
        await kernel.log('db_recovered', { movedTo: database.recoveredFrom })
      }
      const recovered = await kernel.recover()
      if (recovered.length) console.log(`Retomé ${recovered.length} procesos interrumpidos.`)
      const server = serve({
        fetch: createServer(database.db, kernel, { token, port: config.port }).fetch,
        hostname: '127.0.0.1',
        port: config.port,
      })
      console.log(`Nexo en servicio · ${base} · datos en ${PATHS.data}`)
      if (values['iniciar-sesion']) await kernel.login()
      kernel.start()
      const shutdown = async () => {
        console.log('\nApagando Nexo…')
        await kernel.stop()
        server.close()
        await database.close()
        process.exit(0)
      }
      process.on('SIGINT', shutdown)
      process.on('SIGTERM', shutdown)
      break
    }

    case 'token': {
      // Rotar invalida el token anterior; el servicio lo toma al reiniciarse
      loadOrCreateToken(PATHS.token, Boolean(values.rotar))
      console.log(
        values.rotar ? 'Token nuevo generado. Reinicia el servicio.' : `Token en ${PATHS.token}`,
      )
      break
    }

    default:
      console.log(`
${styleText('bold', 'Nexo')} — sistema operativo de agentes para tu PC

  nexo parte [--actualizar]   El reporte del día (con --actualizar, revisan de nuevo)
  nexo ps                     Procesos: qué agentes corrieron y cómo terminaron
  nexo logs [pid]             Bitácora de todo lo que pasó
  nexo agentes                Agentes, sus permisos y las zonas privadas
  nexo ejecutar <agente>      Lanzar un agente ahora
  nexo servicio               Encender el servicio (planificador + API local)
  nexo token [--rotar]        Dónde está el token de la API (o generar uno nuevo)
`)
  }
}

main().catch((error) => {
  console.error(styleText('red', `Error: ${error instanceof Error ? error.message : error}`))
  process.exit(1)
})
