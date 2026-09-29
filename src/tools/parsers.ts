export type Upgrade = {
  name: string
  id?: string
  current: string
  available: string
  security?: boolean
}

/** `apt list --upgradable` → paquetes; los que vienen de "-security" son de seguridad. */
export function parseAptUpgradable(text: string): Upgrade[] {
  const out: Upgrade[] = []
  for (const line of text.split('\n')) {
    const m = line.match(/^([^/\s]+)\/(\S+)\s+(\S+)\s+\S+\s+\[upgradable from: ([^\]]+)\]/)
    if (m)
      out.push({
        name: m[1]!,
        current: m[4]!,
        available: m[3]!,
        security: m[2]!.includes('-security'),
      })
  }
  return out
}

/**
 * `winget upgrade` imprime una tabla de ancho fijo (sin JSON). Se leen las columnas
 * por la posición de los encabezados, porque los nombres pueden tener espacios.
 */
export function parseWingetUpgrade(text: string): Upgrade[] {
  const lines = text.replace(/\r/g, '').split('\n')
  const headerIndex = lines.findIndex((l) => /\bName\b.*\bId\b.*\bVersion\b.*\bAvailable\b/.test(l))
  if (headerIndex === -1) return []
  const header = lines[headerIndex]!
  // Puede haber restos de la animación de carga antes de "Name"
  const shift = header.indexOf('Name')
  const col = (name: string) => header.indexOf(name) - shift
  const [id, version, available, source] = [
    col('Id'),
    col('Version'),
    col('Available'),
    col('Source'),
  ]

  const out: Upgrade[] = []
  for (const line of lines.slice(headerIndex + 2)) {
    if (!line.trim() || /^\d+ (upgrades?|actualizaci)/i.test(line.trim())) break
    const cut = (from: number, to: number) => line.slice(from, to > 0 ? to : undefined).trim()
    out.push({
      name: cut(0, id),
      id: cut(id, version),
      current: cut(version, available),
      available: cut(available, source),
    })
  }
  return out
}
