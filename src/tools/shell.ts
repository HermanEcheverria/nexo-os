import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)

/**
 * Ejecuta un programa SIN pasar por una shell: los argumentos nunca se interpretan,
 * así una ruta rara no puede convertirse en un comando.
 */
export async function run(
  command: string,
  args: string[],
  { timeoutMs = 60_000, cwd }: { timeoutMs?: number; cwd?: string } = {},
): Promise<string> {
  const { stdout } = await exec(command, args, {
    timeout: timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
    cwd,
    encoding: 'utf8',
  })
  return stdout
}

/** ¿Estamos en WSL con acceso a Windows? */
export async function hasWindows(): Promise<boolean> {
  try {
    await run('powershell.exe', ['-NoProfile', '-Command', 'exit 0'], { timeoutMs: 15_000 })
    return true
  } catch {
    return false
  }
}

/**
 * Corre un script FIJO de PowerShell. Los datos de entrada viajan en base64 dentro de
 * $Nexo (nunca se concatenan en el código) y la salida vuelve como JSON en UTF-8.
 */
export async function powershell<T>(
  script: string,
  input: unknown = {},
  timeoutMs = 120_000,
): Promise<T> {
  const payload = Buffer.from(JSON.stringify(input), 'utf8').toString('base64')
  const full = [
    '$ErrorActionPreference = "Stop"',
    '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
    `$Nexo = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')) | ConvertFrom-Json`,
    `$result = & { ${script} }`,
    'ConvertTo-Json -InputObject $result -Depth 6 -Compress',
  ].join('\n')
  // -EncodedCommand evita problemas de comillas: PowerShell recibe el script tal cual
  const encoded = Buffer.from(full, 'utf16le').toString('base64')
  const out = await run(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
    { timeoutMs },
  )
  const text = out.replace(/^\uFEFF/, '').trim()
  return (text ? JSON.parse(text) : null) as T
}
