import { desc, eq, inArray } from 'drizzle-orm'

import type { Db } from './db/client'
import { findings, processes } from './db/schema'

export type ReportItem = {
  agent: string
  agentTitle: string
  level: 'info' | 'suggestion' | 'warning'
  title: string
  detail: string | null
  bytes: number | null
}

export type Report = {
  generatedAt: string
  /** Cuándo revisó por última vez cada agente (null si nunca). */
  agents: { name: string; title: string; checkedAt: string | null; state: string | null }[]
  items: ReportItem[]
  reclaimableBytes: number
  /** Acciones esperando tu aprobación (lo agrega el servicio). */
  pendingActions?: number
  /** Resumen redactado por el modelo local (lo agrega el servicio). */
  summary?: { text: string; at: string } | null
  assistant?: boolean
}

/** El parte usa la última revisión exitosa de cada agente. */
export async function buildReport(
  db: Db,
  agents: { name: string; title: string }[],
): Promise<Report> {
  const latest = []
  for (const agent of agents) {
    const recent = await db
      .select()
      .from(processes)
      .where(eq(processes.agent, agent.name))
      .orderBy(desc(processes.pid))
      .limit(20)
    const done = recent.find((r) => r.state === 'done')
    latest.push({
      name: agent.name,
      title: agent.title,
      pid: done?.pid ?? null,
      checkedAt: done?.finishedAt ?? null,
      state: recent[0]?.state ?? null,
    })
  }

  const pids = latest.flatMap((l) => (l.pid ? [l.pid] : []))
  const rows = pids.length
    ? await db.select().from(findings).where(inArray(findings.pid, pids))
    : []
  const titles = new Map(latest.map((l) => [l.name, l.title]))
  const order = { warning: 0, suggestion: 1, info: 2 }
  const items = rows
    .map((f) => ({
      agent: f.agent,
      agentTitle: titles.get(f.agent) ?? f.agent,
      level: f.level,
      title: f.title,
      detail: f.detail,
      bytes: f.bytes,
    }))
    .sort((a, b) => order[a.level] - order[b.level] || (b.bytes ?? 0) - (a.bytes ?? 0))

  return {
    generatedAt: new Date().toISOString(),
    agents: latest.map(({ name, title, checkedAt, state }) => ({
      name,
      title,
      checkedAt: checkedAt?.toISOString() ?? null,
      state,
    })),
    items,
    reclaimableBytes: items.reduce(
      (s, i) => s + (i.level === 'suggestion' ? (i.bytes ?? 0) : 0),
      0,
    ),
  }
}
