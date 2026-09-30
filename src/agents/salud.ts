import { daysSince } from '../format'
import { defineAgent } from '../kernel/agent'
import type { Tools } from '../tools'

/** Salud del equipo: batería, GPU, memoria, discos y lo que más consume. */
export const salud = defineAgent<Tools>({
  name: 'salud',
  title: 'Salud',
  description: 'Revisa batería, GPU, memoria, discos y los procesos que más consumen.',
  capabilities: ['salud.bateria', 'salud.gpu', 'salud.sistema'],
  everyMinutes: 60,
  onLogin: true,
  async run(ctx) {
    const battery = await ctx.tools.call('salud.bateria')
    if (battery.present) {
      const health = battery.health === null ? null : Math.round(battery.health * 100)
      await ctx.finding({
        level: health !== null && health < 60 ? 'suggestion' : 'info',
        title:
          health === null
            ? `Batería: ${battery.percent ?? '?'} %`
            : `La batería conserva el ${health} % de su capacidad original`,
        detail: [
          health !== null && health < 60
            ? 'Está bastante desgastada: dura menos de la mitad que nueva. Si la usas lejos del cargador, considera cambiarla.'
            : null,
          `${battery.percent ?? '?'} % de carga, ${battery.charging ? 'conectada al cargador' : 'usando la batería'}.`,
          battery.charging
            ? null
            : 'Con batería, Windows baja el rendimiento de la GPU: el modelo local responde más lento.',
        ]
          .filter(Boolean)
          .join(' '),
        data: { health: battery.health, charging: battery.charging },
      })
    }

    const gpu = await ctx.tools.call('salud.gpu')
    if (gpu) {
      await ctx.finding({
        level: gpu.temperature >= 85 ? 'warning' : 'info',
        title: `GPU a ${gpu.temperature} °C, ${gpu.utilization} % de uso`,
        detail: `${gpu.name} · memoria ${Math.round(gpu.memoryUsedMb / 102.4) / 10} de ${Math.round(gpu.memoryTotalMb / 1024)} GB · ${gpu.powerW} W (${gpu.pstate})${gpu.temperature >= 85 ? ' · Está muy caliente: revisa la ventilación.' : ''}`,
      })
    }

    const sys = await ctx.tools.call('salud.sistema')
    const used = 1 - sys.ramFreeGb / sys.ramTotalGb
    const top = sys.top.map((p) => `${p.name} (${(p.memoryMb / 1024).toFixed(1)} GB)`).join(', ')
    await ctx.finding({
      level: used > 0.9 ? 'warning' : 'info',
      title: `Memoria: ${Math.round(used * 100)} % en uso (${sys.ramFreeGb} GB libres de ${sys.ramTotalGb})`,
      detail: `Lo que más consume: ${top}.`,
    })

    const uptimeDays = daysSince(sys.bootedAt)
    if (uptimeDays >= 7) {
      await ctx.finding({
        level: 'suggestion',
        title: `La PC lleva ${uptimeDays} días sin reiniciarse`,
        detail: 'Reiniciar de vez en cuando aplica actualizaciones y libera memoria.',
      })
    }

    const sick = sys.disks.filter((d) => d.health !== 'Healthy')
    await ctx.finding({
      level: sick.length ? 'warning' : 'info',
      title: sick.length
        ? `Disco con problemas: ${sick.map((d) => `${d.name} (${d.health})`).join(', ')}`
        : `${sys.disks.length === 1 ? 'El disco está' : 'Los discos están'} en buen estado`,
      detail: sick.length
        ? 'Haz un respaldo de tus archivos importantes cuanto antes.'
        : sys.disks.map((d) => d.name).join(', '),
    })
  },
})
