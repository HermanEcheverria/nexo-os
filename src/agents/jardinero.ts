import { bytes, daysSince, plural } from '../format'
import { defineAgent } from '../kernel/agent'
import type { Tools } from '../tools'

/** Tus proyectos: cambios sin guardar en git, commits sin subir y dependencias olvidadas. */
export const jardinero = defineAgent<Tools>({
  name: 'jardinero',
  title: 'Jardinero',
  description: 'Cuida tus proyectos: cambios sin commit, commits sin subir, proyectos inactivos.',
  capabilities: ['proyectos.revisar'],
  everyMinutes: 60,
  onLogin: true,
  async run(ctx) {
    const repos = await ctx.tools.call('proyectos.revisar')

    for (const r of repos.filter((r) => r.dirtyFiles > 0)) {
      await ctx.finding({
        level: 'warning',
        title: `${r.name}: ${plural(r.dirtyFiles, 'archivo', 'archivos')} sin commit`,
        detail: `En la rama ${r.branch || '(sin rama)'}. Si la PC falla, ese trabajo no está respaldado.`,
        data: { repo: r.path },
      })
    }
    for (const r of repos.filter((r) => (r.unpushed ?? 0) > 0)) {
      await ctx.finding({
        level: 'warning',
        title: `${r.name}: ${plural(r.unpushed!, 'commit', 'commits')} sin subir`,
        detail: 'Están solo en esta PC.',
        data: { repo: r.path },
      })
    }

    // Dependencias de proyectos que no se tocan hace rato: se reinstalan con un comando
    const idle = repos.filter(
      (r) =>
        r.lastCommit &&
        daysSince(r.lastCommit) >= ctx.config.idleProjectDays &&
        r.nodeModulesBytes > 0,
    )
    if (idle.length) {
      const total = idle.reduce((s, r) => s + r.nodeModulesBytes, 0)
      await ctx.finding({
        level: 'suggestion',
        title: `${bytes(total)} en dependencias de proyectos inactivos`,
        detail: idle
          .map(
            (r) =>
              `${r.name} (${daysSince(r.lastCommit!)} días sin commits, ${bytes(r.nodeModulesBytes)})`,
          )
          .join(' · '),
        bytes: total,
        data: { repos: idle.map((r) => r.path) },
      })
    }

    const clean = repos.filter((r) => r.dirtyFiles === 0 && !r.unpushed).length
    await ctx.finding({
      level: 'info',
      title: `Proyectos: ${clean} de ${repos.length} al día`,
      detail: repos
        .map(
          (r) =>
            `${r.name} (${r.lastCommit ? `último commit hace ${daysSince(r.lastCommit)} d` : 'sin commits'})`,
        )
        .join(' · '),
    })
  },
})
