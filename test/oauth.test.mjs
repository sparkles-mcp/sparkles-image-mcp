import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { AuthError, OAuthError, currentAccessToken, discover, login, refresh, revoke, startCallbackServer } from '../src/oauth.mjs'
import { config } from '../src/config.mjs'
import { credentialsFile, loadCredentials, saveCredentials } from '../src/store.mjs'
import { startFakeServer } from './helpers.mjs'

function cfgFor(origin, directory) {
  return config({
    SPARKLES_ISSUER: origin,
    SPARKLES_API_BASE: `${origin}/api/mcp`,
    SPARKLES_CONFIG_DIR: directory
  })
}

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sparkles-oauth-'))

test('the local callback accepts the right state and returns the code', async () => {
  const callback = await startCallbackServer('expected-state')
  try {
    const wrong = await fetch(`${callback.redirectUri}?code=abc&state=wrong`)
    assert.equal(wrong.status, 400)
    const ok = await fetch(`${callback.redirectUri}?code=abc&state=expected-state`)
    assert.equal(ok.status, 200)
    const result = await callback.wait
    assert.equal(result.searchParams.get('code'), 'abc')
  } finally {
    callback.close()
  }
})

test('the local callback reports an authorization denial', async () => {
  const callback = await startCallbackServer('state-2')
  try {
    const expectation = assert.rejects(callback.wait, (error) => {
      assert.ok(error instanceof OAuthError)
      assert.equal(error.code, 'access_denied')
      return true
    })
    const response = await fetch(`${callback.redirectUri}?error=access_denied&error_description=User%20denied&state=state-2`)
    assert.equal(response.status, 400)
    await expectation
  } finally {
    callback.close()
  }
})

test('discover falls back to the documented endpoints when metadata is unavailable', async () => {
  const server = await startFakeServer({ metadataStatus: 404 })
  const directory = tempDir()
  try {
    const metadata = await discover(cfgFor(server.origin, directory))
    assert.equal(metadata.authorization_endpoint, `${server.origin}/oauth/authorize`)
    assert.equal(metadata.token_endpoint, `${server.origin}/api/oauth/token`)
  } finally {
    await server.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('discover reports a Cloudflare Access redirect instead of hanging', async () => {
  const server = await startFakeServer({ metadataStatus: 302 })
  const directory = tempDir()
  try {
    await assert.rejects(discover(cfgFor(server.origin, directory)), (error) => {
      assert.ok(error instanceof AuthError)
      assert.equal(error.code, 'access_blocked')
      return true
    })
  } finally {
    await server.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('refresh rotates the refresh token and persists the new credentials', async () => {
  const server = await startFakeServer()
  const directory = tempDir()
  const cfg = cfgFor(server.origin, directory)
  try {
    const before = {
      version: 1,
      accessToken: 'token-1',
      refreshToken: 'r1',
      expiresAt: Date.now() + 3600_000,
      scope: 'images:read'
    }
    saveCredentials(cfg, before)
    const after = await refresh(cfg, before)
    assert.equal(after.accessToken, 'refreshed-token')
    assert.equal(after.refreshToken, 'r2')
    assert.equal(loadCredentials(cfg).accessToken, 'refreshed-token')
    const tokenRequest = server.state.requests.find((request) => request.path === '/api/oauth/token')
    assert.match(tokenRequest.raw, /grant_type=refresh_token/)
    assert.match(tokenRequest.raw, /refresh_token=r1/)
  } finally {
    await server.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('an invalid refresh token clears local credentials', async () => {
  const server = await startFakeServer({ tokenError: { error: 'invalid_grant' } })
  const directory = tempDir()
  const cfg = cfgFor(server.origin, directory)
  try {
    const before = {
      version: 1,
      accessToken: 'token-1',
      refreshToken: 'old',
      expiresAt: Date.now() + 3600_000,
      scope: 'images:read'
    }
    saveCredentials(cfg, before)
    await assert.rejects(refresh(cfg, before), (error) => {
      assert.ok(error instanceof AuthError)
      assert.equal(error.code, 'login_expired')
      return true
    })
    assert.equal(fs.existsSync(credentialsFile(cfg)), false)
  } finally {
    await server.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('a valid access token is used without a refresh round trip', async () => {
  const server = await startFakeServer()
  const directory = tempDir()
  const cfg = cfgFor(server.origin, directory)
  try {
    const credentials = {
      version: 1,
      accessToken: 'token-1',
      refreshToken: 'r1',
      expiresAt: Date.now() + 3600_000
    }
    const selected = await currentAccessToken(cfg, credentials)
    assert.equal(selected.accessToken, 'token-1')
    assert.equal(server.state.requests.filter((request) => request.path === '/api/oauth/token').length, 0)
  } finally {
    await server.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('login completes authorization code + PKCE and stores the credentials', async () => {
  const server = await startFakeServer()
  const directory = tempDir()
  const cfg = cfgFor(server.origin, directory)
  let resolveAuthorization
  const authorizationUrl = new Promise((resolve) => {
    resolveAuthorization = resolve
  })
  try {
    const pending = login(cfg, {
      openBrowser: false,
      log: (line) => {
        const match = /http:\/\/127\.0\.0\.1:\d+\/oauth\/authorize\S*/.exec(line)
        if (match && resolveAuthorization) {
          const resolve = resolveAuthorization
          resolveAuthorization = null
          resolve(match[0])
        }
      }
    })
    pending.catch(() => {})
    const url = new URL(await authorizationUrl)
    assert.equal(url.searchParams.get('response_type'), 'code')
    assert.equal(url.searchParams.get('client_id'), 'sparkles-image-mcp')
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256')
    assert.match(url.searchParams.get('code_challenge'), /^[A-Za-z0-9_-]{43}$/)
    assert.equal(url.searchParams.get('resource'), `${server.origin}/api/mcp`)
    const redirectUri = url.searchParams.get('redirect_uri')
    const state = url.searchParams.get('state')
    const callback = await fetch(`${redirectUri}?code=test-code&state=${encodeURIComponent(state)}`)
    assert.equal(callback.status, 200)
    const credentials = await pending
    assert.equal(credentials.accessToken, 'login-token')
    assert.equal(credentials.refreshToken, 'login-refresh')
    assert.equal(loadCredentials(cfg).accessToken, 'login-token')
    const token = server.state.requests.find((request) => request.path === '/api/oauth/token')
    assert.match(token.raw, /grant_type=authorization_code/)
    assert.match(token.raw, /code=test-code/)
    assert.match(token.raw, /code_verifier=[A-Za-z0-9_-]{43}/)
  } finally {
    await server.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('revoke clears local credentials even when the site is unreachable', async () => {
  const directory = tempDir()
  const cfg = cfgFor('http://127.0.0.1:1', directory)
  const credentials = {
    version: 1,
    accessToken: 'token-1',
    refreshToken: 'r1',
    expiresAt: Date.now() + 3600_000
  }
  saveCredentials(cfg, credentials)
  await revoke(cfg, credentials)
  assert.equal(fs.existsSync(credentialsFile(cfg)), false)
  fs.rmSync(directory, { recursive: true, force: true })
})
