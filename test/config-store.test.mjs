import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { accessHeaders, config, DEFAULT_CLIENT_ID, DEFAULT_ISSUER } from '../src/config.mjs'
import { clearCredentials, credentialsFile, loadCredentials, saveCredentials } from '../src/store.mjs'
import { pkce } from '../src/oauth.mjs'

test('config uses production defaults', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sparkles-cfg-'))
  const cfg = config({ XDG_CONFIG_HOME: home })
  assert.equal(cfg.issuer, DEFAULT_ISSUER)
  assert.equal(cfg.apiBase, `${DEFAULT_ISSUER}/api/mcp`)
  assert.equal(cfg.resource, `${DEFAULT_ISSUER}/api/mcp`)
  assert.equal(cfg.clientId, DEFAULT_CLIENT_ID)
  assert.equal(cfg.configDir, path.join(home, 'sparkles-image-mcp'))
  fs.rmSync(home, { recursive: true, force: true })
})

test('config accepts a staging override and strips trailing slashes', () => {
  const cfg = config({
    SPARKLES_ISSUER: 'https://t-d.example.com/',
    SPARKLES_API_BASE: 'https://core-t-d.example.com/api/',
    SPARKLES_CONFIG_DIR: '/tmp/sparkles-test',
    SPARKLES_SCOPE: 'images:generate'
  })
  assert.equal(cfg.issuer, 'https://t-d.example.com')
  assert.equal(cfg.apiBase, 'https://core-t-d.example.com/api')
  assert.equal(cfg.resource, 'https://t-d.example.com/api/mcp')
  assert.equal(cfg.configDir, '/tmp/sparkles-test')
  assert.equal(cfg.scope, 'images:generate')
})

test('accessHeaders never invents credentials and prefixes a raw cookie', () => {
  assert.deepEqual(accessHeaders(config({ SPARKLES_CONFIG_DIR: '/tmp/x' })), {})
  const service = accessHeaders(config({
    SPARKLES_CONFIG_DIR: '/tmp/x',
    SPARKLES_ACCESS_CLIENT_ID: 'client-id',
    SPARKLES_ACCESS_CLIENT_SECRET: 'client-secret'
  }))
  assert.equal(service['CF-Access-Client-Id'], 'client-id')
  assert.equal(service['CF-Access-Client-Secret'], 'client-secret')
  assert.equal(accessHeaders(config({ SPARKLES_CONFIG_DIR: '/tmp/x', SPARKLES_ACCESS_COOKIE: 'raw-value' })).Cookie, 'CF_Authorization=raw-value')
  assert.equal(accessHeaders(config({ SPARKLES_CONFIG_DIR: '/tmp/x', SPARKLES_ACCESS_COOKIE: 'CF_Authorization=full' })).Cookie, 'CF_Authorization=full')
})

test('credentials are written with owner-only permissions and can be cleared', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sparkles-store-'))
  const cfg = config({ SPARKLES_CONFIG_DIR: directory })
  saveCredentials(cfg, {
    version: 1,
    accessToken: 'access',
    refreshToken: 'refresh',
    expiresAt: 123456,
    scope: 'images:read'
  })
  const file = credentialsFile(cfg)
  assert.equal(loadCredentials(cfg).accessToken, 'access')
  if (process.platform !== 'win32')
    assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  clearCredentials(cfg)
  assert.equal(loadCredentials(cfg), null)
  clearCredentials(cfg)
  fs.rmSync(directory, { recursive: true, force: true })
})

test('invalid credential files are ignored', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sparkles-store-'))
  const cfg = config({ SPARKLES_CONFIG_DIR: directory })
  fs.writeFileSync(credentialsFile(cfg), '{"version":2}')
  assert.equal(loadCredentials(cfg), null)
  fs.writeFileSync(credentialsFile(cfg), 'not json')
  assert.equal(loadCredentials(cfg), null)
  fs.rmSync(directory, { recursive: true, force: true })
})

test('pkce uses a 43-character verifier and an S256 challenge', () => {
  const { verifier, challenge } = pkce()
  assert.match(verifier, /^[A-Za-z0-9_-]{43}$/)
  assert.equal(
    challenge,
    crypto.createHash('sha256').update(verifier).digest('base64url')
  )
  assert.notEqual(pkce().verifier, verifier)
})
