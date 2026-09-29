import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { count } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'

import { openDatabase } from '../src/kernel/db/client'
import { journal } from '../src/kernel/db/schema'

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('durabilidad de la base', () => {
  it('sobrevive a que maten el proceso a mitad de escrituras (como al reiniciar Windows)', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'nexo-')), 'nexo.db')
    const first = await openDatabase(file)
    await first.close()

    // Un proceso aparte escribe sin parar en la bitácora y se mata con SIGKILL
    const writer = spawn(
      process.execPath,
      [
        '-e',
        `const D = require('better-sqlite3'); const db = new D(${JSON.stringify(file)});
         db.pragma('journal_mode = WAL'); db.pragma('synchronous = NORMAL');
         const put = db.prepare("insert into journal (type, data, at) values ('prueba', '{}', ?)");
         for (;;) put.run(Date.now());`,
      ],
      { stdio: 'ignore' },
    )
    await wait(400)
    writer.kill('SIGKILL')
    await new Promise((r) => writer.once('exit', r))

    const reopened = await openDatabase(file)
    expect(reopened.recoveredFrom).toBeUndefined()
    const [row] = await reopened.db.select({ n: count() }).from(journal)
    expect(row!.n).toBeGreaterThan(0)
    await reopened.close()
  })

  it('si el archivo está dañado, lo aparta y arranca con una base nueva', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'nexo-')), 'nexo.db')
    writeFileSync(file, 'esto no es una base de datos SQLite'.repeat(200))

    const database = await openDatabase(file)
    expect(database.recoveredFrom).toMatch(/nexo\.db\.danada-/)
    expect(existsSync(database.recoveredFrom!)).toBe(true)
    await database.db.insert(journal).values({ type: 'prueba' })
    const [row] = await database.db.select({ n: count() }).from(journal)
    expect(row!.n).toBe(1)
    await database.close()
  })
})
