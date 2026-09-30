import { plural } from '../format'
import { defineAgent } from '../kernel/agent'
import type { Tools } from '../tools'

/** Seguridad básica de la PC: antivirus, firewall, puertos expuestos, inicio y secretos. */
export const centinela = defineAgent<Tools>({
  name: 'centinela',
  title: 'Centinela',
  description:
    'Vigila antivirus, firewall, puertos abiertos a la red, programas de inicio y secretos en tus repositorios.',
  capabilities: [
    'seguridad.antivirus',
    'seguridad.puertos',
    'seguridad.inicio',
    'seguridad.secretos',
  ],
  everyMinutes: 12 * 60,
  onLogin: true,
  async run(ctx) {
    const { antivirus, firewall } = await ctx.tools.call('seguridad.antivirus')
    const active = antivirus.filter((a) => a.enabled)
    if (active.length === 0) {
      await ctx.finding({
        level: 'warning',
        title: 'No hay ningún antivirus activo',
        detail: `Registrados: ${antivirus.map((a) => a.name).join(', ') || 'ninguno'}. Activa Windows Defender o tu antivirus.`,
      })
    } else {
      const outdated = active.filter((a) => !a.upToDate)
      await ctx.finding({
        level: outdated.length ? 'warning' : 'info',
        title: `Antivirus: ${active.map((a) => a.name).join(', ')}${outdated.length ? ' con firmas desactualizadas' : ' activo y al día'}`,
        // Con otro antivirus, Defender queda en pausa: es normal y se aclara para no alarmar
        detail: antivirus.some((a) => !a.enabled && /defender/i.test(a.name))
          ? 'Windows Defender está en pausa porque otro antivirus lo reemplaza; es lo normal.'
          : undefined,
      })
    }

    const off = firewall.filter((f) => !f.enabled)
    await ctx.finding({
      level: off.length ? 'warning' : 'info',
      title: off.length
        ? `Firewall apagado en: ${off.map((f) => f.name).join(', ')}`
        : 'Firewall activo en todas las redes',
    })

    const ports = await ctx.tools.call('seguridad.puertos')
    for (const p of ports.filter((p) => p.risk)) {
      await ctx.finding({
        level: 'warning',
        title: `${p.risk} acepta conexiones desde toda la red (puerto ${p.port})`,
        detail: `Proceso: ${p.process}. Si solo lo usas en esta PC, configúralo para escuchar en 127.0.0.1; en una red pública cualquiera podría intentar entrar.`,
        data: { port: p.port, process: p.process },
      })
    }
    await ctx.finding({
      level: 'info',
      title: `${plural(ports.length, 'puerto abierto', 'puertos abiertos')} a la red`,
      detail: ports.map((p) => `${p.port} (${p.process})`).join(' · '),
    })

    const startup = await ctx.tools.call('seguridad.inicio')
    await ctx.finding({
      level: startup.length > 15 ? 'suggestion' : 'info',
      title: `${plural(startup.length, 'programa arranca', 'programas arrancan')} con Windows`,
      detail:
        (startup.length > 15
          ? 'Son bastantes: los que no uses a diario hacen más lento el inicio. '
          : '') + startup.map((s) => s.name).join(', '),
    })

    const secrets = await ctx.tools.call('seguridad.secretos')
    if (secrets.length) {
      await ctx.finding({
        level: 'warning',
        title: `${plural(secrets.length, 'posible secreto', 'posibles secretos')} en tus repositorios`,
        detail: `${secrets
          .slice(0, 8)
          .map((s) => `${s.repo}/${s.file}${s.line ? `:${s.line}` : ''} (${s.type})`)
          .join(' · ')}. Si ya se subió a GitHub, cámbialo: borrarlo del repositorio no basta.`,
      })
    } else {
      await ctx.finding({ level: 'info', title: 'Sin secretos versionados en tus repositorios' })
    }
  },
})
