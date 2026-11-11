import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { ApiClient, ApiError } from '../src/api.mjs'
import { config } from '../src/config.mjs'
import { JOB_ID, JOB_ID_2, PNG_1X1, startFakeServer } from './helpers.mjs'

function setup(server, directory, credentials = {}) {
  const cfg = config({
    SPARKLES_ISSUER: server.origin,
    SPARKLES_API_BASE: `${server.origin}/api/mcp`,
    SPARKLES_CONFIG_DIR: directory
  })
  const creds = {
    version: 1,
    accessToken: 'token-1',
    refreshToken: 'r1',
    expiresAt: Date.now() + 3600_000,
    scope: 'images:generate images:read account:read',
    ...credentials
  }
  return { cfg, client: new ApiClient(cfg, creds) }
}

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sparkles-api-'))

test('generate resolves the catalog version, price, and default model', async () => {
  const server = await startFakeServer({ ids: [JOB_ID, JOB_ID_2] })
  const directory = tempDir()
  try {
    const { client } = setup(server, directory)
    const result = await client.generate({
      prompt: 'A red fox in fresh snow, soft morning light',
      count: 2,
      requestId: JOB_ID
    })
    assert.deepEqual(result.ids, [JOB_ID, JOB_ID_2])
    assert.equal(result.model, 'gpt-image-2.6-sunburst')
    assert.equal(result.quality, 'auto')
    const request = server.state.requests.find((entry) => entry.method === 'POST' && entry.path === '/api/mcp/images/jobs')
    assert.equal(request.body.requestId, JOB_ID)
    assert.equal(request.body.count, 2)
    assert.equal(request.body.providerVersion, 7)
    assert.equal(request.body.expectedCredits, 0)
    assert.equal(request.body.format, 'png')
    assert.equal(request.body.size, 'auto')
  } finally {
    await server.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('generate rejects unknown models and unsupported qualities before submitting', async () => {
  const server = await startFakeServer()
  const directory = tempDir()
  try {
    const { client } = setup(server, directory)
    await assert.rejects(client.generate({ prompt: 'A fox', model: 'no-such-model', requestId: JOB_ID }), (error) => {
      assert.ok(error instanceof ApiError)
      assert.equal(error.code, 'invalid_model')
      return true
    })
    await assert.rejects(client.generate({
      prompt: 'A fox',
      model: 'gpt-image-5-legacy',
      quality: 'xhigh',
      requestId: JOB_ID
    }), (error) => {
      assert.equal(error.code, 'invalid_quality')
      return true
    })
    assert.equal(server.state.requests.filter((entry) => entry.method === 'POST').length, 0)
  } finally {
    await server.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('generate rejects a GIF batch', async () => {
  const server = await startFakeServer()
  const directory = tempDir()
  try {
    const { client } = setup(server, directory)
    await assert.rejects(
      client.generate({ prompt: 'A bouncing ball', format: 'gif', count: 2, requestId: JOB_ID }),
      (error) => error.code === 'invalid_request'
    )
  } finally {
    await server.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('generate sends GIF frame options', async () => {
  const server = await startFakeServer()
  const directory = tempDir()
  try {
    const { client } = setup(server, directory)
    await client.generate({
      prompt: 'A bouncing ball animation',
      format: 'gif',
      frameCount: 8,
      frameDurationMs: 120,
      requestId: JOB_ID
    })
    const request = server.state.requests.find((entry) => entry.method === 'POST' && entry.path === '/api/mcp/images/jobs')
    assert.equal(request.body.format, 'gif')
    assert.equal(request.body.frameCount, 8)
    assert.equal(request.body.frameDurationMs, 120)
  } finally {
    await server.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('image downloads the original bytes', async () => {
  const server = await startFakeServer()
  const directory = tempDir()
  try {
    const { client } = setup(server, directory)
    const image = await client.image(JOB_ID)
    assert.equal(image.original, true)
    assert.equal(image.mimeType, 'image/png')
    assert.deepEqual(Buffer.from(image.data, 'base64'), PNG_1X1)
  } finally {
    await server.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('image falls back to the preview when the original is unavailable', async () => {
  const server = await startFakeServer({ original404: true })
  const directory = tempDir()
  try {
    const { client } = setup(server, directory)
    const image = await client.image(JOB_ID)
    assert.equal(image.original, false)
    const previews = server.state.requests.filter((entry) => entry.path.endsWith('/preview'))
    assert.equal(previews.length, 2)
    assert.equal(previews[0].query.original, '1')
    assert.equal(previews[1].query.original, undefined)
  } finally {
    await server.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('image rejects a non-image response', async () => {
  const server = await startFakeServer({ previewMime: 'application/json', previewBytes: Buffer.from('{"message":"no"}') })
  const directory = tempDir()
  try {
    const { client } = setup(server, directory)
    await assert.rejects(client.image(JOB_ID), (error) => {
      assert.ok(error instanceof ApiError)
      assert.equal(error.code, 'invalid_image')
      return true
    })
  } finally {
    await server.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('a 401 refreshes the access token and retries once', async () => {
  const server = await startFakeServer()
  const directory = tempDir()
  try {
    const { client } = setup(server, directory, { accessToken: 'expired' })
    const wallet = await client.wallet()
    assert.equal(wallet.balance, 1234)
    assert.equal(client.credentials.accessToken, 'refreshed-token')
    assert.equal(client.credentials.refreshToken, 'r2')
    const tokenRequests = server.state.requests.filter((entry) => entry.path === '/api/oauth/token')
    assert.equal(tokenRequests.length, 1)
    assert.match(tokenRequests[0].raw, /grant_type=refresh_token/)
  } finally {
    await server.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('concurrent 401 responses share a single refresh request', async () => {
  const server = await startFakeServer()
  const directory = tempDir()
  try {
    const { client } = setup(server, directory, { accessToken: 'expired' })
    const [wallet, catalog] = await Promise.all([client.wallet(), client.catalog()])
    assert.equal(wallet.balance, 1234)
    assert.equal(catalog.ready, true)
    const tokenRequests = server.state.requests.filter((entry) => entry.path === '/api/oauth/token')
    assert.equal(tokenRequests.length, 1)
    assert.equal(client.credentials.refreshToken, 'r2')
  } finally {
    await server.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('API errors preserve status, code, and retry-after', async () => {
  const server = await startFakeServer({
    failures: {
      'images/jobs': {
        status: 429,
        headers: { 'Retry-After': '7' },
        body: { message: 'Too many requests.' }
      }
    }
  })
  const directory = tempDir()
  try {
    const { client } = setup(server, directory)
    await assert.rejects(client.generate({ prompt: 'A fox', requestId: JOB_ID }), (error) => {
      assert.ok(error instanceof ApiError)
      assert.equal(error.status, 429)
      assert.equal(error.code, 'rate_limited')
      assert.equal(error.retryAfter, 7)
      assert.match(error.message, /Too many requests/)
      return true
    })
  } finally {
    await server.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('status, list, cancel, wallet, and usage map the public API', async () => {
  const server = await startFakeServer({ list: [{ id: JOB_ID, status: 'completed', format: 'png' }] })
  const directory = tempDir()
  try {
    const { client } = setup(server, directory)
    const statuses = await client.statuses([JOB_ID, JOB_ID])
    assert.equal(statuses.jobs.length, 1)
    const list = await client.listJobs({ limit: 5, view: 'artwork' })
    assert.equal(list.jobs[0].id, JOB_ID)
    const canceled = await client.cancel({ ids: [JOB_ID] })
    assert.deepEqual(canceled.jobs, [])
    const wallet = await client.wallet()
    assert.equal(wallet.subscriptionBalance, 234)
    const usage = await client.usage({ page: 1, pageSize: 10 })
    assert.equal(usage.entries[0].delta, -12)
    await assert.rejects(client.statuses(['not-a-uuid']), (error) => error.code === 'invalid_request')
  } finally {
    await server.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
