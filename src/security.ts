import { randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import type { MiddlewareHandler } from 'hono'

/**
 * Token secreto entre el servicio y sus clientes (el comando nexo y la app de escritorio).
 * Una API en localhost sin token la puede llamar cualquier página web que visites
 * (DNS rebinding); con token y validación del Host, solo quien lee este archivo.
 */
export function loadOrCreateToken(path: string, rotate = false): string {
  if (!rotate && existsSync(path)) return readFileSync(path, 'utf8').trim()
  const token = randomBytes(32).toString('base64url')
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${token}\n`, { mode: 0o600 })
  chmodSync(path, 0o600)
  return token
}

/** Copia del token para la app de Windows: %LOCALAPPDATA%\Nexo\token (dentro de tu perfil). */
export function windowsTokenPath(userProfile: string): string {
  const drive = userProfile[0]!.toLowerCase()
  const rest = userProfile.slice(2).replace(/\\/g, '/')
  return join(`/mnt/${drive}${rest}`, 'AppData', 'Local', 'Nexo', 'token')
}

export function mirrorToken(token: string, path: string) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${token}\n`)
}

function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

/**
 * Solo acepta pedidos dirigidos literalmente a 127.0.0.1 o localhost. Un ataque de
 * DNS rebinding llega con el Host del dominio del atacante, y aquí se corta.
 */
export function hostGuard(port: number): MiddlewareHandler {
  const allowed = new Set([`127.0.0.1:${port}`, `localhost:${port}`])
  return async (c, next) => {
    if (!allowed.has(c.req.header('host') ?? '')) return c.json({ error: 'Host no permitido' }, 403)
    await next()
  }
}

export function tokenGuard(token: string): MiddlewareHandler {
  return async (c, next) => {
    const header = c.req.header('authorization') ?? ''
    const given = header.startsWith('Bearer ') ? header.slice(7) : ''
    if (!given || !sameSecret(given, token)) return c.json({ error: 'No autorizado' }, 401)
    await next()
  }
}

/**
 * Orígenes de la app de escritorio. Tauri 2 en Windows sirve la interfaz desde
 * http://tauri.localhost; en desarrollo, desde el servidor de Vite.
 */
export const APP_ORIGINS = [
  'http://tauri.localhost',
  'https://tauri.localhost',
  'http://localhost:1420',
]
