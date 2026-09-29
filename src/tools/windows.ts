import { powershell } from './shell'

export type WindowsInfo = {
  userProfile: string
  localAppData: string
  oneDrive: string | null
  downloads: string
  drives: { name: string; usedBytes: number; freeBytes: number }[]
}

let cached: Promise<WindowsInfo> | undefined

/** Rutas reales de Windows (Descargas puede estar movida o en OneDrive) y discos. */
export function windowsInfo(): Promise<WindowsInfo> {
  cached ??= powershell<WindowsInfo>(`
    $downloads = (New-Object -ComObject Shell.Application).NameSpace('shell:Downloads').Self.Path
    [pscustomobject]@{
      userProfile = $env:USERPROFILE
      localAppData = $env:LOCALAPPDATA
      oneDrive = $env:OneDrive
      downloads = $downloads
      drives = @(Get-PSDrive -PSProvider FileSystem | Where-Object { $_.Used -ne $null } | ForEach-Object {
        [pscustomobject]@{ name = $_.Name; usedBytes = [int64]$_.Used; freeBytes = [int64]$_.Free }
      })
    }`)
  return cached
}

/**
 * Funciones de PowerShell para medir carpetas respetando las zonas prohibidas y el
 * archivo marcador. Se anteponen a cada script que recorre carpetas de Windows.
 */
export const PS_PRIVACY = `
  function Test-NexoPrivate([string]$path) {
    $p = $path.ToLower().TrimEnd('\\')
    foreach ($z in $Nexo.zones) { if ($p -eq $z -or $p.StartsWith($z + '\\')) { return $true } }
    return (Test-Path -LiteralPath (Join-Path $path $Nexo.marker))
  }
  function Get-NexoSize([string]$dir) {
    if (Test-NexoPrivate $dir) { return -1 }
    $sum = [int64]0
    foreach ($item in Get-ChildItem -LiteralPath $dir -Force -ErrorAction SilentlyContinue) {
      if ($item.PSIsContainer) {
        if (-not ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
          $s = Get-NexoSize $item.FullName
          if ($s -gt 0) { $sum += $s }
        }
      } else { $sum += $item.Length }
    }
    return $sum
  }`
