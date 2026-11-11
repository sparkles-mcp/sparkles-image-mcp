import fs from 'node:fs'
import path from 'node:path'

export const credentialsFile = (cfg) =>
  path.join(cfg.configDir, 'credentials.json')

const lockFile = (cfg) => path.join(cfg.configDir, 'credentials.lock')
const LOCK_STALE_MS = 30_000
const LOCK_WAIT_MS = 15_000

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export function loadCredentials(cfg) {
  try {
    const value = JSON.parse(fs.readFileSync(credentialsFile(cfg), 'utf8'))
    if (
      !value || value.version !== 1
      || typeof value.accessToken !== 'string'
      || typeof value.expiresAt !== 'number'
      || (value.refreshToken !== undefined && typeof value.refreshToken !== 'string')
    ) return null
    // Never send credentials to an origin or OAuth client they were not issued
    // for. Changing SPARKLES_ISSUER/SPARKLES_CLIENT_ID requires a fresh login.
    if (value.issuer !== cfg.issuer || value.clientId !== cfg.clientId) return null
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

/**
 * Serialize rotating refresh-token use across processes. Without this, two MCP
 * clients sharing one config directory present the same refresh token, the
 * authorization server's reuse detection revokes the grant, and both clients
 * are signed out.
 */
export async function withCredentialsLock(cfg, fn) {
  fs.mkdirSync(cfg.configDir, { recursive: true, mode: 0o700 })
  const target = lockFile(cfg)
  const deadline = Date.now() + LOCK_WAIT_MS
  while (true) {
    let descriptor
    try {
      descriptor = fs.openSync(target, 'wx', 0o600)
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      try {
        if (Date.now() - fs.statSync(target).mtimeMs > LOCK_STALE_MS) {
          fs.unlinkSync(target)
          continue
        }
      } catch {
        continue
      }
      if (Date.now() > deadline)
        throw new Error('The Sparkles credential file is locked by another process. Try again.')
      await sleep(50)
      continue
    }
    try {
      return await fn()
    } finally {
      try { fs.closeSync(descriptor) } catch {}
      try { fs.unlinkSync(target) } catch {}
    }
  }
}

