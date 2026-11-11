import crypto from 'node:crypto'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { CLI, accessHeaders, endpoints } from './config.mjs'
import { clearCredentials, loadCredentials, saveCredentials, withCredentialsLock } from './store.mjs'
import { readCapped } from './read.mjs'

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
const MAX_OAUTH_BYTES = 512 * 1024

async function siteFetch(cfg, url, options = {}, timeout = 15000) {
  const timer = AbortSignal.timeout(timeout)
  const signal = options.signal ? AbortSignal.any([options.signal, timer]) : timer
  const response = await fetch(url, {
    ...options,
    redirect: 'manual',
    signal
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

export async function discover(cfg, { signal } = {}) {
  const fallback = {
    issuer: cfg.issuer,
    authorization_endpoint: endpoints(cfg).authorization,
    token_endpoint: endpoints(cfg).token,
    revocation_endpoint: endpoints(cfg).revoke
  }
  let data
  try {
    const response = await siteFetch(cfg, endpoints(cfg).metadata, {
      headers: { Accept: 'application/json', ...accessHeaders(cfg) },
      signal
    }, 10000)
    if (response.ok) {
      const { buffer, tooLarge } = await readCapped(response, MAX_OAUTH_BYTES)
      if (!tooLarge) {
        try {
          data = JSON.parse(buffer.toString('utf8'))
        } catch {
          data = null
        }
      }
    } else {
      await response.body?.cancel()
    }
  } catch (error) {
    if (signal?.aborted)
      throw new AuthError('The call was cancelled.', 'cancelled')
    if (error instanceof AuthError && error.code === 'access_blocked') throw error
  }
  if (!data?.authorization_endpoint || !data?.token_endpoint) return fallback
  if (data.issuer && data.issuer !== cfg.issuer)
    throw new AuthError('The authorization server metadata names an unexpected issuer.', 'invalid_metadata')
  const origin = new URL(cfg.issuer).origin
  for (const endpoint of [data.authorization_endpoint, data.token_endpoint, data.revocation_endpoint]) {
    if (endpoint && new URL(endpoint).origin !== origin)
      throw new AuthError('The authorization server metadata points to an unexpected origin.', 'invalid_metadata')
  }
  return { ...fallback, ...data }
}

export function startCallbackServer(state, { issuer, requireIssuer = false, signal } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false
    let timer
    let settleResolve
    let settleReject
    const result = new Promise((done, fail) => {
      settleResolve = done
      settleReject = fail
    })
    // The listener error path may settle this before login() awaits it.
    result.catch(() => {})
    const onAbort = () => {
      stop(new AuthError('The call was cancelled.', 'cancelled'))
      server.close()
    }
    const stop = (error) => {
      if (settled) return false
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
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
      const returnedIssuer = url.searchParams.get('iss')
      if (issuer && (requireIssuer || returnedIssuer) && returnedIssuer !== issuer) {
        response.writeHead(400, { 'Content-Type': 'text/plain' }).end('Invalid issuer')
        stop(new OAuthError('The authorization response came from an unexpected issuer.', 'invalid_issuer'))
        server.close()
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
    if (signal?.aborted) {
      server.close()
      reject(new AuthError('The call was cancelled.', 'cancelled'))
      return
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close()
        reject(new AuthError('Could not start the local login callback.', 'callback_failed'))
        return
      }
      const redirectUri = `http://127.0.0.1:${address.port}/callback`
      timer = setTimeout(() => {
        if (!stop(new AuthError(`Login timed out. Run \`${CLI} login\` again.`, 'login_timeout')))
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
      // Avoid cmd.exe, which reparses '&' in the authorization URL.
      ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
      : ['xdg-open', [url]]
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(command, args, { stdio: 'ignore', detached: true })
    } catch {
      resolve(false)
      return
    }
    let settled = false
    child.once('error', () => {
      if (settled) return
      settled = true
      resolve(false)
    })
    child.once('spawn', () => {
      if (settled) return
      settled = true
      child.unref()
      resolve(true)
    })
  })
}

async function postToken(cfg, body, { signal, metadata } = {}) {
  const endpoint = metadata?.token_endpoint || endpoints(cfg).token
  const response = await siteFetch(cfg, endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json',
      ...accessHeaders(cfg)
    },
    body: body.toString(),
    signal
  })
  const { buffer, tooLarge } = await readCapped(response, MAX_OAUTH_BYTES)
  let data = null
  if (!tooLarge) {
    try {
      data = JSON.parse(buffer.toString('utf8'))
    } catch {
      data = null
    }
  }
  if (!response.ok || !data?.access_token) {
    throw new OAuthError(
      data?.error_description || `The Sparkles token endpoint returned HTTP ${response.status}.`,
      data?.error || `http_${response.status}`
    )
  }
  return data
}

const credentialsFrom = (cfg, data, previous = {}, metadata) => ({
  version: 1,
  issuer: cfg.issuer,
  clientId: cfg.clientId,
  accessToken: data.access_token,
  refreshToken: data.refresh_token || previous.refreshToken || '',
  expiresAt: Date.now() + (Number(data.expires_in) || 900) * 1000,
  scope: data.scope || previous.scope || cfg.scope,
  createdAt: previous.createdAt || Date.now(),
  tokenEndpoint: metadata?.token_endpoint || previous.tokenEndpoint,
  revocationEndpoint: metadata?.revocation_endpoint || previous.revocationEndpoint
})

export async function login(cfg, { openBrowser = true, log = console.log, signal } = {}) {
  const metadata = await discover(cfg, { signal })
  const { verifier, challenge } = pkce()
  const state = randomState()
  const callback = await startCallbackServer(state, {
    issuer: metadata.issuer || cfg.issuer,
    requireIssuer: metadata.authorization_response_iss_parameter_supported === true,
    signal
  })
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
    if (!openBrowser || !(await openUrl(url.toString())))
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
    }), { signal, metadata })
    const credentials = credentialsFrom(cfg, data, {}, metadata)
    saveCredentials(cfg, credentials)
    return credentials
  } finally {
    callback.close()
  }
}

export async function refresh(cfg, credentials, { signal } = {}) {
  if (!credentials.refreshToken)
    throw new AuthError(`Login required. Run \`${CLI} login\`.`, 'login_required')
  return withCredentialsLock(cfg, async () => {
    const stored = loadCredentials(cfg)
    // Another process may have rotated the token while we waited for the lock.
    if (stored?.refreshToken && stored.refreshToken !== credentials.refreshToken)
      return stored
    const metadata = await discover(cfg, { signal })
    let data
    try {
      data = await postToken(cfg, new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: cfg.clientId,
        refresh_token: credentials.refreshToken,
        resource: cfg.resource
      }), { signal, metadata })
    } catch (error) {
      if (error instanceof OAuthError && error.code === 'invalid_grant') {
        const latest = loadCredentials(cfg)
        if (latest?.refreshToken && latest.refreshToken !== credentials.refreshToken)
          return latest
        clearCredentials(cfg)
        throw new AuthError(`The Sparkles login has expired. Run \`${CLI} login\` again.`, 'login_expired')
      }
      throw error
    }
    const next = credentialsFrom(cfg, data, stored || credentials, metadata)
    saveCredentials(cfg, next)
    return next
  })
}

export async function currentAccessToken(cfg, credentials, { force = false, signal } = {}) {
  if (!force && credentials.accessToken && credentials.expiresAt > Date.now() + 60_000)
    return credentials
  return refresh(cfg, credentials, { signal })
}

export async function revoke(cfg, credentials, { signal } = {}) {
  let revoked = false
  let error
  const token = credentials?.refreshToken || credentials?.accessToken
  const tokenTypeHint = credentials?.refreshToken ? 'refresh_token' : 'access_token'
  if (token) {
    try {
      const response = await siteFetch(cfg, credentials?.revocationEndpoint || endpoints(cfg).revoke, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          ...accessHeaders(cfg)
        },
        body: new URLSearchParams({
          token,
          token_type_hint: tokenTypeHint,
          client_id: cfg.clientId
        }).toString(),
        signal
      }, 10000)
      await response.body?.cancel()
      revoked = response.ok
      if (!response.ok) error = `The site returned HTTP ${response.status}.`
    } catch (caught) {
      error = caught?.message || 'The site could not be reached.'
    }
  }
  clearCredentials(cfg)
  return { revoked, error }
}
