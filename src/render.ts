import { styleText } from 'node:util'

import { bytes } from './format'
import type { Report } from './kernel/report'

const dim = (s: string) => styleText('dim', s)
const bold = (s: string) => styleText('bold', s)

function wrap(text: string, width: number, indent: string): string {
  const words = text.split(' ')
  const lines: string[] = []
  let line = ''
  for (const w of words) {
    if ((line + ' ' + w).trim().length > width) {
      lines.push(line)
      line = w
    } else line = (line + ' ' + w).trim()
  }
  if (line) lines.push(line)
  return lines.map((l) => indent + l).join('\n')
}

function greeting(date: Date): string {
  const h = date.getHours()
  return h < 12 ? 'Buenos días' : h < 19 ? 'Buenas tardes' : 'Buenas noches'
}

/** El parte del día en la terminal: primero lo urgente, luego lo que conviene, luego el estado. */
export function renderReport(report: Report, name: string, now = new Date()): string {
  const width = Math.min(process.stdout.columns || 90, 100) - 6
  const date = now.toLocaleDateString('es-GT', { weekday: 'long', day: 'numeric', month: 'long' })
  const out: string[] = []
  out.push('')
  out.push(`${bold(`${greeting(now)}, ${name}.`)} ${dim(`Nexo · parte del ${date}`)}`)

  if (report.items.length === 0) {
    out.push('', dim('  Todavía no hay revisiones. Corre: nexo parte --actualizar'), '')
    return out.join('\n')
  }

  const warnings = report.items.filter((i) => i.level === 'warning')
  const suggestions = report.items.filter((i) => i.level === 'suggestion')
  const info = report.items.filter((i) => i.level === 'info')
  const summary = [
    warnings.length
      ? `${warnings.length} ${warnings.length === 1 ? 'cosa requiere' : 'cosas requieren'} tu atención`
      : 'nada urgente',
    report.reclaimableBytes ? `podrías liberar ${bytes(report.reclaimableBytes)}` : null,
  ].filter(Boolean)
  out.push(dim(`  ${summary.join(' · ')}`))
  if (report.summary?.text) out.push('', wrap(report.summary.text, width, '  '))

  const section = (title: string, items: typeof report.items, mark: string) => {
    if (!items.length) return
    out.push('', bold(title))
    for (const i of items) {
      // Si el título ya dice el tamaño, no se repite
      const size =
        i.bytes && !i.title.includes(bytes(i.bytes))
          ? styleText('cyan', ` [${bytes(i.bytes)}]`)
          : ''
      out.push(`  ${mark} ${i.title}${size} ${dim(`· ${i.agentTitle}`)}`)
      if (i.detail) out.push(dim(wrap(i.detail, width, '     ')))
    }
  }
  section('Requiere atención', warnings, styleText('yellow', '▲'))
  section('Podrías hacer', suggestions, styleText('cyan', '◆'))
  section('Estado', info, dim('·'))

  if (report.pendingActions) {
    out.push(
      '',
      `${styleText('cyan', '●')} ${bold(`${report.pendingActions} ${report.pendingActions === 1 ? 'acción espera' : 'acciones esperan'} tu aprobación`)} ${dim('· nexo acciones')}`,
    )
  }

  const checks = report.agents.map((a) =>
    a.checkedAt
      ? `${a.title} ${new Date(a.checkedAt).toLocaleTimeString('es-GT', { hour: '2-digit', minute: '2-digit' })}`
      : `${a.title} —`,
  )
  out.push('', dim(`  Última revisión: ${checks.join(' · ')}`), '')
  return out.join('\n')
}
