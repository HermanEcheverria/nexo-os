import { bytes } from '../format'
import { defineAgent } from '../kernel/agent'
import type { Tools } from '../tools'

/** Cachés y temporales: lo que se puede borrar sin perder nada porque se regenera solo. */
export const limpiador = defineAgent<Tools>({
  name: 'limpiador',
  title: 'Limpiador',
  description: 'Mide cachés y temporales que crecen solos y se pueden regenerar.',
  capabilities: ['sistema.caches'],
  everyMinutes: 24 * 60,
  onLogin: true,
  async run(ctx) {
    const caches = await ctx.tools.call('sistema.caches')
    // Menos de 100 MB no vale la pena mencionarlo
    const worth = caches.filter((c) => c.bytes >= 100 * 1024 ** 2).sort((a, b) => b.bytes - a.bytes)

    const regenerable = worth.filter((c) => c.regenerable)
    const total = regenerable.reduce((s, c) => s + c.bytes, 0)
    if (regenerable.length) {
      await ctx.finding({
        level: 'suggestion',
        title: `${bytes(total)} en cachés y temporales que se regeneran solos`,
        detail: regenerable.map((c) => `${c.label}: ${bytes(c.bytes)}`).join(' · '),
        bytes: total,
        data: { caches: regenerable.map(({ id, label, bytes }) => ({ id, label, bytes })) },
      })
    }

    // Lo que no se regenera (p. ej. las imágenes de Docker) solo se informa
    for (const c of worth.filter((c) => !c.regenerable)) {
      await ctx.finding({
        level: 'info',
        title: `${c.label}: ${bytes(c.bytes)}`,
        detail: 'No es una caché: revisa desde el programa si todavía lo usas.',
        data: { id: c.id },
      })
    }
  },
})
