import os from 'node:os'
import path from 'node:path'

export const DEFAULT_ISSUER = 'https://sparkles-editor.com'
export const DEFAULT_CLIENT_ID = 'sparkles-image-mcp'
export const DEFAULT_SCOPE = 'images:generate images:read account:read'
// The package is distributed from the public GitHub repository. Keep every
// user-facing command on this one spec so it cannot drift back to a stale npm
// package name.
export const INSTALL_SPEC = 'github:sparkles-mcp/sparkles-image-mcp'
export const CLI = `npx -y ${INSTALL_SPEC}`

const trim = (value) => String(value || '').replace(/\/+$/, '')

const isLoopback = (hostname) =>
  hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1'

function absoluteOrigin(value, label) {
  let url
  try {
    url = new URL(value)
  } catch {
    throw new Error(`${label} must be an absolute URL.`)
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:')
    throw new Error(`${label} must use HTTPS.`)
  if (url.protocol !== 'https:' && !isLoopback(url.hostname))
    throw new Error(`${label} must use HTTPS unless it points at localhost.`)
  return url
}

export function config(env = process.env) {
  const issuer = trim(env.SPARKLES_ISSUER || DEFAULT_ISSUER)
  const defaultBase = `${issuer}/api/mcp`
  const apiBase = trim(env.SPARKLES_API_BASE || defaultBase)
  const issuerUrl = absoluteOrigin(issuer, 'SPARKLES_ISSUER')
  const apiUrl = absoluteOrigin(apiBase, 'SPARKLES_API_BASE')
  // Credentials and Cloudflare Access secrets are sent to apiBase. Never let a
  // stray environment override forward them to another origin; staging tests
  // that deliberately target a separate Core host must opt in explicitly.
  if (apiUrl.origin !== issuerUrl.origin && env.SPARKLES_ALLOW_CROSS_ORIGIN !== '1')
    throw new Error('SPARKLES_API_BASE must share the SPARKLES_ISSUER origin. Set SPARKLES_ALLOW_CROSS_ORIGIN=1 only for isolated staging tests.')
  return {
    issuer,
    apiBase,
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
