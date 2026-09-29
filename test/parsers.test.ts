import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { parseAptUpgradable, parseWingetUpgrade } from '../src/tools/parsers'

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')

describe('parsers', () => {
  it('lee apt list --upgradable', () => {
    const rows = parseAptUpgradable(fixture('apt-upgradable.txt'))
    expect(rows.length).toBeGreaterThan(5)
    expect(rows[0]).toMatchObject({
      name: 'libaudit-common',
      available: '1:4.1.2-1ubuntu0.1',
      current: '1:4.1.2-1build1',
    })
    expect(
      parseAptUpgradable('foo/noble-security 2.0 amd64 [upgradable from: 1.0]')[0]?.security,
    ).toBe(true)
  })

  it('lee la tabla de winget, con nombres con espacios y versiones raras', () => {
    const rows = parseWingetUpgrade(fixture('winget-upgrade.txt'))
    expect(rows).toHaveLength(11)
    expect(rows[0]).toEqual({
      name: 'Docker Desktop',
      id: 'Docker.DockerDesktop',
      current: '4.74.0',
      available: '4.93.0',
    })
    expect(rows.find((r) => r.id === 'Ejemplo.AppDesconocida')?.current).toBe('< 5.2.0')
    expect(rows.find((r) => r.id === 'Microsoft.WSL')?.available).toBe('2.7.13')
  })

  it('tolera restos de la animación de carga antes del encabezado', () => {
    const lines = fixture('winget-upgrade.txt').split('\n')
    lines[0] = `  - \\ | ${lines[0]}` // solo el encabezado trae basura; las filas no
    const rows = parseWingetUpgrade(lines.join('\n'))
    expect(rows).toHaveLength(11)
    expect(rows[0]).toMatchObject({ name: 'Docker Desktop', id: 'Docker.DockerDesktop' })
  })

  it('devuelve vacío si no hay tabla', () => {
    expect(parseWingetUpgrade('No installed package found matching input criteria.')).toEqual([])
  })
})
