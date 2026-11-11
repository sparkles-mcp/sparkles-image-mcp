import fs from 'node:fs'
import path from 'node:path'

export const credentialsFile = (cfg) =>
  path.join(cfg.configDir, 'credentials.json')

export function loadCredentials(cfg) {
  try {
    const value = JSON.parse(fs.readFileSync(credentialsFile(cfg), 'utf8'))
    if (
      !value || value.version !== 1
      || typeof value.accessToken !== 'string'
      || typeof value.expiresAt !== 'number'
      || (value.refreshToken !== undefined && typeof value.refreshToken !== 'string')
    ) return null
    return value
  } catch {
    return null
  }
}

export function saveCredentials(cfg, value) {
  fs.mkdirSync(cfg.configDir, { recursive: true, mode: 0o700 })
  const target = credentialsFile(cfg)
  const temporary = `${target}.${process.pid}.tmp`
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  fs.renameSync(temporary, target)
  try {
    fs.chmodSync(target, 0o600)
  } catch {
    // chmod is unavailable on some Windows filesystems; the file still works.
  }
}

export function clearCredentials(cfg) {
  try {
    fs.unlinkSync(credentialsFile(cfg))
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
}
