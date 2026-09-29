import { bytes, daysSince, plural } from '../format'
import { defineAgent } from '../kernel/agent'
import type { Tools } from '../tools'

type Snapshot = Record<string, number>

/** Solo se propone mover lo que pesa al menos esto (lo pequeño no vale tu tiempo). */
const PROPOSE_MIN_BYTES = 100 * 1024 ** 2

const largestFirst = <T extends { bytes: number }>(items: T[]) =>
  [...items].sort((a, b) => b.bytes - a.bytes)

/** Discos y Descargas: qué es nuevo, qué creció y qué no se abre hace tiempo. */
export const inventario = defineAgent<Tools>({
  name: 'inventario',
  title: 'Inventario',
  description: 'Vigila el espacio en disco y lo que se acumula en Descargas.',
  capabilities: ['sistema.discos', 'windows.descargas', 'archivos.cuarentena'],
  everyMinutes: 6 * 60,
  onLogin: true,
  async run(ctx) {
    for (const disk of await ctx.tools.call('sistema.discos')) {
      const used = 1 - disk.freeBytes / disk.totalBytes
      await ctx.finding({
        level: used > 0.85 ? 'warning' : 'info',
        title: `Disco ${disk.name} · ${bytes(disk.freeBytes)} libres de ${bytes(disk.totalBytes)}`,
        detail: `${Math.round(used * 100)} % usado`,
        data: { disk: disk.name, used },
      })
    }

    const downloads = await ctx.tools.call('windows.descargas')
    if (downloads.private) return
    const items = downloads.items
    const total = items.reduce((sum, i) => sum + i.bytes, 0)

    // Comparación con la foto anterior: qué llegó desde la última revisión
    const previous = await ctx.memory.get<Snapshot>('descargas')
    const current: Snapshot = Object.fromEntries(items.map((i) => [i.name, i.bytes]))
    await ctx.memory.set('descargas', current)
    const fresh = previous ? items.filter((i) => !(i.name in previous)) : []
    const freshBytes = fresh.reduce((s, i) => s + i.bytes, 0)

    await ctx.finding({
      level: 'info',
      title: `Descargas: ${bytes(total)} en ${plural(items.length, 'elemento', 'elementos')}`,
      detail: previous
        ? fresh.length
          ? `${plural(fresh.length, 'nuevo', 'nuevos')} desde la última revisión (${bytes(freshBytes)})`
          : 'Nada nuevo desde la última revisión'
        : 'Primera revisión: a partir de ahora te diré qué llega',
      data: { fresh: fresh.map((i) => i.name).slice(0, 20) },
    })

    // Windows no siempre actualiza la fecha de acceso: se exige que ambas fechas sean viejas
    const days = ctx.config.staleDays
    const old = (iso: string) => daysSince(iso) >= days
    const stale = items.filter((i) => old(i.modified) && old(i.accessed))
    if (stale.length) {
      const staleBytes = stale.reduce((s, i) => s + i.bytes, 0)
      const largest = largestFirst(stale).slice(0, 5)
      await ctx.finding({
        level: 'suggestion',
        title: `${plural(stale.length, 'cosa', 'cosas')} en Descargas sin usar hace más de ${days} días`,
        detail: `Las más pesadas: ${largest.map((i) => `${i.name} (${bytes(i.bytes)})`).join(', ')}`,
        bytes: staleBytes,
        data: {
          items: largest.map((i) => ({ name: i.name, bytes: i.bytes, modified: i.modified })),
        },
      })

      // Propuestas concretas: lo más pesado, uno por uno, para que decidas cada cosa
      const big = largestFirst(stale)
        .filter((i) => i.bytes >= PROPOSE_MIN_BYTES)
        .slice(0, 10)
      for (const item of big) {
        await ctx.propose({
          tool: 'archivos.cuarentena',
          input: { paths: [`${downloads.path}\\${item.name}`] },
          title: `Mover a cuarentena «${item.name}»`,
          detail: `En Descargas, sin abrir desde ${new Date(item.accessed).toLocaleDateString('es-GT', { day: 'numeric', month: 'long', year: 'numeric' })}. Podrás deshacerlo durante 30 días.`,
          bytes: item.bytes,
        })
      }
    }
  },
})
