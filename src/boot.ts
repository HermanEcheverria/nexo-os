import { agents } from './agents'
import { loadConfig, PATHS, type Config } from './config'
import { openDatabase } from './kernel/db/client'
import { Kernel } from './kernel/kernel'
import { PrivacyGuard } from './kernel/privacy'
import { tools } from './tools'
import { hasWindows } from './tools/shell'
import { windowsInfo } from './tools/windows'

/** Arma el sistema: configuración, privacidad, base de datos y núcleo. */
export async function boot(config: Config = loadConfig()) {
  const windows = (await hasWindows()) ? await windowsInfo() : null
  const env = windows
    ? { USERPROFILE: windows.userProfile, OneDrive: windows.oneDrive ?? undefined }
    : {}
  const privacy = new PrivacyGuard(config.forbidden, config.privateMarker, env)
  const database = await openDatabase(PATHS.data)
  const kernel = new Kernel(database.db, agents, tools, config, privacy)
  return { config, privacy, database, kernel, windows }
}
