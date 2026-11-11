import crypto from 'node:crypto'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { accessHeaders, endpoints } from './config.mjs'
import { clearCredentials, saveCredentials } from './store.mjs'

export class AuthError extends Error {
  constructor(message, code = 'login_required') {
    super(message)
    this.name = 'AuthError'
    this.code = code
  }
}

export class OAuthError extends Error {
  constructor(message, code = 'oauth_error') {
    super(message)
    this.name = 'OAuthError'
    this.code = code
  }
}

const redirectStatuses = new Set([301, 302, 303, 307, 308])

async function siteFetch(cfg, url, options = {}, timeout = 15000) {
  const response = await fetch(url, {
    ...options,
    redirect: 'manual',
    signal: AbortSignal.timeout(timeout)
  })
  if (redirectStatuses.has(response.status)) {
    await response.body?.cancel()
    throw new AuthError(
      'Sparkles is behind Cloudflare Access. Configure SPARKLES_ACCESS_CLIENT_ID and SPARKLES_ACCESS_CLIENT_SECRET, or use an environment without Access.',
      'access_blocked'
    )
  }
  return response
}

export function pkce() {
  const verifier = crypto.randomBytes(32).toString('base64url')
  return {
    verifier,
    challenge: crypto.createHash('sha256').update(verifier).digest('base64url')
  }
}

export const randomState = () => crypto.randomBytes(32).toString('base64url')

export async function discover(cfg) {
  const fallback = {
    authorization_endpoint: endpoints(cfg).authorization,
    token_endpoint: endpoints(cfg).token,
    revocation_endpoint: endpoints(cfg).revoke
  }
  let data
  try {
    const response = await siteFetch(cfg, endpoints(cfg).metadata, {
      headers: { Accept: 'application/json', ...accessHeaders(cfg) }
    }, 10000)
    if (response.ok) data = await response.json()
    else await response.body?.cancel()
  } catch (error) {
    if (error instanceof AuthError && error.code === 'access_blocked') throw error
  }
  if (!data?.authorization_endpoint || !data?.token_endpoint) return fallback
  const origin = new URL(cfg.issuer).origin
  for (const endpoint of [data.authorization_endpoint, data.token_endpoint, data.revocation_endpoint]) {
    if (endpoint && new URL(endpoint).origin !== origin)
      throw new AuthError('The authorization server metadata points to an unexpected origin.', 'invalid_metadata')
  }
  return { ...fallback, ...data }
}

export function startCallbackServer(state) {
  return new Promise((resolve, reject) => {
    let settled = false
    let timer
    let settleResolve
    let settleReject
    const result = new Promise((done, fail) => {
      settleResolve = done
      settleReject = fail
    })
    const stop = (error) => {
      if (settled) return false
      settled = true
      clearTimeout(timer)
      if (error) settleReject(error)
      return true
    }
    const server = http.createServer((request, response) => {
      const url = new URL(request.url || '/', 'http://127.0.0.1')
      if (url.pathname !== '/callback') {
        response.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found')
        return
      }
      if (settled) {
        response.writeHead(409, { 'Content-Type': 'text/plain' }).end('Already completed')
        return
      }
      if (url.searchParams.get('state') !== state) {
        response.writeHead(400, { 'Content-Type': 'text/plain' }).end('Invalid state')
        return
      }
      const finish = (message, status) => {
        response.writeHead(status, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'Referrer-Policy': 'no-referrer'
        })
        response.end(`<!doctype html><meta charset="utf-8"><title>Sparkles Image MCP</title><body style="font:16px system-ui;padding:40px;max-width:560px;margin:auto"><p>${message}</p></body>`)
      }
      const error = url.searchParams.get('error')
      const code = url.searchParams.get('code')
      if (error) {
        finish('Authorization was not completed. You can close this window.', 400)
        stop(new OAuthError(
          url.searchParams.get('error_description') || 'Authorization was cancelled.',
          error
        ))
        server.close()
        return
      }
      if (!code) {
        finish('The authorization response is missing a code.', 400)
        return
      }
      finish('Login complete. You can close this window and return to your agent.', 200)
      stop()
      settleResolve(url)
      server.close()
    })
    server.on('error', (error) => {
      reject(error)
      stop(error)
      server.close()
    })
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close()
        reject(new AuthError('Could not start the local login callback.', 'callback_failed'))
        return
      }
      const redirectUri = `http://127.0.0.1:${address.port}/callback`
      timer = setTimeout(() => {
        if (!stop(new AuthError('Login timed out. Run `npx sparkles-image-mcp login` again.', 'login_timeout')))
          return
        server.close()
      }, 5 * 60 * 1000)
      timer.unref()
      resolve({
        redirectUri,
        wait: result,
        close: () => {
          stop()
          server.close()
        }
      })
    })
  })
}

export function openUrl(url) {
  const [command, args] = process.platform === 'darwin'
    ? ['open', [url]]
    : process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', url]]
      : ['xdg-open', [url]]
  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true })
    child.on('error', () => {})
    child.unref()
    return true
  } catch {
    return false
  }
}

async function postToken(cfg, body) {
  const response = await siteFetch(cfg, endpoints(cfg).token, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json',
      ...accessHeaders(cfg)
    },
    body: body.toString()
  })
  let data
  try {
    data = await response.json()
  } catch {
    data = null
  }
  if (!response.ok || !data?.access_token) {
    throw new OAuthError(
      data?.error_description || `The Sparkles token endpoint returned HTTP ${response.status}.`,
      data?.error || `http_${response.status}`
    )
  }
  return data
}

const credentialsFrom = (cfg, data, previous = {}) => ({
  version: 1,
  issuer: cfg.issuer,
  clientId: cfg.clientId,
  accessToken: data.access_token,
  refreshToken: data.refresh_token || previous.refreshToken || '',
  expiresAt: Date.now() + (Number(data.expires_in) || 900) * 1000,
  scope: data.scope || previous.scope || cfg.scope,
  createdAt: previous.createdAt || Date.now()
})

export async function login(cfg, { openBrowser = true, log = console.log } = {}) {
  const metadata = await discover(cfg)
  const { verifier, challenge } = pkce()
  const state = randomState()
  const callback = await startCallbackServer(state)
  try {
    const url = new URL(metadata.authorization_endpoint)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('client_id', cfg.clientId)
    url.searchParams.set('redirect_uri', callback.redirectUri)
    url.searchParams.set('scope', cfg.scope)
    url.searchParams.set('state', state)
    url.searchParams.set('code_challenge', challenge)
    url.searchParams.set('code_challenge_method', 'S256')
    url.searchParams.set('resource', cfg.resource)
    log('Opening the Sparkles authorization page...')
    if (!openBrowser || !openUrl(url.toString()))
      log(`Open this URL to continue:\n${url.toString()}`)
    log('Waiting for authorization...')
    const result = await callback.wait
    const code = result.searchParams.get('code') || ''
    const data = await postToken(cfg, new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: cfg.clientId,
      code,
      redirect_uri: callback.redirectUri,
      code_verifier: verifier,
      resource: cfg.resource
    }))
    const credentials = credentialsFrom(cfg, data)
    saveCredentials(cfg, credentials)
    return credentials
  } finally {
    callback.close()
  }
}

export async function refresh(cfg, credentials) {
  if (!credentials.refreshToken)
    throw new AuthError('Login required. Run `npx sparkles-image-mcp login`.', 'login_required')
  let data
  try {
    data = await postToken(cfg, new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: cfg.clientId,
      refresh_token: credentials.refreshToken,
      resource: cfg.resource
    }))
  } catch (error) {
    if (error instanceof OAuthError && error.code === 'invalid_grant') {
      clearCredentials(cfg)
      throw new AuthError('The Sparkles login has expired. Run `npx sparkles-image-mcp login` again.', 'login_expired')
    }
    throw error
  }
  const next = credentialsFrom(cfg, data, credentials)
  saveCredentials(cfg, next)
  return next
}

export async function currentAccessToken(cfg, credentials, { force = false } = {}) {
  if (!force && credentials.accessToken && credentials.expiresAt > Date.now() + 60_000)
    return credentials
  return refresh(cfg, credentials)
}

export async function revoke(cfg, credentials) {
  if (credentials?.refreshToken) {
    try {
      const response = await siteFetch(cfg, endpoints(cfg).revoke, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          ...accessHeaders(cfg)
        },
        body: new URLSearchParams({
          token: credentials.refreshToken,
          token_type_hint: 'refresh_token',
          client_id: cfg.clientId
        }).toString()
      })
      await response.body?.cancel()
    } catch {
      // Local logout must still succeed when the network is unavailable.
    }
  }
  clearCredentials(cfg)
}
