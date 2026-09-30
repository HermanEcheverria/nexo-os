import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'

import type { Config } from '../config'

export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string }

/** Lo mínimo que el asistente necesita de un modelo: en las pruebas se usa uno falso. */
export type ChatModel = (messages: ChatMessage[], schema: object) => Promise<string>

/**
 * Ollama corre en Windows y escucha solo en el localhost de Windows, que WSL no ve.
 * En vez de exponerlo a la red, se le habla con el curl.exe de Windows (que sí vive
 * del lado de Windows). Fuera de WSL se usa fetch directo.
 */
const WINDOWS_CURL = '/mnt/c/Windows/System32/curl.exe'

function postWithWindowsCurl(url: string, body: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(WINDOWS_CURL, [
      '-s',
      '-S',
      '-m',
      String(Math.ceil(timeoutMs / 1000)),
      '-H',
      'Content-Type: application/json',
      '--data-binary',
      '@-',
      url,
    ])
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    child.on('error', reject)
    child.on('close', (code) =>
      code === 0 ? resolve(out) : reject(new Error(err.trim() || `curl salió con ${code}`)),
    )
    child.stdin.end(body)
  })
}

export class ModelUnavailableError extends Error {
  constructor() {
    super('El modelo local todavía se está iniciando. Intenta de nuevo en unos segundos.')
    this.name = 'ModelUnavailableError'
  }
}

/** Ollama no está escuchando (p. ej. recién iniciada la sesión o actualizándose). */
function isNotRunning(error: unknown): boolean {
  return /Failed to connect|Could not connect|ECONNREFUSED|fetch failed/i.test(String(error))
}

type Deps = {
  post: (url: string, body: string, timeoutMs: number) => Promise<string>
  /** Abre Ollama en Windows si no está corriendo. */
  launch: () => Promise<void>
  sleep: (ms: number) => Promise<void>
}

const defaultDeps: Deps = {
  post: (url, body, timeoutMs) =>
    existsSync(WINDOWS_CURL)
      ? postWithWindowsCurl(url, body, timeoutMs)
      : fetch(url, { method: 'POST', body, signal: AbortSignal.timeout(timeoutMs) }).then((r) =>
          r.text(),
        ),
  launch: async () => {
    const child = spawn(
      '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',
      [
        '-NoProfile',
        '-Command',
        'Start-Process "$env:LOCALAPPDATA\\Programs\\Ollama\\ollama app.exe"',
      ],
      { stdio: 'ignore', detached: true },
    )
    child.on('error', () => {})
    child.unref()
  },
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
}

/** Cuántas veces reintentar mientras Ollama arranca, y cada cuánto. */
const RETRIES = 8
const RETRY_MS = 2500

export function ollamaModel(
  config: Config['llm'],
  timeoutMs = 120_000,
  deps: Deps = defaultDeps,
): ChatModel {
  let lastLaunch = 0
  return async (messages, schema) => {
    const url = `${config.url}/api/chat`
    const body = JSON.stringify({
      model: config.model,
      messages,
      stream: false,
      // Sin "pensar en voz alta": respuestas directas y rápidas
      think: false,
      // El esquema JSON obliga al modelo a responder con esta forma exacta
      format: schema,
      keep_alive: '15m',
      // Temperatura 0: misma pregunta, misma decisión (predecible para un asistente que decide)
      options: { temperature: 0, num_ctx: 8192 },
    })

    // Al iniciar sesión, Nexo puede estar listo antes que Ollama (que además se actualiza
    // solo): se espera un poco, y si no aparece se abre una vez
    let raw: string | undefined
    for (let attempt = 0; raw === undefined; attempt++) {
      try {
        raw = await deps.post(url, body, timeoutMs)
      } catch (error) {
        if (!isNotRunning(error)) throw error
        if (attempt >= RETRIES) throw new ModelUnavailableError()
        if (attempt === 1 && Date.now() - lastLaunch > 60_000) {
          lastLaunch = Date.now()
          await deps.launch()
        }
        await deps.sleep(RETRY_MS)
      }
    }
    const parsed = JSON.parse(raw) as { message?: { content?: string }; error?: string }
    if (parsed.error) throw new Error(`Ollama: ${parsed.error}`)
    return parsed.message?.content ?? ''
  }
}
