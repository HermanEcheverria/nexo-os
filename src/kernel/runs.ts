import { and, asc, desc, eq, lt } from 'drizzle-orm'

import type { Db } from './db/client'
import { actions, findings, journal, processes } from './db/schema'

type Finding = typeof findings.$inferSelect

export type RunChange =
  | { kind: 'nuevo'; level: Finding['level']; title: string }
  | { kind: 'resuelto'; level: Finding['level']; title: string }
  | { kind: 'cambio'; level: Finding['level']; before: string; after: string }

/**
 * Clave estable de un hallazgo: sin números. Así "Memoria: 69 %" y "Memoria: 71 %" son el
 * mismo hallazgo que cambió, no uno nuevo y otro resuelto.
 */
export function findingKey(f: Pick<Finding, 'level' | 'title'>): string {
  return `${f.level}|${f.title.replace(/\d+([.,]\d+)?/g, '#')}`
}

/** Qué cambió entre dos revisiones del mismo agente. */
export function compareRuns(
  previous: Pick<Finding, 'level' | 'title'>[],
  current: Pick<Finding, 'level' | 'title'>[],
): RunChange[] {
  const before = new Map(previous.map((f) => [findingKey(f), f]))
  const after = new Map(current.map((f) => [findingKey(f), f]))
  const changes: RunChange[] = []
  for (const [key, f] of after) {
    const old = before.get(key)
    if (!old) changes.push({ kind: 'nuevo', level: f.level, title: f.title })
    else if (old.title !== f.title)
      changes.push({ kind: 'cambio', level: f.level, before: old.title, after: f.title })
  }
  for (const [key, f] of before) {
    if (!after.has(key)) changes.push({ kind: 'resuelto', level: f.level, title: f.title })
  }
  // Primero lo que importa: alertas y sugerencias nuevas o resueltas
  const weight = { warning: 0, suggestion: 1, info: 2 }
  return changes.sort((a, b) => weight[a.level] - weight[b.level])
}

export type RunSummary = { warning: number; suggestion: number; info: number }

export function summarize(list: Pick<Finding, 'level'>[]): RunSummary {
  const s: RunSummary = { warning: 0, suggestion: 0, info: 0 }
  for (const f of list) s[f.level] += 1
  return s
}

/** Todo sobre una ejecución: sus pasos, hallazgos, propuestas y qué cambió respecto de la anterior. */
export async function runDetails(db: Db, pid: number) {
  const [proc] = await db.select().from(processes).where(eq(processes.pid, pid))
  if (!proc) return null
  const steps = await db.select().from(journal).where(eq(journal.pid, pid)).orderBy(asc(journal.id))
  const found = await db
    .select()
    .from(findings)
    .where(eq(findings.pid, pid))
    .orderBy(asc(findings.id))
  const proposed = await db
    .select()
    .from(actions)
    .where(eq(actions.pid, pid))
    .orderBy(asc(actions.id))

  // La revisión exitosa anterior del mismo agente, para comparar
  const [previous] = await db
    .select({ pid: processes.pid, finishedAt: processes.finishedAt })
    .from(processes)
    .where(
      and(eq(processes.agent, proc.agent), eq(processes.state, 'done'), lt(processes.pid, pid)),
    )
    .orderBy(desc(processes.pid))
    .limit(1)
  const previousFindings = previous
    ? await db.select().from(findings).where(eq(findings.pid, previous.pid))
    : null

  return {
    process: proc,
    steps,
    findings: found,
    summary: summarize(found),
    proposals: proposed,
    changes:
      previousFindings && proc.state === 'done' ? compareRuns(previousFindings, found) : null,
    previousAt: previous?.finishedAt ?? null,
  }
}

/** Resumen de la última revisión terminada de un agente (para su tarjeta). */
export async function lastRunSummary(db: Db, agent: string) {
  const [last] = await db
    .select()
    .from(processes)
    .where(eq(processes.agent, agent))
    .orderBy(desc(processes.pid))
    .limit(1)
  if (!last) return null
  const found = await db
    .select({ level: findings.level })
    .from(findings)
    .where(eq(findings.pid, last.pid))
  return {
    pid: last.pid,
    state: last.state,
    finishedAt: last.finishedAt,
    summary: summarize(found),
  }
}
