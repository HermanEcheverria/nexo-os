import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { z } from 'zod'

const HOME = homedir()
const expand = (p: string) => (p.startsWith('~/') ? join(HOME, p.slice(2)) : p)

export const PATHS = {
  config: join(HOME, '.config', 'nexo', 'config.json'),
  data: join(HOME, '.local', 'share', 'nexo', 'db'),
}

const schema = z.object({
  /** Carpetas donde buscar proyectos con git (en WSL). */
  projectRoots: z.array(z.string()).default(['~/Trabajo']),
  /**
   * Zonas prohibidas: ningún agente las lee, ni siquiera para medir su tamaño.
   * Rutas de WSL (/home/…) o de Windows (C:\Users\…, también %USERPROFILE%, %OneDrive%).
   */
  forbidden: z
    .array(z.string())
    // Por defecto: tus fotos y todo el OneDrive (en esta PC es el de la universidad)
    .default(['%USERPROFILE%\\Pictures', '%OneDrive%']),
  /** Un archivo con este nombre dentro de cualquier carpeta la vuelve privada. */
  privateMarker: z.string().default('.nexo-privado'),
  /** Días sin abrir un archivo de Descargas para sugerir revisarlo. */
  staleDays: z.number().int().min(7).default(90),
  /** Días sin commits para considerar un proyecto inactivo. */
  idleProjectDays: z.number().int().min(7).default(30),
  /** Puerto local del servicio (solo escucha en 127.0.0.1). */
  port: z.number().int().default(4747),
})

export type Config = z.infer<typeof schema>

/** Lee ~/.config/nexo/config.json; si no existe, lo crea con los valores por defecto. */
export function loadConfig(path = PATHS.config): Config {
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${JSON.stringify(schema.parse({}), null, 2)}\n`)
  }
  const parsed = schema.parse(JSON.parse(readFileSync(path, 'utf8')))
  return { ...parsed, projectRoots: parsed.projectRoots.map(expand) }
}

export function defaultConfig(overrides: Partial<Config> = {}): Config {
  return { ...schema.parse({}), ...overrides }
}
