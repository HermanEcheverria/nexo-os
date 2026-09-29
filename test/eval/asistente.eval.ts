/**
 * Evaluación del asistente con un modelo REAL (no corre en `pnpm test`):
 *   npx tsx test/eval/asistente.eval.ts qwen3.5:4b
 * Usa el parte real del servicio y revisa la intención elegida y las cifras citadas.
 */
import { readFileSync } from 'node:fs'

import { defaultConfig, PATHS } from '../../src/config'
import type { Action } from '../../src/kernel/actions'
import type { Report } from '../../src/kernel/report'
import { Assistant, type AssistantContext } from '../../src/llm/assistant'
import { ollamaModel } from '../../src/llm/ollama'

const model = process.argv[2] ?? 'qwen3.5:4b'
const token = readFileSync(PATHS.token, 'utf8').trim()
const get = async <T>(path: string) =>
  (await (
    await fetch(`http://127.0.0.1:4747${path}`, { headers: { Authorization: `Bearer ${token}` } })
  ).json()) as T
const agents = await get<{ name: string; title: string; description: string }[]>('/agentes')
const context: AssistantContext = {
  report: await get<Report>('/parte'),
  pending: await get<Action[]>('/acciones?estado=pendientes'),
  agents,
  now: new Date(),
}

const GB = 1024 ** 3
const pendingGb = `${(context.pending.reduce((s, a) => s + (a.bytes ?? 0), 0) / GB).toFixed(1)} GB`
const casos: {
  pregunta: string
  intencion: string | string[]
  agente?: string
  debeMencionar?: string[]
  noDebeMencionar?: string[]
}[] = [
  { pregunta: '¿qué ocupa tanto espacio en mi PC?', intencion: ['responder', 'ver_aprobaciones'] },
  {
    pregunta: 'libera espacio, bórrame lo que no uso',
    intencion: 'ver_aprobaciones',
    debeMencionar: [String(context.pending.length), pendingGb],
  },
  { pregunta: 'revisa de nuevo mis proyectos', intencion: 'ejecutar_agente', agente: 'jardinero' },
  { pregunta: 'vuelve a mirar mis descargas', intencion: 'ejecutar_agente', agente: 'inventario' },
  { pregunta: '¿hay actualizaciones pendientes?', intencion: 'responder', debeMencionar: ['27'] },
  {
    pregunta: '¿cuántas propuestas tengo por aprobar?',
    intencion: ['responder', 'ver_aprobaciones'],
    debeMencionar: [String(context.pending.length)],
  },
  { pregunta: 'aprueba todas las propuestas', intencion: 'ver_aprobaciones' },
  {
    pregunta: 'dame un resumen detallado de las propuestas pendientes',
    intencion: ['responder', 'ver_aprobaciones'],
    // Debe nombrar cada propuesta: se revisan las tres primeras
    debeMencionar: context.pending.slice(0, 3).map((a) => a.title.match(/«(.+?)»/)?.[1] ?? a.title),
  },
  { pregunta: '¿qué puedes hacer?', intencion: 'responder', noDebeMencionar: ['Andrés', ' GB'] },
  { pregunta: '¿cuál es la capital de Francia?', intencion: 'fuera_de_alcance' },
]

const assistant = new Assistant(ollamaModel({ ...defaultConfig().llm, model }))
let ok = 0
let total = 0
for (const c of casos) {
  const start = performance.now()
  const a = await assistant.ask(c.pregunta, context)
  const ms = Math.round(performance.now() - start)
  const valid = Array.isArray(c.intencion) ? c.intencion : [c.intencion]
  const intentOk = valid.includes(a.intencion) && (!c.agente || a.agente === c.agente)
  const missing = [
    ...(c.debeMencionar ?? []).filter((m: string) => !a.respuesta.includes(m)),
    ...(c.noDebeMencionar ?? [])
      .filter((m: string) => a.respuesta.includes(m))
      .map((m: string) => `sin "${m}"`),
  ]
  const pass = intentOk && missing.length === 0
  ok += Number(pass)
  total += ms
  console.log(`${pass ? '✓' : '✗'} ${c.pregunta}  (${ms} ms)`)
  if (!pass)
    console.log(
      `   esperaba ${valid.join('|')}${c.agente ? `/${c.agente}` : ''} → ${a.intencion}/${a.agente}${missing.length ? ` · faltó: ${missing.join(', ')}` : ''}`,
    )
  console.log(`   ${a.respuesta}`)
}
const start = performance.now()
const resumen = await assistant.summarize(context)
console.log(
  `\nResumen [${resumen.source}] (${Math.round(performance.now() - start)} ms): ${resumen.text}`,
)
console.log(
  `\n${model}: ${ok}/${casos.length} correctas · promedio ${Math.round(total / casos.length)} ms`,
)
