import type { z } from 'zod'

import type { Config } from '../config'
import type { PrivacyGuard } from './privacy'

/**
 * Nivel de riesgo de una herramienta (las "llamadas al sistema" de Nexo):
 * - read: solo mira. Libre.
 * - write: cambia algo en tu PC. Requiere tu aprobación.
 * - external: sale de tu PC (enviar un mensaje, publicar). Requiere tu aprobación.
 */
export type Risk = 'read' | 'write' | 'external'

export type ToolEnv = { config: Config; privacy: PrivacyGuard; signal: AbortSignal }

export type Tool<I extends z.ZodType = z.ZodType, O = unknown> = {
  name: string
  risk: Risk
  description: string
  input: I
  run(input: z.output<I>, env: ToolEnv): Promise<O>
}

export type Registry = Record<string, Tool>

export function defineTool<I extends z.ZodType, O>(tool: Tool<I, O>): Tool<I, O> {
  return tool
}

export class CapabilityError extends Error {
  constructor(
    readonly tool: string,
    readonly reason: 'not-granted' | 'needs-approval' | 'unknown',
  ) {
    const messages = {
      'not-granted': `no tiene permiso para usar "${tool}"`,
      'needs-approval': `"${tool}" cambia tu PC y necesita tu aprobación`,
      unknown: `la herramienta "${tool}" no existe`,
    }
    super(messages[reason])
    this.name = 'CapabilityError'
  }
}

export type ToolCallEvent =
  | { type: 'tool_call'; tool: string; ms: number }
  | { type: 'tool_denied'; tool: string; reason: CapabilityError['reason'] }
  | { type: 'tool_error'; tool: string; error: string }

/** Lo que un agente ve: solo puede llamar a las herramientas que declaró en su manifiesto. */
export type Toolbox<R extends Registry> = {
  call<N extends keyof R & string>(
    name: N,
    input?: z.input<R[N]['input']>,
  ): Promise<Awaited<ReturnType<R[N]['run']>>>
}

export function createToolbox<R extends Registry>(
  registry: R,
  granted: readonly string[],
  env: ToolEnv,
  onEvent: (event: ToolCallEvent) => Promise<void>,
): Toolbox<R> {
  return {
    async call(name, input) {
      const tool = registry[name]
      const deny = async (reason: CapabilityError['reason']) => {
        await onEvent({ type: 'tool_denied', tool: name, reason })
        throw new CapabilityError(name, reason)
      }
      if (!tool) return deny('unknown')
      if (!granted.includes(name)) return deny('not-granted')
      // Cambiar la PC pasa por la cola de aprobaciones (semana 3); por ahora se niega
      if (tool.risk !== 'read') return deny('needs-approval')

      const started = performance.now()
      try {
        const parsed = tool.input.parse(input ?? {})
        const result = await tool.run(parsed, env)
        await onEvent({
          type: 'tool_call',
          tool: name,
          ms: Math.round(performance.now() - started),
        })
        return result as never
      } catch (error) {
        await onEvent({ type: 'tool_error', tool: name, error: String(error) })
        throw error
      }
    },
  }
}
