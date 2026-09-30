import { z } from 'zod'

import { defineTool } from '../kernel/tools'
import { run } from './shell'
import { powershell } from './shell'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * productState del Centro de Seguridad de Windows (sin documentación oficial, pero estable):
 * el segundo byte dice si está activo (0x10/0x11) y el tercero si las firmas están al día (0x00).
 */
export function decodeProductState(state: number): { enabled: boolean; upToDate: boolean } {
  const scanner = (state >> 8) & 0xff
  return { enabled: scanner === 0x10 || scanner === 0x11, upToDate: (state & 0xff) === 0x00 }
}

/** Puertos que no deberían quedar abiertos a toda la red sin una buena razón. */
const RISKY_PORTS: Record<number, string> = {
  21: 'FTP',
  22: 'SSH',
  23: 'Telnet',
  1433: 'SQL Server',
  3306: 'MySQL/MariaDB',
  3389: 'Escritorio remoto',
  4747: 'la API de Nexo',
  5432: 'PostgreSQL',
  5900: 'VNC',
  6379: 'Redis',
  9200: 'Elasticsearch',
  11434: 'Ollama',
  27017: 'MongoDB',
}

export type ExposedPort = { port: number; process: string; risk: string | null }

export function classifyPorts(ports: { port: number; process: string }[]): ExposedPort[] {
  return ports.map((p) => ({ ...p, risk: RISKY_PORTS[p.port] ?? null }))
}

/** Patrones de secretos con formato conocido. Nunca se guarda el valor, solo dónde está. */
export const SECRET_PATTERNS: { type: string; regex: string }[] = [
  { type: 'llave privada', regex: '-----BEGIN ([A-Z]+ )?PRIVATE KEY-----' },
  {
    type: 'token de GitHub',
    regex: '(ghp|gho|ghs|ghu)_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{50,}',
  },
  { type: 'llave de AWS', regex: 'AKIA[0-9A-Z]{16}' },
  { type: 'token de Slack', regex: 'xox[baprs]-[A-Za-z0-9-]{10,}' },
  { type: 'llave de Google', regex: 'AIza[0-9A-Za-z_-]{35}' },
  { type: 'token de npm', regex: '_authToken=[^$ ]{10,}' },
]

/** Archivos que casi nunca deberían estar versionados en git. */
export const SECRET_FILES =
  /(^|\/)(\.env(\.[\w-]+)?|id_rsa|id_ed25519|.*\.pem|.*\.key|credentials\.json)$/i
export const SAFE_FILES = /(^|\/)\.env\.(example|sample|template)$/i

export type SecretHit = { repo: string; file: string; line: number | null; type: string }

export const securityTools = {
  'seguridad.antivirus': defineTool({
    name: 'seguridad.antivirus',
    risk: 'read',
    description:
      'Antivirus registrados en el Centro de Seguridad de Windows y estado del firewall.',
    input: z.object({}),
    async run() {
      const data = await powershell<{
        av: { name: string; state: number }[] | { name: string; state: number } | null
        firewall: { name: string; enabled: boolean }[] | null
      }>(`
        [pscustomobject]@{
          av = @(Get-CimInstance -Namespace root/SecurityCenter2 -ClassName AntiVirusProduct | ForEach-Object {
            [pscustomobject]@{ name = $_.displayName; state = [int]$_.productState } })
          firewall = @(Get-NetFirewallProfile | ForEach-Object { [pscustomobject]@{ name = [string]$_.Name; enabled = [bool]$_.Enabled } })
        }`)
      const av = data.av === null ? [] : Array.isArray(data.av) ? data.av : [data.av]
      return {
        antivirus: av.map((a) => ({ name: a.name, ...decodeProductState(a.state) })),
        firewall: data.firewall ?? [],
      }
    },
  }),

  'seguridad.puertos': defineTool({
    name: 'seguridad.puertos',
    risk: 'read',
    description: 'Puertos que aceptan conexiones desde toda la red (no solo desde esta PC).',
    input: z.object({}),
    async run() {
      const rows = await powershell<
        { port: number; process: string }[] | { port: number; process: string } | null
      >(`
        @(Get-NetTCPConnection -State Listen | Where-Object { $_.LocalAddress -in '0.0.0.0','::' } |
          Sort-Object LocalPort -Unique | ForEach-Object {
            [pscustomobject]@{ port = [int]$_.LocalPort; process = [string](Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue).Name }
          })`)
      const list = rows === null ? [] : Array.isArray(rows) ? rows : [rows]
      return classifyPorts(list)
    },
  }),

  'seguridad.inicio': defineTool({
    name: 'seguridad.inicio',
    risk: 'read',
    description: 'Programas que arrancan solos al iniciar sesión en Windows.',
    input: z.object({}),
    async run() {
      const rows = await powershell<
        { name: string; location: string }[] | { name: string; location: string } | null
      >(`
        @(Get-CimInstance Win32_StartupCommand | ForEach-Object { [pscustomobject]@{ name = $_.Name; location = $_.Location } })`)
      return rows === null ? [] : Array.isArray(rows) ? rows : [rows]
    },
  }),

  'seguridad.secretos': defineTool({
    name: 'seguridad.secretos',
    risk: 'read',
    description:
      'Busca en tus repositorios archivos o tokens secretos versionados (sin leer el valor).',
    input: z.object({}),
    async run(_input, { config, privacy }): Promise<SecretHit[]> {
      const hits: SecretHit[] = []
      for (const root of config.projectRoots) {
        const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
        for (const e of entries) {
          const repo = join(root, e.name)
          if (!e.isDirectory() || privacy.isForbidden(repo)) continue
          if (!(await stat(join(repo, '.git')).catch(() => null))) continue

          // Solo lo versionado: lo que está en .gitignore no se sube, así que no es riesgo
          const files = (
            await run('git', ['-C', repo, 'ls-files'], { timeoutMs: 30_000 }).catch(() => '')
          )
            .split('\n')
            .filter(Boolean)
          for (const file of files) {
            if (SECRET_FILES.test(file) && !SAFE_FILES.test(file))
              hits.push({ repo: e.name, file, line: null, type: 'archivo sensible' })
          }
          for (const pattern of SECRET_PATTERNS) {
            // git grep -I ignora binarios; -l -n no hace falta el contenido: solo archivo y línea
            const out = await run(
              'git',
              ['-C', repo, 'grep', '-I', '-n', '-E', '-o', pattern.regex],
              {
                timeoutMs: 30_000,
              },
            ).catch(() => '')
            for (const line of out.split('\n').filter(Boolean)) {
              const [file, lineNo] = line.split(':')
              if (file)
                hits.push({ repo: e.name, file, line: Number(lineNo) || null, type: pattern.type })
            }
          }
        }
      }
      return hits
    },
  }),
}
