import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { JOB_ID, PNG_1X1, startFakeServer } from './helpers.mjs'

const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const cli = path.join(packageRoot, 'src', 'cli.mjs')

const cleanEnv = () => Object.fromEntries(
  Object.entries(process.env).filter(([, value]) => typeof value === 'string')
)

test('the stdio MCP server lists tools and generates an image end to end', async () => {
  const server = await startFakeServer()
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sparkles-mcp-e2e-'))
  fs.writeFileSync(path.join(configDir, 'credentials.json'), JSON.stringify({
    version: 1,
    accessToken: 'token-1',
    refreshToken: 'r1',
    expiresAt: Date.now() + 3600_000,
    scope: 'images:generate images:read account:read'
  }), { mode: 0o600 })

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cli, 'serve'],
    cwd: packageRoot,
    env: {
      ...cleanEnv(),
      SPARKLES_ISSUER: server.origin,
      SPARKLES_API_BASE: `${server.origin}/api/mcp`,
      SPARKLES_CONFIG_DIR: configDir
    },
    stderr: 'pipe'
  })
  const client = new Client({ name: 'sparkles-image-test', version: '0.0.0' })
  try {
    await client.connect(transport)
    const tools = await client.listTools()
    const names = tools.tools.map((tool) => tool.name).sort()
    assert.deepEqual(names, [
      'cancel_image_jobs',
      'check_image_jobs',
      'generate_image',
      'get_credit_balance',
      'get_credit_usage',
      'get_image',
      'list_image_models',
      'list_images',
      'login'
    ])

    const models = await client.callTool({ name: 'list_image_models', arguments: {} })
    assert.equal(models.isError, undefined)
    assert.equal(models.structuredContent.defaultModel, 'gpt-image-2.6-sunburst')

    const generated = await client.callTool({
      name: 'generate_image',
      arguments: { prompt: 'A red fox in fresh snow, soft morning light', wait_seconds: 0 }
    })
    assert.equal(generated.isError, undefined)
    assert.equal(generated.structuredContent.jobs[0].jobId, JOB_ID)
    assert.equal(generated.structuredContent.images.length, 1)
    const image = generated.content.find((entry) => entry.type === 'image')
    assert.ok(image)
    assert.equal(image.mimeType, 'image/png')
    assert.deepEqual(Buffer.from(image.data, 'base64'), PNG_1X1)
  } finally {
    await client.close()
    await server.close()
    fs.rmSync(configDir, { recursive: true, force: true })
  }
})
