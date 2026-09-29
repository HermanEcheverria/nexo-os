import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { normalizePath, PrivacyGuard } from '../src/kernel/privacy'

const env = { USERPROFILE: 'C:\\Users\\usuario', OneDrive: 'C:\\Users\\usuario\\OneDrive' }

describe('Privacidad', () => {
  it('normaliza rutas de Windows y de WSL a la misma forma', () => {
    expect(normalizePath('/mnt/c/Users/usuario/Pictures', env)).toBe('c:\\users\\usuario\\pictures')
    expect(normalizePath('C:/Users/Usuario/Pictures/', env)).toBe('c:\\users\\usuario\\pictures')
    expect(normalizePath('%OneDrive%\\Imágenes', env)).toBe(
      'c:\\users\\usuario\\onedrive\\imágenes',
    )
  })

  it('protege las zonas prohibidas y todo lo que hay dentro, sin falsos positivos', () => {
    const guard = new PrivacyGuard(
      ['%USERPROFILE%\\Pictures', '%OneDrive%\\UNIS'],
      '.nexo-privado',
      env,
    )
    expect(guard.isForbidden('/mnt/c/Users/usuario/Pictures/viaje/foto.jpg')).toBe(true)
    expect(guard.isForbidden('C:\\Users\\usuario\\OneDrive\\UNIS')).toBe(true)
    // "Pictures2" empieza igual pero no está dentro de la zona
    expect(guard.isForbidden('C:\\Users\\usuario\\Pictures2')).toBe(false)
    expect(guard.isForbidden('C:\\Users\\usuario\\Downloads')).toBe(false)
  })

  it('descarta zonas con variables que no existen en esta PC', () => {
    const guard = new PrivacyGuard(['%OneDrive%\\Pictures'], '.nexo-privado', {})
    expect(guard.windowsZones).toEqual([])
  })

  it('respeta el archivo marcador en cualquier carpeta de WSL', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nexo-'))
    const guard = new PrivacyGuard([], '.nexo-privado')
    expect(guard.isForbidden(dir)).toBe(false)
    writeFileSync(join(dir, '.nexo-privado'), '')
    expect(guard.isForbidden(dir)).toBe(true)
  })
})
