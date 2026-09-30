import { z } from 'zod'

import { defineTool } from '../kernel/tools'
import { powershell, run } from './shell'

export type BatteryInfo = {
  present: boolean
  charging: boolean
  percent: number | null
  designMwh: number | null
  fullMwh: number | null
  /** Capacidad que conserva respecto de la de fábrica (0 a 1). */
  health: number | null
  cycles: number | null
}

export function batteryHealth(designMwh: number | null, fullMwh: number | null): number | null {
  if (!designMwh || !fullMwh) return null
  return Math.min(1, fullMwh / designMwh)
}

/** nvidia-smi --format=csv,noheader,nounits → datos de la GPU. */
export function parseNvidiaSmi(text: string) {
  const [line] = text.trim().split('\n')
  if (!line) return null
  const [name, temp, util, memUsed, memTotal, power, pstate] = line.split(',').map((s) => s.trim())
  return {
    name: name!,
    temperature: Number(temp),
    utilization: Number(util),
    memoryUsedMb: Number(memUsed),
    memoryTotalMb: Number(memTotal),
    powerW: Number(power),
    pstate: pstate!,
  }
}

export const healthTools = {
  'salud.bateria': defineTool({
    name: 'salud.bateria',
    risk: 'read',
    description:
      'Carga, si está conectada al cargador y desgaste de la batería (informe de powercfg).',
    input: z.object({}),
    async run(): Promise<BatteryInfo> {
      const data = await powershell<{
        present: boolean
        status: number | null
        percent: number | null
        design: string | null
        full: string | null
        cycles: string | null
      }>(`
        $b = Get-CimInstance Win32_Battery | Select-Object -First 1
        $file = Join-Path $env:TEMP ('nexo-bateria-' + [guid]::NewGuid() + '.xml')
        powercfg /batteryreport /xml /output $file | Out-Null
        $design = $null; $full = $null; $cycles = $null
        if (Test-Path $file) {
          [xml]$x = Get-Content $file
          $r = @($x.BatteryReport.Batteries.Battery)[0]
          $design = $r.DesignCapacity; $full = $r.FullChargeCapacity; $cycles = $r.CycleCount
          Remove-Item $file
        }
        [pscustomobject]@{
          present = [bool]$b; status = $b.BatteryStatus; percent = $b.EstimatedChargeRemaining
          design = $design; full = $full; cycles = $cycles
        }`)
      const designMwh = data.design ? Number(data.design) : null
      const fullMwh = data.full ? Number(data.full) : null
      return {
        present: data.present,
        // BatteryStatus 1 = descargándose (sin cargador); 2 o más = con corriente
        charging: data.status !== 1,
        percent: data.percent,
        designMwh,
        fullMwh,
        health: batteryHealth(designMwh, fullMwh),
        cycles: data.cycles ? Number(data.cycles) || null : null,
      }
    },
  }),

  'salud.gpu': defineTool({
    name: 'salud.gpu',
    risk: 'read',
    description: 'Temperatura, uso, memoria y modo de energía de la GPU NVIDIA.',
    input: z.object({}),
    async run() {
      const out = await run('nvidia-smi', [
        '--query-gpu=name,temperature.gpu,utilization.gpu,memory.used,memory.total,power.draw,pstate',
        '--format=csv,noheader,nounits',
      ]).catch(() => '')
      return parseNvidiaSmi(out)
    },
  }),

  'salud.sistema': defineTool({
    name: 'salud.sistema',
    risk: 'read',
    description: 'Memoria, tiempo encendida, estado de los discos y procesos que más consumen.',
    input: z.object({}),
    async run() {
      const data = await powershell<{
        ramFreeGb: number
        ramTotalGb: number
        bootedAt: string
        disks: { name: string; health: string }[] | { name: string; health: string }
        top: { name: string; memoryMb: number; cpuSeconds: number }[]
      }>(`
        $os = Get-CimInstance Win32_OperatingSystem
        [pscustomobject]@{
          ramFreeGb = [math]::Round($os.FreePhysicalMemory / 1MB, 1)
          ramTotalGb = [math]::Round($os.TotalVisibleMemorySize / 1MB, 1)
          bootedAt = $os.LastBootUpTime.ToUniversalTime().ToString('o')
          disks = @(Get-PhysicalDisk | ForEach-Object { [pscustomobject]@{ name = $_.FriendlyName; health = [string]$_.HealthStatus } })
          top = @(Get-Process | Group-Object ProcessName | ForEach-Object {
            [pscustomobject]@{
              name = $_.Name
              memoryMb = [math]::Round(($_.Group | Measure-Object WorkingSet64 -Sum).Sum / 1MB)
              cpuSeconds = [math]::Round(($_.Group | Measure-Object CPU -Sum).Sum)
            }
          } | Sort-Object memoryMb -Descending | Select-Object -First 6)
        }`)
      return { ...data, disks: Array.isArray(data.disks) ? data.disks : [data.disks] }
    },
  }),
}
