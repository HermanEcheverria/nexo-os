import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** Variables de Windows que se permiten en las rutas prohibidas. */
export type WindowsEnv = { USERPROFILE?: string; OneDrive?: string }

/**
 * Lleva cualquier ruta a una forma comparable:
 * /mnt/c/Users/x → c:\users\x · C:/Users/x → c:\users\x · rutas de WSL en minúsculas no.
 */
export function normalizePath(path: string, env: WindowsEnv = {}): string {
  let p = path.replace(/%(USERPROFILE|OneDrive)%/gi, (_, name: string) => {
    const key = name.toLowerCase() === 'onedrive' ? 'OneDrive' : 'USERPROFILE'
    return env[key] ?? `%${name}%`
  })
  const mnt = p.match(/^\/mnt\/([a-z])(\/.*)?$/i)
  if (mnt) p = `${mnt[1]}:${mnt[2] ?? ''}`
  if (/^[a-z]:/i.test(p)) return p.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
  return p.replace(/\/+$/, '')
}

/**
 * Guardián de privacidad: lo consultan las herramientas, no los agentes. Así ningún
 * agente puede "olvidarse" de respetar una zona prohibida.
 */
export class PrivacyGuard {
  private readonly zones: string[]

  constructor(
    forbidden: string[],
    readonly marker: string,
    readonly env: WindowsEnv = {},
  ) {
    // Una zona con una variable sin resolver (p. ej. sin OneDrive) no protege nada: se descarta
    this.zones = forbidden.map((z) => normalizePath(z, env)).filter((z) => !z.includes('%'))
  }

  /** Zonas ya resueltas, para pasarlas a los escaneos de Windows. */
  get windowsZones(): string[] {
    return this.zones.filter((z) => /^[a-z]:/.test(z))
  }

  isForbidden(path: string): boolean {
    const p = normalizePath(path, this.env)
    const sep = /^[a-z]:/.test(p) ? '\\' : '/'
    if (this.zones.some((z) => p === z || p.startsWith(z + sep))) return true
    // El archivo marcador solo se puede revisar desde WSL en rutas locales
    return !/^[a-z]:/.test(p) && existsSync(join(path, this.marker))
  }
}
