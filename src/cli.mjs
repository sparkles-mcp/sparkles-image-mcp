#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { accessHeaders, config, endpoints } from './config.mjs'
import { clearCredentials, credentialsFile, loadCredentials } from './store.mjs'
import { AuthError, login, revoke } from './oauth.mjs'
import { ApiClient } from './api.mjs'
import { startServer } from './server.mjs'

const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const packageVersion = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8')).version
const skillSource = path.join(packageRoot, 'skills', 'sparkles-image', 'SKILL.md')

const help = `sparkles-image-mcp ${packageVersion}

Generate images with a Sparkles Editor account from any MCP client.

Usage:
  sparkles-image-mcp init [--project] [--no-login] [--force]
  sparkles-image-mcp login
  sparkles-image-mcp logout
  sparkles-image-mcp serve
  sparkles-image-mcp doctor
  sparkles-image-mcp help
  sparkles-image-mcp version

Commands:
  init      Install the agent skill and print MCP client configuration.
  login     Open the Sparkles authorization page and store a local token.
  logout    Revoke the local token and remove it from this machine.
  serve     Run the MCP server on stdio (used by MCP clients).
  doctor    Check configuration, login state, and site connectivity.

Options:
  --project    With init: install the skill in ./.claude/skills instead of ~/.claude/skills.
  --no-login   With init: skip the browser login step.
  --force      With init: overwrite an existing skill file.

Environment:
  SPARKLES_ISSUER              Site origin. Default: https://sparkles-editor.com
  SPARKLES_API_BASE            API base. Default: <issuer>/api/mcp
  SPARKLES_CONFIG_DIR          Credential directory. Default: ~/.config/sparkles-image-mcp
  SPARKLES_ACCESS_CLIENT_ID    Cloudflare Access service token id (private deployments).
  SPARKLES_ACCESS_CLIENT_SECRET
  SPARKLES_ACCESS_COOKIE       Cloudflare Access cookie (local verification only).

Run \`sparkles-image-mcp doctor\` to check the connection.
`

function parseArgs(argv) {
  const flags = new Set(argv.filter((arg) => arg.startsWith('--')))
  return {
    command: argv.find((arg) => !arg.startsWith('--')) || 'help',
    flags
  }
}

function installSkill({ project = false, force = false } = {}) {
  const directory = project
    ? path.join(process.cwd(), '.claude', 'skills', 'sparkles-image')
    : path.join(os.homedir(), '.claude', 'skills', 'sparkles-image')
  const target = path.join(directory, 'SKILL.md')
  const content = fs.readFileSync(skillSource, 'utf8')
  if (fs.existsSync(target)) {
    const current = fs.readFileSync(target, 'utf8')
    if (current === content) return { target, status: 'unchanged' }
    if (!force) return { target, status: 'exists' }
  }
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  fs.writeFileSync(target, content, { mode: 0o644 })
  return { target, status: 'installed' }
}

function printClientConfig(cfg) {
  const command = 'npx'
  const args = ['-y', 'sparkles-image-mcp', 'serve']
  const custom = cfg.issuer !== 'https://sparkles-editor.com'
  const server = {
    command,
    args,
    ...(custom ? { env: { SPARKLES_ISSUER: cfg.issuer, SPARKLES_API_BASE: cfg.apiBase } } : {})
  }
  const block = JSON.stringify({ mcpServers: { 'sparkles-image': server } }, null, 2)
  console.log('')
  console.log('MCP client configuration')
  console.log('')
  console.log('Claude Code:')
  console.log(`  claude mcp add sparkles-image -- ${command} ${args.join(' ')}`)
  console.log('')
  console.log('Claude Desktop / Cursor (mcpServers block):')
  console.log(block)
  if (custom) {
    console.log('')
    console.log(`This installation uses ${cfg.issuer}. Keep SPARKLES_ISSUER and SPARKLES_API_BASE in the server environment.`)
    console.log('If the site uses Cloudflare Access, also set SPARKLES_ACCESS_CLIENT_ID and SPARKLES_ACCESS_CLIENT_SECRET.')
  }
}

async function commandInit(cfg, flags) {
  const result = installSkill({
    project: flags.has('--project'),
    force: flags.has('--force')
  })
  if (result.status === 'unchanged') console.log(`Skill already installed: ${result.target}`)
  else if (result.status === 'exists')
    console.log(`Skill already exists: ${result.target}\nUse --force to replace it.`)
  else console.log(`Installed skill: ${result.target}`)
  printClientConfig(cfg)
  if (!flags.has('--no-login')) {
    console.log('')
    console.log('Starting login...')
    await commandLogin(cfg)
  } else {
    console.log('')
    console.log('Run `npx sparkles-image-mcp login` when you are ready to sign in.')
  }
}

async function commandLogin(cfg) {
  const credentials = await login(cfg)
  console.log(`Signed in. Scope: ${credentials.scope}`)
  console.log(`Access token expires at ${new Date(credentials.expiresAt).toISOString()}.`)
}

async function commandLogout(cfg) {
  const credentials = loadCredentials(cfg)
  await revoke(cfg, credentials)
  clearCredentials(cfg)
  console.log('Signed out and removed local credentials.')
}

async function commandDoctor(cfg) {
  const credentials = loadCredentials(cfg)
  console.log(`Issuer: ${cfg.issuer}`)
  console.log(`API base: ${cfg.apiBase}`)
  console.log(`Config directory: ${cfg.configDir}`)
  console.log(`Credentials file: ${credentialsFile(cfg)}`)
  if (cfg.accessClientId && cfg.accessClientSecret) console.log('Cloudflare Access service token: configured')
  else if (cfg.accessCookie) console.log('Cloudflare Access cookie: configured')
  if (!credentials?.refreshToken && !credentials?.accessToken) {
    console.log('Login: not signed in. Run `sparkles-image-mcp login`.')
    return 1
  }
  console.log(`Login: ${credentials.refreshToken ? 'refresh token stored' : 'access token only'}`)
  console.log(`Scope: ${credentials.scope || '(unknown)'}`)
  console.log(`Access token expires at: ${new Date(credentials.expiresAt).toISOString()}`)
  const client = new ApiClient(cfg, credentials)
  try {
    const wallet = await client.wallet()
    console.log(`Authentication: OK (balance ${wallet?.balance ?? 'unknown'})`)
  } catch (error) {
    console.log(`Authentication: FAILED — ${error.message}`)
    if (error instanceof AuthError) return 1
  }
  try {
    const catalog = await client.catalog()
    const models = [...new Set((catalog?.prices || []).map((price) => price.model))]
    console.log(`Image service: ${catalog?.ready ? 'ready' : 'not ready'} (${models.length} model(s), provider: ${catalog?.provider || 'unknown'})`)
  } catch (error) {
    console.log(`Image service: FAILED — ${error.message}`)
    return 1
  }
  try {
    const metadata = await fetch(endpoints(cfg).metadata, {
      headers: { Accept: 'application/json', ...accessHeaders(cfg) },
      redirect: 'manual',
      signal: AbortSignal.timeout(10000)
    })
    await metadata.body?.cancel()
    if (metadata.status >= 300 && metadata.status < 400)
      console.log(`Authorization metadata: blocked by Cloudflare Access (HTTP ${metadata.status}). Configure SPARKLES_ACCESS_CLIENT_ID/SECRET.`)
    else console.log(`Authorization metadata: HTTP ${metadata.status}`)
  } catch (error) {
    console.log(`Authorization metadata: unreachable — ${error.message}`)
  }
  return 0
}

async function main() {
  const { command, flags } = parseArgs(process.argv.slice(2))
  if (flags.has('--help') || command === 'help') {
    console.log(help)
    return 0
  }
  const cfg = config()
  switch (command) {
    case 'version':
      console.log(packageVersion)
      return 0
    case 'init':
      await commandInit(cfg, flags)
      return 0
    case 'login':
      await commandLogin(cfg)
      return 0
    case 'logout':
      await commandLogout(cfg)
      return 0
    case 'doctor':
      return commandDoctor(cfg)
    case 'serve':
      await startServer()
      return 0
    default:
      console.error(`Unknown command: ${command}\n`)
      console.error(help)
      return 1
  }
}

main()
  .then((code) => {
    if (typeof code === 'number') process.exitCode = code
  })
  .catch((error) => {
    console.error(error?.message || String(error))
    process.exitCode = 1
  })
