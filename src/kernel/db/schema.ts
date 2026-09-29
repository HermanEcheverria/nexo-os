import { sql } from 'drizzle-orm'
import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core'

/** Fechas como milisegundos (Date en TypeScript). */
const time = (name: string) => integer(name, { mode: 'timestamp_ms' })
const now = sql`(cast(unixepoch('subsec') * 1000 as integer))`

/**
 * Tabla de procesos: cada ejecución de un agente es un proceso con su ciclo de vida.
 * listo → ejecutando → terminado | fallido | interrumpido | detenido
 */
export const processes = sqliteTable(
  'processes',
  {
    pid: integer('pid').primaryKey({ autoIncrement: true }),
    agent: text('agent').notNull(),
    state: text('state', {
      enum: ['ready', 'running', 'done', 'failed', 'interrupted', 'killed'],
    }).notNull(),
    /** Qué lo despertó: horario, inicio de sesión, una orden tuya o un reintento. */
    trigger: text('trigger', { enum: ['schedule', 'login', 'manual', 'retry'] }).notNull(),
    attempt: integer('attempt').notNull().default(1),
    createdAt: time('created_at').notNull().default(now),
    startedAt: time('started_at'),
    finishedAt: time('finished_at'),
    error: text('error'),
  },
  (t) => [index('processes_agent_idx').on(t.agent, t.createdAt)],
)

/** Bitácora de solo escritura: todo lo que pasa en el sistema, en orden. */
export const journal = sqliteTable(
  'journal',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    at: time('at').notNull().default(now),
    pid: integer('pid'),
    agent: text('agent'),
    type: text('type').notNull(),
    data: text('data', { mode: 'json' }).$type<Record<string, unknown>>().notNull().default({}),
  },
  (t) => [index('journal_pid_idx').on(t.pid), index('journal_at_idx').on(t.at)],
)

/** Lo que cada agente encontró en su última revisión; con esto se arma el parte. */
export const findings = sqliteTable(
  'findings',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    pid: integer('pid').notNull(),
    agent: text('agent').notNull(),
    /** info: dato · suggestion: algo que conviene hacer · warning: requiere atención */
    level: text('level', { enum: ['info', 'suggestion', 'warning'] }).notNull(),
    title: text('title').notNull(),
    detail: text('detail'),
    /** Espacio que se podría liberar, si aplica. */
    bytes: integer('bytes'),
    data: text('data', { mode: 'json' }).$type<Record<string, unknown>>(),
    createdAt: time('created_at').notNull().default(now),
  },
  (t) => [index('findings_pid_idx').on(t.pid)],
)

/** Memoria de largo plazo de cada agente (p. ej. la foto de Descargas de ayer). */
export const memory = sqliteTable(
  'memory',
  {
    agent: text('agent').notNull(),
    key: text('key').notNull(),
    value: text('value', { mode: 'json' }).notNull(),
    updatedAt: time('updated_at').notNull().default(now),
  },
  (t) => [primaryKey({ columns: [t.agent, t.key] })],
)

/**
 * Acciones que proponen los agentes y que solo se ejecutan si las apruebas.
 * pendiente → aprobada y ejecutada | rechazada | fallida → deshecha | purgada
 */
export const actions = sqliteTable(
  'actions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    pid: integer('pid').notNull(),
    agent: text('agent').notNull(),
    /** Herramienta que cambiará la PC (riesgo write o external). */
    tool: text('tool').notNull(),
    /** Entrada exacta que apruebas: se ejecuta tal cual, sin que el agente la cambie. */
    input: text('input', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
    /** Huella de agente + herramienta + entrada, para no proponer lo mismo dos veces. */
    fingerprint: text('fingerprint').notNull(),
    title: text('title').notNull(),
    detail: text('detail'),
    bytes: integer('bytes'),
    state: text('state', {
      enum: ['pending', 'running', 'done', 'failed', 'rejected', 'undone', 'purged'],
    }).notNull(),
    createdAt: time('created_at').notNull().default(now),
    decidedAt: time('decided_at'),
    executedAt: time('executed_at'),
    result: text('result', { mode: 'json' }).$type<unknown>(),
    error: text('error'),
  },
  (t) => [
    index('actions_state_idx').on(t.state),
    index('actions_fingerprint_idx').on(t.fingerprint),
  ],
)
