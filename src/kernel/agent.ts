import type { Config } from '../config'
import type { Registry, Toolbox } from './tools'

export type FindingInput = {
  level: 'info' | 'suggestion' | 'warning'
  title: string
  detail?: string
  /** Espacio que se liberaría si se actúa sobre esto. */
  bytes?: number
  data?: Record<string, unknown>
}

/** Lo que el núcleo le da a un agente mientras corre. */
export type AgentContext<R extends Registry> = {
  pid: number
  /** Configuración de solo lectura (umbrales, carpetas de proyectos…). */
  config: Readonly<Config>
  tools: Toolbox<R>
  finding(finding: FindingInput): Promise<void>
  memory: {
    get<T>(key: string): Promise<T | undefined>
    set(key: string, value: unknown): Promise<void>
  }
  log(message: string, data?: Record<string, unknown>): Promise<void>
  signal: AbortSignal
}

/**
 * Manifiesto de un agente: quién es, qué herramientas puede usar (sus capacidades)
 * y cada cuánto trabaja. Es el equivalente a un programa instalado en el sistema.
 */
export type Agent<R extends Registry = Registry> = {
  name: string
  title: string
  description: string
  capabilities: readonly (keyof R & string)[]
  /** Cada cuántos minutos se despierta solo. */
  everyMinutes: number
  /** Si corre al iniciar sesión en Windows. */
  onLogin: boolean
  /** Tiempo máximo por ejecución antes de detenerlo. */
  timeoutMs?: number
  run(ctx: AgentContext<R>): Promise<void>
}

export function defineAgent<R extends Registry>(agent: Agent<R>): Agent<R> {
  return agent
}
