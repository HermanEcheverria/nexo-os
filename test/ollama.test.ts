import { describe, expect, it, vi } from 'vitest'

import { defaultConfig } from '../src/config'
import { ModelUnavailableError, ollamaModel } from '../src/llm/ollama'

const refused = () =>
  Promise.reject(
    new Error('curl: (7) Failed to connect to 127.0.0.1:11434: Could not connect to server'),
  )
const reply = JSON.stringify({ message: { content: '{"ok":true}' } })

describe('cliente de Ollama', () => {
  it('si Ollama todavía no arranca, espera, lo abre una vez y reintenta', async () => {
    const post = vi
      .fn()
      .mockImplementationOnce(refused)
      .mockImplementationOnce(refused)
      .mockResolvedValue(reply)
    const launch = vi.fn(async () => {})
    const model = ollamaModel(defaultConfig().llm, 1000, { post, launch, sleep: async () => {} })

    expect(await model([], {})).toBe('{"ok":true}')
    expect(post).toHaveBeenCalledTimes(3)
    expect(launch).toHaveBeenCalledTimes(1)
  })

  it('si nunca aparece, avisa que se está iniciando (no un error genérico)', async () => {
    const model = ollamaModel(defaultConfig().llm, 1000, {
      post: refused,
      launch: async () => {},
      sleep: async () => {},
    })
    await expect(model([], {})).rejects.toBeInstanceOf(ModelUnavailableError)
  })

  it('otros errores no se reintentan', async () => {
    const post = vi.fn(() => Promise.reject(new Error('respuesta inválida')))
    const model = ollamaModel(defaultConfig().llm, 1000, {
      post,
      launch: async () => {},
      sleep: async () => {},
    })
    await expect(model([], {})).rejects.toThrow('respuesta inválida')
    expect(post).toHaveBeenCalledTimes(1)
  })
})
