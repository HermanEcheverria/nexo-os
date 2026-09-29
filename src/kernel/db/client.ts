import Sqlite from 'better-sqlite3'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { existsSync, mkdirSync, renameSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import * as schema from './schema'

export type Db = BetterSQLite3Database<typeof schema>
export type Database = {
  db: Db
  close: () => Promise<void>
  /** Si al abrir se encontró la base dañada, adónde se apartó. */
  recoveredFrom?: string
}

const migrationsFolder = fileURLToPath(new URL('../../../drizzle', import.meta.url))

function connect(file: string) {
  const client = new Sqlite(file)
  // WAL: las escrituras van primero a un registro aparte, así un apagado brusco
  // (Windows matando WSL al reiniciar) no deja la base a medias
  client.pragma('journal_mode = WAL')
  client.pragma('synchronous = NORMAL')
  client.pragma('busy_timeout = 5000')
  client.pragma('foreign_keys = ON')
  return client
}

/**
 * Abre la base SQLite (un archivo). Sin `file` queda en memoria (pruebas).
 * Si el archivo está dañado, se aparta con su fecha y se empieza de cero: Nexo
 * siempre arranca, y lo dañado queda para revisarlo.
 */
export async function openDatabase(file?: string): Promise<Database> {
  let client: Sqlite.Database
  let recoveredFrom: string | undefined

  if (!file) {
    client = connect(':memory:')
  } else {
    mkdirSync(dirname(file), { recursive: true })
    try {
      client = connect(file)
      const [check] = client.pragma('quick_check') as { quick_check: string }[]
      if (check?.quick_check !== 'ok') throw new Error(`quick_check: ${check?.quick_check}`)
    } catch {
      recoveredFrom = `${file}.danada-${new Date().toISOString().replace(/[:.]/g, '-')}`
      for (const suffix of ['', '-wal', '-shm']) {
        if (existsSync(file + suffix)) renameSync(file + suffix, recoveredFrom + suffix)
      }
      client = connect(file)
    }
  }

  const db = drizzle(client, { schema })
  migrate(db, { migrationsFolder })
  return { db, close: async () => void client.close(), recoveredFrom }
}
