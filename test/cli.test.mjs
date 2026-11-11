import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { startFakeServer } from './helpers.mjs'

const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const cli = path.join(packageRoot, 'src', 'cli.mjs')

const run = (args, env = {}, cwd = packageRoot) => new Promise((resolve) => {
  const child = spawn(process.execPath, [cli, ...args], {
    cwd,
    env: { ...process.env, ...env }
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => { stdout += chunk })
  child.stderr.on('data', (chunk) => { stderr += chunk })
  child.on('close', (code) => resolve({ code, stdout, stderr }))
})

test('version prints the package version', () => {
  const version = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8')).version
  assert.equal(execFileSync(process.execPath, [cli, 'version'], { cwd: packageRoot }).toString().trim(), version)
})

test('help prints usage', () => {
  const output = execFileSync(process.execPath, [cli, 'help'], { cwd: packageRoot }).toString()
  assert.match(output, /Usage:/)
  assert.match(output, /generate images with a Sparkles Editor account/i)
})

test('init installs the skill into a project without logging in', () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'sparkles-init-'))
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sparkles-init-cfg-'))
  try {
    const result = execFileSync(process.execPath, [cli, 'init', '--project', '--no-login'], {
      cwd: project,
      env: { ...process.env, SPARKLES_CONFIG_DIR: configDir }
    }).toString()
    const skill = path.join(project, '.claude', 'skills', 'sparkles-image', 'SKILL.md')
    assert.ok(fs.existsSync(skill))
    assert.match(fs.readFileSync(skill, 'utf8'), /^name: sparkles-image$/m)
    assert.match(result, /MCP client configuration/)
    assert.match(result, /claude mcp add .*sparkles-image --/)
  } finally {
    fs.rmSync(project, { recursive: true, force: true })
    fs.rmSync(configDir, { recursive: true, force: true })
  }
})

test('doctor reports a missing login', () => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sparkles-doctor-'))
  try {
    let output = ''
    let code = 0
    try {
      output = execFileSync(process.execPath, [cli, 'doctor'], {
        cwd: packageRoot,
        env: { ...process.env, SPARKLES_CONFIG_DIR: configDir }
      }).toString()
    } catch (error) {
      code = error.status
      output = error.stdout?.toString() || ''
    }
    assert.equal(code, 1)
    assert.match(output, /not signed in/)
  } finally {
    fs.rmSync(configDir, { recursive: true, force: true })
  }
})

test('doctor checks authentication and the image service against a fake server', async () => {
  const server = await startFakeServer()
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sparkles-doctor-'))
  try {
    fs.writeFileSync(path.join(configDir, 'credentials.json'), JSON.stringify({
      version: 1,
      issuer: server.origin,
      clientId: 'sparkles-image-mcp',
      accessToken: 'token-1',
      refreshToken: 'r1',
      expiresAt: Date.now() + 3600_000,
      scope: 'images:generate images:read account:read'
    }), { mode: 0o600 })
    const result = await run(['doctor'], {
      SPARKLES_ISSUER: server.origin,
      SPARKLES_API_BASE: `${server.origin}/api/mcp`,
      SPARKLES_CONFIG_DIR: configDir
    })
    assert.equal(result.code, 0, result.stderr)
    assert.match(result.stdout, /Authentication: OK/)
    assert.match(result.stdout, /Image service: ready/)
    assert.match(result.stdout, /Authorization metadata: HTTP 200/)
  } finally {
    await server.close()
    fs.rmSync(configDir, { recursive: true, force: true })
  }
})

test('doctor exits nonzero when the wallet request fails', async () => {
  const server = await startFakeServer({ failures: { credits: { status: 500, body: { message: 'boom' } } } })
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sparkles-doctor-'))
  try {
    fs.writeFileSync(path.join(configDir, 'credentials.json'), JSON.stringify({
      version: 1,
      issuer: server.origin,
      clientId: 'sparkles-image-mcp',
      accessToken: 'token-1',
      refreshToken: 'r1',
      expiresAt: Date.now() + 3600_000,
      scope: 'images:generate images:read account:read'
    }), { mode: 0o600 })
    const result = await run(['doctor'], {
      SPARKLES_ISSUER: server.origin,
      SPARKLES_API_BASE: `${server.origin}/api/mcp`,
      SPARKLES_CONFIG_DIR: configDir
    })
    assert.equal(result.code, 1)
    assert.match(result.stdout, /Authentication: FAILED/)
    assert.doesNotMatch(result.stdout, /Image service: ready/)
  } finally {
    await server.close()
    fs.rmSync(configDir, { recursive: true, force: true })
  }
})

test('init keeps custom client, resource, and scope settings in the client config', () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'sparkles-init-'))
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sparkles-init-cfg-'))
  try {
    const result = execFileSync(process.execPath, [cli, 'init', '--project', '--no-login'], {
      cwd: project,
      env: {
        ...process.env,
        SPARKLES_CLIENT_ID: 'custom-client',
        SPARKLES_RESOURCE: 'https://sparkles-editor.com/api/mcp',
        SPARKLES_SCOPE: 'images:read',
        SPARKLES_CONFIG_DIR: configDir
      }
    }).toString()
    assert.match(result, /SPARKLES_CLIENT_ID=custom-client/)
    assert.match(result, /SPARKLES_SCOPE=images:read/)
    assert.match(result, /SPARKLES_RESOURCE=https:\/\/sparkles-editor\.com\/api\/mcp/)
    assert.match(result, /"SPARKLES_CLIENT_ID": "custom-client"/)
    assert.match(result, /"SPARKLES_SCOPE": "images:read"/)
  } finally {
    fs.rmSync(project, { recursive: true, force: true })
    fs.rmSync(configDir, { recursive: true, force: true })
  }
})

test('init keeps the staging cross-origin opt-in in the client config', () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'sparkles-init-'))
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sparkles-init-cfg-'))
  try {
    const result = execFileSync(process.execPath, [cli, 'init', '--project', '--no-login'], {
      cwd: project,
      env: {
        ...process.env,
        SPARKLES_ISSUER: 'https://t-d.example.com',
        SPARKLES_API_BASE: 'https://core-t-d.example.com/api',
        SPARKLES_ALLOW_CROSS_ORIGIN: '1',
        SPARKLES_CONFIG_DIR: configDir
      }
    }).toString()
    assert.match(result, /SPARKLES_ALLOW_CROSS_ORIGIN=1/)
    assert.match(result, /"SPARKLES_ALLOW_CROSS_ORIGIN": "1"/)
  } finally {
    fs.rmSync(project, { recursive: true, force: true })
    fs.rmSync(configDir, { recursive: true, force: true })
  }
})
