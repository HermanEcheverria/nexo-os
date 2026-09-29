import {
  bigint,
  bigserial,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from 'drizzle-orm/pg-core'

/**
 * Tabla de procesos: cada ejecución de un agente es un proceso con su ciclo de vida.
 * listo → ejecutando → terminado | fallido | interrumpido | detenido
 */
export const processes = pgTable(
  'processes',
  {
    pid: bigserial('pid', { mode: 'number' }).primaryKey(),
    agent: text('agent').notNull(),
    state: text('state', {
      enum: ['ready', 'running', 'done', 'failed', 'interrupted', 'killed'],
    }).notNull(),
    /** Qué lo despertó: horario, inicio de sesión, una orden tuya o un reintento. */
    trigger: text('trigger', { enum: ['schedule', 'login', 'manual', 'retry'] }).notNull(),
    attempt: integer('attempt').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    error: text('error'),
  },
  (t) => [index('processes_agent_idx').on(t.agent, t.createdAt)],
)

/** Bitácora de solo escritura: todo lo que pasa en el sistema, en orden. */
export const journal = pgTable(
  'journal',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
    pid: bigint('pid', { mode: 'number' }),
    agent: text('agent'),
    type: text('type').notNull(),
    data: jsonb('data').$type<Record<string, unknown>>().notNull().default({}),
  },
  (t) => [index('journal_pid_idx').on(t.pid), index('journal_at_idx').on(t.at)],
)

/** Lo que cada agente encontró en su última revisión; con esto se arma el parte. */
export const findings = pgTable(
  'findings',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    pid: bigint('pid', { mode: 'number' }).notNull(),
    agent: text('agent').notNull(),
    /** info: dato · sugerencia: algo que conviene hacer · alerta: requiere atención */
    level: text('level', { enum: ['info', 'suggestion', 'warning'] }).notNull(),
    title: text('title').notNull(),
    detail: text('detail'),
    /** Espacio que se podría liberar, si aplica. */
    bytes: bigint('bytes', { mode: 'number' }),
    data: jsonb('data').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('findings_pid_idx').on(t.pid)],
)

/** Memoria de largo plazo de cada agente (p. ej. la foto de Descargas de ayer). */
export const memory = pgTable(
  'memory',
  {
    agent: text('agent').notNull(),
    key: text('key').notNull(),
    value: jsonb('value').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.agent, t.key] })],
)
