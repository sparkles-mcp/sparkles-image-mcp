#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { CLI, INSTALL_SPEC, accessHeaders, config, endpoints } from './config.mjs'
import { credentialsFile, loadCredentials } from './store.mjs'
import { login, revoke } from './oauth.mjs'
import { ApiClient } from './api.mjs'
import { startServer } from './server.mjs'

const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const packageVersion = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8')).version
const skillSource = path.join(packageRoot, 'skills', 'sparkles-image', 'SKILL.md')
const accountUrl = (cfg) => `${cfg.issuer}/account`

const help = `sparkles-image-mcp ${packageVersion}

Generate images with a Sparkles Editor account from any MCP client.

Usage:
  npx -y ${INSTALL_SPEC} <command> [options]

Choose one install method:
  ${CLI} init              Install the agent skill and sign in.
  ${CLI} serve             Run the MCP server on stdio (used by MCP clients).

Commands:
  init      Install the agent skill and print MCP client configuration.
  login     Open the Sparkles authorization page and store a local token.
  logout    Revoke the local token and remove it from this machine.
  serve     Run the MCP server on stdio (used by MCP clients).
  doctor    Check configuration, login state, and site connectivity.
  help      Show this help.
  version   Print the package version.

Options:
  --project    With init: install the skill in ./.claude/skills instead of ~/.claude/skills.
  --no-login   With init: skip the browser login step.
  --force      With init: overwrite an existing skill file.

Environment:
  SPARKLES_ISSUER              Site origin. Default: https://sparkles-editor.com
  SPARKLES_API_BASE            API base. Default: <issuer>/api/mcp
  SPARKLES_RESOURCE            OAuth resource indicator. Default: <issuer>/api/mcp
  SPARKLES_CLIENT_ID           OAuth public client id. Default: sparkles-image-mcp
  SPARKLES_SCOPE               Requested scopes. Default: images:generate images:read account:read
  SPARKLES_CONFIG_DIR          Credential directory. Default: ~/.config/sparkles-image-mcp
  SPARKLES_ALLOW_CROSS_ORIGIN  Set to 1 only when a staging API lives on another origin.
  SPARKLES_ACCESS_CLIENT_ID    Cloudflare Access service token id (private deployments).
  SPARKLES_ACCESS_CLIENT_SECRET
  SPARKLES_ACCESS_COOKIE       Cloudflare Access cookie (local verification only).

Run \`${CLI} doctor\` to check the connection.
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

const shellValue = (value) =>
  /^[A-Za-z0-9_./:@%+=,-]+$/.test(value) ? value : `"${String(value).replace(/(["\\$`])/g, '\\$1')}"`

function printClientConfig(cfg) {
  const args = ['-y', INSTALL_SPEC, 'serve']
  const env = {
    SPARKLES_ISSUER: cfg.issuer,
    SPARKLES_API_BASE: cfg.apiBase,
    SPARKLES_RESOURCE: cfg.resource,
    SPARKLES_CLIENT_ID: cfg.clientId,
    SPARKLES_SCOPE: cfg.scope,
    SPARKLES_CONFIG_DIR: cfg.configDir
  }
  if (cfg.allowCrossOrigin) env.SPARKLES_ALLOW_CROSS_ORIGIN = '1'
  const server = { command: 'npx', args, env }
  const block = JSON.stringify({ mcpServers: { 'sparkles-image': server } }, null, 2)
  const envFlags = Object.entries(env)
    .map(([key, value]) => `--env ${key}=${shellValue(value)}`)
    .join(' ')
  console.log('')
  console.log('MCP client configuration')
  console.log('')
  console.log('Claude Code plugin (recommended):')
  console.log('  /plugin marketplace add sparkles-mcp/sparkles-image-mcp')
  console.log('  /plugin install sparkles-image@sparkles-image-mcp')
  console.log('')
  console.log('Claude Code without the plugin:')
  console.log(`  claude mcp add --scope user ${envFlags} sparkles-image -- npx ${args.join(' ')}`)
  console.log('')
  console.log('Claude Desktop / Cursor (mcpServers block):')
  console.log(block)
  console.log('')
  console.log(`Keep SPARKLES_CONFIG_DIR in the server environment so login and serve use the same credentials (${cfg.configDir}).`)
  console.log('Use either the plugin or the manual MCP entry, not both: they share the server name `sparkles-image`.')
  if (cfg.accessClientId || cfg.accessCookie) {
    console.log('This installation also needs its Cloudflare Access variables in the server environment.')
    console.log('Add SPARKLES_ACCESS_CLIENT_ID and SPARKLES_ACCESS_CLIENT_SECRET (or SPARKLES_ACCESS_COOKIE) without printing them here.')
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
    console.log(`Run \`${CLI} login\` when you are ready to sign in.`)
  }
}

async function commandLogin(cfg) {
  const credentials = await login(cfg)
  console.log(`Signed in. Scope: ${credentials.scope}`)
  console.log(`Access token expires at ${new Date(credentials.expiresAt).toISOString()}.`)
  console.log(`Generated images also appear in your site library: ${cfg.issuer}/library?view=artwork`)
}

async function commandLogout(cfg) {
  const credentials = loadCredentials(cfg)
  const result = await revoke(cfg, credentials)
  if (result.revoked) {
    console.log('Signed out and removed local credentials. The site grant was revoked.')
  } else {
    console.log('Removed local credentials, but the site did not confirm revocation.')
    if (result.error) console.log(`Reason: ${result.error}`)
    console.log(`Revoke the grant at ${accountUrl(cfg)} if this device may have been copied.`)
  }
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
    console.log(`Login: not signed in. Run \`${CLI} login\`.`)
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
    return 1
  }
  try {
    const catalog = await client.catalog()
    const models = [...new Set((catalog?.prices || []).map((price) => price.model))]
    console.log(`Image service: ${catalog?.ready ? 'ready' : 'not ready'} (${models.length} model(s))`)
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
  if (command === 'version') {
    console.log(packageVersion)
    return 0
  }
  const cfg = config()
  switch (command) {
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
