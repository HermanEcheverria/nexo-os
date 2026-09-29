import { plural } from '../format'
import { defineAgent } from '../kernel/agent'
import type { Tools } from '../tools'

/** Actualizaciones pendientes de Ubuntu y de los programas de Windows. */
export const guardian = defineAgent<Tools>({
  name: 'guardian',
  title: 'Guardián',
  description: 'Revisa actualizaciones pendientes de Ubuntu (apt) y de Windows (winget).',
  capabilities: ['paquetes.apt', 'paquetes.winget'],
  everyMinutes: 12 * 60,
  onLogin: true,
  async run(ctx) {
    const [apt, winget] = await Promise.all([
      ctx.tools.call('paquetes.apt'),
      ctx.tools.call('paquetes.winget'),
    ])

    const security = apt.filter((p) => p.security)
    if (apt.length) {
      await ctx.finding({
        level: security.length ? 'warning' : 'suggestion',
        title: `Ubuntu: ${plural(apt.length, 'actualización', 'actualizaciones')}${security.length ? ` (${security.length} de seguridad)` : ''}`,
        detail:
          apt
            .slice(0, 8)
            .map((p) => p.name)
            .join(', ') + (apt.length > 8 ? '…' : ''),
        data: { packages: apt.map((p) => p.name) },
      })
    }

    if (winget.length) {
      // Primero lo que usas para programar: son las que más te afectan
      const dev = /git|wsl|docker|python|node|postgres|java|jdk|\.net|dotnet|vscode|terminal/i
      const sorted = [...winget].sort((a, b) => Number(dev.test(b.name)) - Number(dev.test(a.name)))
      await ctx.finding({
        level: 'suggestion',
        title: `Windows: ${plural(winget.length, 'programa', 'programas')} con actualización`,
        detail: sorted
          .slice(0, 8)
          .map((p) => `${p.name} ${p.current} → ${p.available}`)
          .join(' · '),
        data: { programs: winget.map((p) => ({ id: p.id, name: p.name, available: p.available })) },
      })
    }
  },
})
