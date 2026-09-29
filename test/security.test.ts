import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { defaultConfig } from '../src/config'
import { openDatabase, type Database } from '../src/kernel/db/client'
import { Kernel } from '../src/kernel/kernel'
import { PrivacyGuard } from '../src/kernel/privacy'
import { loadOrCreateToken, windowsTokenPath } from '../src/security'
import { createServer } from '../src/server'

const PORT = 4747
let database: Database
let app: Hono

beforeAll(async () => {
  database = await openDatabase()
  const kernel = new Kernel(database.db, [], {}, defaultConfig(), new PrivacyGuard([], '.p'))
  app = createServer(database.db, kernel, { token: 'secreto', port: PORT })
})
afterAll(() => database.close())

const call = (path: string, headers: Record<string, string> = {}) =>
  app.request(`http://127.0.0.1:${PORT}${path}`, {
    headers: { host: `127.0.0.1:${PORT}`, ...headers },
  })

describe('seguridad de la API local', () => {
  it('rechaza un Host distinto (DNS rebinding)', async () => {
    const res = await call('/estado', { host: `atacante.com:${PORT}` })
    expect(res.status).toBe(403)
  })

  it('el estado es público; todo lo demás pide el token', async () => {
    expect((await call('/estado')).status).toBe(200)
    expect((await call('/parte')).status).toBe(401)
    expect((await call('/parte', { authorization: 'Bearer otro' })).status).toBe(401)
    expect((await call('/parte', { authorization: 'Bearer secreto' })).status).toBe(200)
  })

  it('solo la app de escritorio recibe permiso de CORS', async () => {
    const app1 = await call('/estado', { origin: 'http://tauri.localhost' })
    expect(app1.headers.get('access-control-allow-origin')).toBe('http://tauri.localhost')
    const web = await call('/estado', { origin: 'https://sitio-cualquiera.com' })
    expect(web.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('crea el token con permisos privados y lo reutiliza', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'nexo-')), 'token')
    const first = loadOrCreateToken(path)
    expect(first).toMatch(/^[\w-]{43}$/)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(loadOrCreateToken(path)).toBe(first)
    expect(loadOrCreateToken(path, true)).not.toBe(first)
    expect(readFileSync(path, 'utf8').trim()).not.toBe(first)
  })

  it('traduce la ruta del token de Windows a WSL', () => {
    expect(windowsTokenPath('C:\\Users\\usuario')).toBe(
      '/mnt/c/Users/usuario/AppData/Local/Nexo/token',
    )
  })
})
