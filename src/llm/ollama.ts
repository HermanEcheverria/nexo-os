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

export function ollamaModel(config: Config['llm'], timeoutMs = 120_000): ChatModel {
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
    const raw = existsSync(WINDOWS_CURL)
      ? await postWithWindowsCurl(url, body, timeoutMs)
      : await (
          await fetch(url, { method: 'POST', body, signal: AbortSignal.timeout(timeoutMs) })
        ).text()
    const parsed = JSON.parse(raw) as { message?: { content?: string }; error?: string }
    if (parsed.error) throw new Error(`Ollama: ${parsed.error}`)
    return parsed.message?.content ?? ''
  }
}
