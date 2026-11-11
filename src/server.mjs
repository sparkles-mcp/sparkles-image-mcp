import fs from 'node:fs'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ApiClient } from './api.mjs'
import { config } from './config.mjs'
import { loadCredentials } from './store.mjs'
import { registerTools } from './tools.mjs'

const version = (() => {
  try {
    return JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
  } catch {
    return '0.0.0'
  }
})()

const instructions = `Sparkles Image MCP generates images with the user's Sparkles Editor account.

- Image generation spends credits from the signed-in Sparkles account and is subject to the site's moderation rules. Do not generate images the user did not ask for.
- If a tool reports that login is required, call the "login" tool. It opens the Sparkles authorization page in the user's browser; ask the user to approve the request there.
- Use "list_image_models" to discover model ids, qualities, and GIF support.
- "generate_image" waits for a short while and then returns the image bytes. If it reports that a job is still pending, call "get_image" with the job id later instead of submitting the same prompt again.
- Use "get_credit_balance" and "get_credit_usage" to show the user what their images cost.`

const emptyCredentials = () => ({
  version: 1,
  accessToken: '',
  refreshToken: '',
  expiresAt: 0,
  scope: ''
})

export function createSession(env = process.env) {
  const cfg = config(env)
  const credentials = loadCredentials(cfg)
  return {
    cfg,
    client: new ApiClient(cfg, credentials || emptyCredentials())
  }
}

export async function startServer(env = process.env) {
  const session = createSession(env)
  const server = new McpServer(
    { name: 'sparkles-image', title: 'Sparkles Image', version },
    { instructions }
  )
  registerTools(server, session)
  const transport = new StdioServerTransport()
  await server.connect(transport)
  return { server, session }
}
