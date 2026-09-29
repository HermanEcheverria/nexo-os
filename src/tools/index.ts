import { existsSync } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'

import { defineTool } from '../kernel/tools'
import { parseAptUpgradable, parseWingetUpgrade } from './parsers'
import { powershell, run, toWslPath } from './shell'
import { quarantineTool } from './quarantine'
import { PS_PRIVACY, windowsInfo } from './windows'

const HOME = homedir()

/** Tamaño en bytes con du (rápido en ext4). -1 si la ruta es privada o no existe. */
async function du(path: string): Promise<number> {
  try {
    const out = await run('du', ['-sb', path], { timeoutMs: 120_000 })
    return Number(out.split('\t')[0])
  } catch {
    return -1
  }
}

export type DiskInfo = { name: string; totalBytes: number; freeBytes: number }

export const tools = {
  'sistema.discos': defineTool({
    name: 'sistema.discos',
    risk: 'read',
    description: 'Espacio usado y libre en los discos de Windows y en WSL.',
    input: z.object({}),
    async run(): Promise<DiskInfo[]> {
      const [wsl, win] = await Promise.all([
        run('df', ['-B1', '--output=size,avail', '/']),
        windowsInfo(),
      ])
      const [size, avail] = wsl.trim().split('\n')[1]!.trim().split(/\s+/).map(Number)
      return [
        ...win.drives.map((d) => ({
          name: `${d.name}:`,
          totalBytes: d.usedBytes + d.freeBytes,
          freeBytes: d.freeBytes,
        })),
        { name: 'WSL', totalBytes: size!, freeBytes: avail! },
      ]
    },
  }),

  'windows.descargas': defineTool({
    name: 'windows.descargas',
    risk: 'read',
    description: 'Lista lo que hay en Descargas (sin abrir archivos): tamaño y fechas.',
    input: z.object({}),
    async run(_input, { privacy }) {
      const { downloads } = await windowsInfo()
      if (privacy.isForbidden(downloads)) return { path: downloads, items: [], private: true }
      const items = await powershell<
        { name: string; isDir: boolean; bytes: number; modified: string; accessed: string }[] | null
      >(
        `${PS_PRIVACY}
        @(Get-ChildItem -LiteralPath $Nexo.path -Force -ErrorAction SilentlyContinue | ForEach-Object {
          $bytes = if ($_.PSIsContainer) { Get-NexoSize $_.FullName } elseif (Test-NexoPrivate $_.FullName) { -1 } else { $_.Length }
          if ($bytes -ge 0) {
            [pscustomobject]@{
              name = $_.Name; isDir = $_.PSIsContainer; bytes = [int64]$bytes
              modified = $_.LastWriteTimeUtc.ToString('o'); accessed = $_.LastAccessTimeUtc.ToString('o')
            }
          }
        })`,
        { path: downloads, zones: privacy.windowsZones, marker: privacy.marker },
        300_000,
      )
      return { path: downloads, items: items ?? [], private: false }
    },
  }),

  'sistema.caches': defineTool({
    name: 'sistema.caches',
    risk: 'read',
    description: 'Tamaño de cachés y temporales conocidos (Windows y WSL).',
    input: z.object({}),
    async run(_input, { privacy }) {
      type Cache = { id: string; label: string; path: string; bytes: number; regenerable: boolean }
      const windows = await powershell<Cache[] | null>(
        `${PS_PRIVACY}
        $known = @(
          @{ id = 'win-npm'; label = 'Caché de npm (Windows)'; path = "$env:LOCALAPPDATA\\npm-cache"; regenerable = $true },
          @{ id = 'win-temp'; label = 'Temporales de Windows'; path = $env:TEMP; regenerable = $true },
          @{ id = 'win-pip'; label = 'Caché de pip (Windows)'; path = "$env:LOCALAPPDATA\\pip\\Cache"; regenerable = $true },
          @{ id = 'win-docker'; label = 'Datos de Docker Desktop'; path = "$env:LOCALAPPDATA\\Docker"; regenerable = $false }
        )
        $out = @(foreach ($k in $known) {
          if (Test-Path -LiteralPath $k.path) {
            $b = Get-NexoSize $k.path
            if ($b -ge 0) { [pscustomobject]@{ id = $k.id; label = $k.label; path = $k.path; bytes = [int64]$b; regenerable = $k.regenerable } }
          }
        })
        $bin = (New-Object -ComObject Shell.Application).NameSpace(10)
        $binBytes = [int64](($bin.Items() | Measure-Object -Property Size -Sum).Sum)
        $out + [pscustomobject]@{ id = 'win-papelera'; label = 'Papelera de reciclaje'; path = 'Papelera'; bytes = $binBytes; regenerable = $true }`,
        { zones: privacy.windowsZones, marker: privacy.marker },
        300_000,
      )

      const wslKnown = [
        { id: 'wsl-npm', label: 'Caché de npm (WSL)', path: join(HOME, '.npm') },
        { id: 'wsl-pnpm', label: 'Almacén de pnpm (WSL)', path: join(HOME, '.local/share/pnpm') },
      ]
      // Cada subcarpeta de ~/.cache por separado: así se ve qué programa ocupa más
      const cacheDir = join(HOME, '.cache')
      const children = await readdir(cacheDir, { withFileTypes: true }).catch(() => [])
      for (const c of children) {
        if (c.isDirectory())
          wslKnown.push({
            id: `wsl-cache-${c.name}`,
            label: `~/.cache/${c.name}`,
            path: join(cacheDir, c.name),
          })
      }
      const wsl: Cache[] = []
      for (const k of wslKnown) {
        if (privacy.isForbidden(k.path)) continue
        const bytes = await du(k.path)
        if (bytes > 0) wsl.push({ ...k, bytes, regenerable: true })
      }
      return [...(windows ?? []), ...wsl]
    },
  }),

  'proyectos.revisar': defineTool({
    name: 'proyectos.revisar',
    risk: 'read',
    description: 'Estado de los repositorios git en las carpetas de proyectos.',
    input: z.object({}),
    async run(_input, { config, privacy }) {
      const repos: string[] = []
      for (const root of config.projectRoots) {
        const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
        for (const e of entries) {
          const dir = join(root, e.name)
          if (!e.isDirectory() || privacy.isForbidden(dir)) continue
          if (await stat(join(dir, '.git')).catch(() => null)) repos.push(dir)
        }
      }
      const git = (dir: string, args: string[]) =>
        run('git', ['-C', dir, ...args], { timeoutMs: 30_000 }).then((s) => s.trim())

      return Promise.all(
        repos.map(async (dir) => {
          const [lastCommit, status, branch] = await Promise.all([
            git(dir, ['log', '-1', '--format=%cI']).catch(() => ''),
            git(dir, ['status', '--porcelain']).catch(() => ''),
            git(dir, ['branch', '--show-current']).catch(() => ''),
          ])
          // Sin rama remota configurada no hay "commits sin subir" que contar
          const ahead = await git(dir, ['rev-list', '--count', '@{u}..HEAD'])
            .then(Number)
            .catch(() => null)
          const [size, nodeModules] = await Promise.all([du(dir), du(join(dir, 'node_modules'))])
          return {
            path: dir,
            name: dir.split('/').at(-1)!,
            branch,
            lastCommit: lastCommit || null,
            dirtyFiles: status ? status.split('\n').length : 0,
            unpushed: ahead,
            bytes: size,
            nodeModulesBytes: Math.max(0, nodeModules),
          }
        }),
      )
    },
  }),

  'paquetes.apt': defineTool({
    name: 'paquetes.apt',
    risk: 'read',
    description: 'Actualizaciones pendientes de Ubuntu (WSL).',
    input: z.object({}),
    run: async () => parseAptUpgradable(await run('apt', ['list', '--upgradable'])),
  }),

  'paquetes.winget': defineTool({
    name: 'paquetes.winget',
    risk: 'read',
    description: 'Actualizaciones pendientes de programas de Windows (winget).',
    input: z.object({}),
    async run() {
      // winget vive en WindowsApps del usuario; se llama por ruta absoluta (ver POWERSHELL)
      const { localAppData } = await windowsInfo()
      const winget = toWslPath(`${localAppData}\\Microsoft\\WindowsApps\\winget.exe`)
      const out = await run(
        existsSync(winget) ? winget : 'winget.exe',
        ['upgrade', '--include-unknown', '--disable-interactivity', '--accept-source-agreements'],
        { timeoutMs: 120_000 },
      )
      return parseWingetUpgrade(out)
    },
  }),

  'archivos.cuarentena': quarantineTool,
}

export type Tools = typeof tools
