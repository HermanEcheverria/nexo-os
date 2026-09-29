import { existsSync } from 'node:fs'
import { mkdir, rename, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { z } from 'zod'

import { normalizePath } from '../kernel/privacy'
import { defineTool, type ToolEnv } from '../kernel/tools'
import { powershell, run } from './shell'
import { PS_PRIVACY, windowsInfo } from './windows'

export type QuarantineItem = {
  original: string
  quarantined: string
  zone: 'windows' | 'wsl'
  bytes: number
  ok: boolean
  error?: string
}
export type QuarantineResult = { items: QuarantineItem[]; freedBytes: number }

const HOME = homedir()
const isWindowsPath = (p: string) => /^[a-z]:\\/i.test(p)
const asArray = <T>(value: T | T[] | null): T[] =>
  value === null ? [] : Array.isArray(value) ? value : [value]

/**
 * Qué se puede mover a cuarentena, aunque lo apruebes: lo de dentro de Descargas,
 * cachés conocidas completas y node_modules de tus proyectos. Nada más.
 */
export async function checkAllowed(path: string, env: ToolEnv): Promise<string | null> {
  if (env.privacy.isForbidden(path)) return 'está en una zona privada'

  if (isWindowsPath(path)) {
    const win = await windowsInfo()
    const p = normalizePath(path)
    const downloads = normalizePath(win.downloads)
    const caches = [`${win.localAppData}\\npm-cache`, `${win.localAppData}\\pip\\Cache`].map((c) =>
      normalizePath(c),
    )
    if (p.startsWith(downloads + '\\') && !p.slice(downloads.length + 1).includes('..')) return null
    if (caches.includes(p)) return null
    return 'no está en Descargas ni es una caché conocida'
  }

  const p = resolve(path)
  if (p !== path.replace(/\/+$/, '')) return 'la ruta no es absoluta y limpia'
  const cacheRoots = [join(HOME, '.npm'), join(HOME, '.local/share/pnpm')]
  if (cacheRoots.includes(p)) return null
  if (dirname(p) === join(HOME, '.cache')) return null
  const projects = env.config.projectRoots.map((r) => resolve(r))
  if (basename(p) === 'node_modules' && projects.includes(dirname(dirname(p)))) return null
  return 'no es una caché conocida ni node_modules de un proyecto'
}

async function du(path: string): Promise<number> {
  const out = await run('du', ['-sb', path], { timeoutMs: 300_000 })
  return Number(out.split('\t')[0])
}

async function windowsQuarantineDir(actionId: number) {
  const { localAppData } = await windowsInfo()
  return `${localAppData}\\Nexo\\Cuarentena\\${actionId}`
}

type Move = { src: string; dest: string }

/** Mueve con PowerShell (mismo disco: es un renombrado, instantáneo aunque pese GB). */
async function windowsMove(moves: Move[], env: ToolEnv, measure: boolean) {
  const rows = await powershell<
    | { original: string; quarantined: string; bytes: number; ok: boolean; error?: string }
    | Array<{
        original: string
        quarantined: string
        bytes: number
        ok: boolean
        error?: string
      }>
    | null
  >(
    `${PS_PRIVACY}
    $out = @(foreach ($m in $Nexo.moves) {
      try {
        if (-not (Test-Path -LiteralPath $m.src)) { throw 'ya no existe' }
        if (Test-Path -LiteralPath $m.dest) { throw 'el destino ya existe' }
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $m.dest) | Out-Null
        $item = Get-Item -LiteralPath $m.src -Force
        $bytes = 0
        if ($Nexo.measure) { $bytes = if ($item.PSIsContainer) { Get-NexoSize $m.src } else { $item.Length } }
        Move-Item -LiteralPath $m.src -Destination $m.dest -ErrorAction Stop
        [pscustomobject]@{ original = $m.src; quarantined = $m.dest; bytes = [int64]$bytes; ok = $true }
      } catch {
        [pscustomobject]@{ original = $m.src; quarantined = $m.dest; bytes = 0; ok = $false; error = $_.Exception.Message }
      }
    })
    ,$out`,
    { moves, measure, zones: env.privacy.windowsZones, marker: env.privacy.marker },
    600_000,
  )
  return asArray(rows)
}

export const quarantineTool = defineTool({
  name: 'archivos.cuarentena',
  risk: 'write',
  description:
    'Mueve archivos o carpetas a la cuarentena de Nexo (se pueden recuperar durante 30 días).',
  input: z.object({ paths: z.array(z.string().min(3)).min(1).max(50) }),

  async run({ paths }, env): Promise<QuarantineResult> {
    if (!env.actionId) throw new Error('La cuarentena solo se usa desde una acción aprobada')
    const items: QuarantineItem[] = []
    const windowsMoves: Move[] = []
    const wslDir = join(env.config.quarantineDir, String(env.actionId))
    const winDir = paths.some(isWindowsPath) ? await windowsQuarantineDir(env.actionId) : ''

    for (const [i, path] of paths.entries()) {
      const zone = isWindowsPath(path) ? 'windows' : 'wsl'
      const name = `${i}-${zone === 'windows' ? path.split('\\').at(-1) : basename(path)}`
      const dest = zone === 'windows' ? `${winDir}\\${name}` : join(wslDir, name)
      // Se vuelve a revisar al ejecutar: la aprobación no salta las reglas
      const denied = await checkAllowed(path, env)
      if (denied) {
        items.push({
          original: path,
          quarantined: dest,
          zone,
          bytes: 0,
          ok: false,
          error: `No permitido: ${denied}`,
        })
        continue
      }
      if (zone === 'windows') {
        windowsMoves.push({ src: path, dest })
        continue
      }
      try {
        if (!existsSync(path)) throw new Error('ya no existe')
        const bytes = await du(path)
        await mkdir(wslDir, { recursive: true })
        await rename(path, dest)
        items.push({ original: path, quarantined: dest, zone, bytes, ok: true })
      } catch (error) {
        items.push({
          original: path,
          quarantined: dest,
          zone,
          bytes: 0,
          ok: false,
          error: String(error),
        })
      }
    }

    if (windowsMoves.length) {
      for (const r of await windowsMove(windowsMoves, env, true))
        items.push({ ...r, zone: 'windows' })
    }
    if (!items.some((i) => i.ok)) {
      throw new Error(items.map((i) => `${i.original}: ${i.error}`).join(' · '))
    }
    return { items, freedBytes: items.reduce((s, i) => s + (i.ok ? i.bytes : 0), 0) }
  },

  /** Devuelve cada cosa a su lugar (si el lugar sigue libre). */
  async undo(result, env) {
    const back = result.items.filter((i) => i.ok)
    const restored: QuarantineItem[] = []
    const windows = back.filter((i) => i.zone === 'windows')
    if (windows.length) {
      const rows = await windowsMove(
        windows.map((i) => ({ src: i.quarantined, dest: i.original })),
        env,
        false,
      )
      for (const r of rows)
        restored.push({
          original: r.quarantined,
          quarantined: r.original,
          zone: 'windows',
          bytes: 0,
          ok: r.ok,
          error: r.error,
        })
    }
    for (const i of back.filter((i) => i.zone === 'wsl')) {
      try {
        if (existsSync(i.original)) throw new Error('ya existe algo en la ruta original')
        await mkdir(dirname(i.original), { recursive: true })
        await rename(i.quarantined, i.original)
        restored.push({ ...i, ok: true })
      } catch (error) {
        restored.push({ ...i, ok: false, error: String(error) })
      }
    }
    if (!restored.some((r) => r.ok)) throw new Error(restored.map((r) => r.error).join(' · '))
    return restored
  },

  /** Vencido el plazo: se borra de verdad lo que quedó en cuarentena. */
  async purge(result) {
    const moved = result.items.filter((i) => i.ok)
    const windows = moved.filter((i) => i.zone === 'windows').map((i) => i.quarantined)
    if (windows.length) {
      await powershell(
        `foreach ($p in $Nexo.paths) { if (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p -Recurse -Force } }
         $dir = Split-Path -Parent $Nexo.paths[0]
         if ((Test-Path $dir) -and -not (Get-ChildItem -LiteralPath $dir -Force)) { Remove-Item -LiteralPath $dir }`,
        { paths: windows },
        600_000,
      )
    }
    for (const i of moved.filter((i) => i.zone === 'wsl'))
      await rm(i.quarantined, { recursive: true, force: true })
  },
})
