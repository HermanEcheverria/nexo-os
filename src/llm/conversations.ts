import { and, asc, desc, eq, gt, sql } from 'drizzle-orm'

import type { Db } from '../kernel/db/client'
import { conversations, messages } from '../kernel/db/schema'
import type { Answer, Assistant, AssistantContext } from './assistant'
import type { ChatMessage } from './ollama'

/** Mensajes recientes que el modelo recibe completos (la "ventana deslizante"). */
export const WINDOW = 6
/** Cuando hay más mensajes sin resumir que esto, los viejos se condensan en el resumen. */
export const CONDENSE_AFTER = 12

export type Conversation = typeof conversations.$inferSelect
export type Message = typeof messages.$inferSelect

type Hooks = {
  context: () => Promise<AssistantContext>
  /** Qué hacer con la intención (p. ej. lanzar un agente). Devuelve el pid si lanzó algo. */
  act: (answer: Answer) => Promise<number | null>
  log: (type: string, data: Record<string, unknown>) => Promise<void>
}

/** Título a partir de la primera pregunta: corto, sin llamar al modelo. */
export function titleFrom(question: string): string {
  const clean = question.replace(/\s+/g, ' ').trim()
  return clean.length <= 60 ? clean : `${clean.slice(0, 57).replace(/\s+\S*$/, '')}…`
}

/**
 * Historial de conversaciones con el asistente. Todo queda en la base local: nada sale
 * de la PC. Para que un modelo pequeño no se pierda, recibe el resumen de lo viejo más
 * los últimos mensajes, y los datos de la PC siempre frescos.
 */
export class ConversationService {
  constructor(
    private readonly db: Db,
    private readonly assistant: Assistant,
    private readonly hooks: Hooks,
  ) {}

  async list() {
    return this.db
      .select({
        id: conversations.id,
        title: conversations.title,
        updatedAt: conversations.updatedAt,
        // Nombre de tabla explícito: sin él, "id" dentro de la subconsulta sería el del mensaje
        messages: sql<number>`(select count(*) from messages m where m.conversation_id = "conversations"."id")`,
      })
      .from(conversations)
      .orderBy(desc(conversations.updatedAt), desc(conversations.id))
  }

  async create(title = 'Nueva conversación'): Promise<Conversation> {
    const [row] = await this.db.insert(conversations).values({ title }).returning()
    return row!
  }

  async get(id: number): Promise<{ conversation: Conversation; messages: Message[] } | null> {
    const [conversation] = await this.db
      .select()
      .from(conversations)
      .where(eq(conversations.id, id))
    if (!conversation) return null
    const rows = await this.db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, id))
      .orderBy(asc(messages.id))
    return { conversation, messages: rows }
  }

  async remove(id: number): Promise<boolean> {
    const deleted = await this.db
      .delete(conversations)
      .where(eq(conversations.id, id))
      .returning({ id: conversations.id })
    return deleted.length > 0
  }

  /** Agrega tu mensaje, obtiene la respuesta y guarda ambos. */
  async send(id: number, text: string): Promise<Message> {
    const found = await this.get(id)
    if (!found) throw new Error(`No existe la conversación ${id}`)
    const { conversation } = found
    const history = found.messages.filter((m) => m.id > conversation.summarizedUpTo)

    await this.db.insert(messages).values({ conversationId: id, role: 'user', content: text })
    // La primera pregunta le pone nombre a la conversación
    if (found.messages.length === 0) {
      await this.db
        .update(conversations)
        .set({ title: titleFrom(text) })
        .where(eq(conversations.id, id))
    }

    await this.hooks.log('question', { conversation: id, texto: text })
    const answer = await this.assistant.ask(text, await this.hooks.context(), {
      summary: conversation.summary,
      history: history
        .slice(-WINDOW)
        .map((m): ChatMessage => ({ role: m.role, content: m.content })),
    })
    const pid = await this.hooks.act(answer)
    await this.hooks.log('answer', {
      conversation: id,
      intencion: answer.intencion,
      agente: answer.agente,
    })

    const [reply] = await this.db
      .insert(messages)
      .values({
        conversationId: id,
        role: 'assistant',
        content: answer.respuesta,
        intent: answer.intencion,
        agent: answer.agente,
        pid,
      })
      .returning()
    await this.db
      .update(conversations)
      .set({ updatedAt: new Date() })
      .where(eq(conversations.id, id))

    await this.condenseIfNeeded(id)
    return reply!
  }

  /** Si hay demasiados mensajes sin resumir, los más viejos pasan al resumen. */
  private async condenseIfNeeded(id: number) {
    const [conversation] = await this.db
      .select()
      .from(conversations)
      .where(eq(conversations.id, id))
    const pending = await this.db
      .select()
      .from(messages)
      .where(and(eq(messages.conversationId, id), gt(messages.id, conversation!.summarizedUpTo)))
      .orderBy(asc(messages.id))
    if (pending.length <= CONDENSE_AFTER) return

    const old = pending.slice(0, pending.length - WINDOW)
    try {
      const summary = await this.assistant.condense(
        conversation!.summary,
        old.map((m) => ({ role: m.role, content: m.content })),
      )
      await this.db
        .update(conversations)
        .set({ summary, summarizedUpTo: old.at(-1)!.id })
        .where(eq(conversations.id, id))
      await this.hooks.log('conversation_condensed', { conversation: id, messages: old.length })
    } catch (error) {
      // Sin resumen no se pierde nada: la ventana sigue funcionando
      await this.hooks.log('condense_failed', { conversation: id, error: String(error) })
    }
  }
}
