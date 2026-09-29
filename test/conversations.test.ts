import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { openDatabase, type Database } from '../src/kernel/db/client'
import { messages } from '../src/kernel/db/schema'
import type { Report } from '../src/kernel/report'
import { Assistant, type AssistantContext } from '../src/llm/assistant'
import { CONDENSE_AFTER, ConversationService, titleFrom, WINDOW } from '../src/llm/conversations'
import type { ChatMessage, ChatModel } from '../src/llm/ollama'

let database: Database
let calls: ChatMessage[][]
let pending: number

/** Modelo falso: contesta según el esquema que le piden y guarda lo que recibió. */
const model: ChatModel = async (msgs, schema) => {
  calls.push(msgs)
  const props = (schema as { properties: Record<string, unknown> }).properties
  if ('resumen' in props) return JSON.stringify({ resumen: 'Preguntó por espacio y proyectos.' })
  return JSON.stringify({
    intencion: 'responder',
    agente: null,
    respuesta: `Respuesta ${calls.length}`,
  })
}

function service() {
  const report: Report = { generatedAt: '', agents: [], items: [], reclaimableBytes: 0 }
  const context = async (): Promise<AssistantContext> => ({
    report,
    pending: Array.from({ length: pending }, (_, i) => ({
      id: i + 1,
      title: 'x',
      bytes: 1,
      agent: 'a',
    })),
    agents: [{ name: 'inventario', title: 'Inventario', description: '' }],
    now: new Date(),
  })
  return new ConversationService(database.db, new Assistant(model, 'Andrés'), {
    context,
    act: async () => null,
    log: async () => {},
  })
}

beforeEach(async () => {
  database = await openDatabase()
  calls = []
  pending = 8
})
afterEach(() => database.close())

describe('conversaciones', () => {
  it('la primera pregunta le pone título y cada respuesta queda guardada', async () => {
    const chats = service()
    const { id } = await chats.create()
    await chats.send(id, '¿Qué ocupa tanto espacio en mi PC?')
    const found = await chats.get(id)
    expect(found!.conversation.title).toBe('¿Qué ocupa tanto espacio en mi PC?')
    expect(found!.messages.map((m) => [m.role, m.content])).toEqual([
      ['user', '¿Qué ocupa tanto espacio en mi PC?'],
      ['assistant', 'Respuesta 1'],
    ])
    expect(titleFrom('a '.repeat(80))).toMatch(/…$/)
    await chats.send(id, '¿y eso?')
    const [listed] = await chats.list()
    expect(listed).toMatchObject({ id, messages: 4 })
  })

  it('el seguimiento recibe lo que ya hablaron, y los datos llegan frescos', async () => {
    const chats = service()
    const { id } = await chats.create()
    await chats.send(id, '¿cuántas propuestas tengo?')
    pending = 5 // aprobaste 3 entre una pregunta y otra
    await chats.send(id, '¿y ahora?')

    const second = calls[1]!
    expect(second.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user'])
    expect(second[1]!.content).toBe('¿cuántas propuestas tengo?')
    expect(second.at(-1)!.content).toMatch(/"propuestas_sin_aprobar_todavia":5/)
  })

  it('solo viajan los últimos mensajes, y lo viejo se condensa en un resumen', async () => {
    const chats = service()
    const { id } = await chats.create()
    // Cada envío suma 2 mensajes (tú y Nexo): así se pasa el límite
    for (let i = 0; i < CONDENSE_AFTER / 2 + 1; i++) await chats.send(id, `pregunta ${i}`)

    const { conversation } = (await chats.get(id))!
    expect(conversation.summary).toBe('Preguntó por espacio y proyectos.')
    expect(conversation.summarizedUpTo).toBeGreaterThan(0)

    calls = []
    await chats.send(id, 'otra')
    const sent = calls[0]!
    expect(sent[1]).toEqual({
      role: 'system',
      content: expect.stringMatching(/Resumen de lo que ya hablaron/),
    })
    const history = sent.filter((m) => m.role !== 'system').slice(0, -1)
    expect(history.length).toBeLessThanOrEqual(WINDOW)
  })

  it('borrar una conversación borra sus mensajes', async () => {
    const chats = service()
    const { id } = await chats.create()
    await chats.send(id, 'hola nexo')
    expect(await chats.remove(id)).toBe(true)
    expect(
      await database.db.select().from(messages).where(eq(messages.conversationId, id)),
    ).toHaveLength(0)
    await expect(chats.send(id, 'sigo aquí')).rejects.toThrow(/No existe/)
  })
})
