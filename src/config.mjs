import os from 'node:os'
import path from 'node:path'

export const DEFAULT_ISSUER = 'https://sparkles-editor.com'
export const DEFAULT_CLIENT_ID = 'sparkles-image-mcp'
export const DEFAULT_SCOPE = 'images:generate images:read account:read'

const trim = (value) => String(value || '').replace(/\/+$/, '')

export function config(env = process.env) {
  const issuer = trim(env.SPARKLES_ISSUER || DEFAULT_ISSUER)
  const defaultBase = `${issuer}/api/mcp`
  return {
    issuer,
    apiBase: trim(env.SPARKLES_API_BASE || defaultBase),
    resource: trim(env.SPARKLES_RESOURCE || defaultBase),
    clientId: env.SPARKLES_CLIENT_ID || DEFAULT_CLIENT_ID,
    scope: env.SPARKLES_SCOPE || DEFAULT_SCOPE,
    configDir: env.SPARKLES_CONFIG_DIR
      || path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'sparkles-image-mcp'),
    accessClientId: env.SPARKLES_ACCESS_CLIENT_ID || '',
    accessClientSecret: env.SPARKLES_ACCESS_CLIENT_SECRET || '',
    accessCookie: env.SPARKLES_ACCESS_COOKIE || ''
  }
}

/**
 * Optional Cloudflare Access headers for private/staging deployments.
 * The cookie form is for local verification only and is never printed.
 */
export function accessHeaders(cfg) {
  const headers = {}
  if (cfg.accessClientId && cfg.accessClientSecret) {
    headers['CF-Access-Client-Id'] = cfg.accessClientId
    headers['CF-Access-Client-Secret'] = cfg.accessClientSecret
  }
  if (cfg.accessCookie) {
    headers.Cookie = /^CF_Authorization=/.test(cfg.accessCookie)
      ? cfg.accessCookie
      : `CF_Authorization=${cfg.accessCookie}`
  }
  return headers
}

export function endpoints(cfg) {
  return {
    authorization: `${cfg.issuer}/oauth/authorize`,
    token: `${cfg.issuer}/api/oauth/token`,
    revoke: `${cfg.issuer}/api/oauth/revoke`,
    metadata: `${cfg.issuer}/.well-known/oauth-authorization-server`
  }
}
