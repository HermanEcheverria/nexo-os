/** 5464202432 → "5.1 GB" (base 1024, como lo muestra Windows). */
export function bytes(n: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = n
  let unit = 0
  while (Math.abs(value) >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toLocaleString('es-GT', { maximumFractionDigits: value >= 100 || unit === 0 ? 0 : 1 })} ${units[unit]}`
}

export function daysSince(iso: string, now = Date.now()): number {
  return Math.floor((now - Date.parse(iso)) / 86_400_000)
}

export function plural(n: number, one: string, many: string): string {
  return `${n.toLocaleString('es-GT')} ${n === 1 ? one : many}`
}
