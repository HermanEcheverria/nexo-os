import { PGlite } from '@electric-sql/pglite'
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core'
import { drizzle } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import * as schema from './schema'

export type Db = PgDatabase<PgQueryResultHKT, typeof schema>
export type Database = { db: Db; close: () => Promise<void> }

const migrationsFolder = fileURLToPath(new URL('../../../drizzle', import.meta.url))

/**
 * Base embebida (PGlite): Nexo no necesita Docker ni un servidor de base de datos.
 * Sin `dir` queda en memoria (pruebas).
 */
export async function openDatabase(dir?: string): Promise<Database> {
  if (dir) mkdirSync(dir, { recursive: true })
  const client = dir ? new PGlite(dir) : new PGlite()
  const db = drizzle(client, { schema })
  await migrate(db, { migrationsFolder })
  return { db: db as unknown as Db, close: () => client.close() }
}
