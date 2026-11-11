# Sparkles Image MCP

An open-source [Model Context Protocol](https://modelcontextprotocol.io) server that generates images with a [Sparkles Editor](https://sparkles-editor.com) account.

It is a local stdio plugin. Your MCP client starts it, the user signs in through the Sparkles website with OAuth, and the plugin calls the site's public `/api/mcp` endpoints. Image generation, credits, moderation, and storage stay on Sparkles; the plugin never uses NewAPI directly.

```
MCP client (Claude Code, Claude Desktop, Cursor, ...)
        │ stdio / JSON-RPC
        ▼
sparkles-image-mcp  (this repository)
        │ HTTPS + OAuth 2.1 PKCE
        ▼
Sparkles Editor
  /oauth/authorize  /api/oauth/token  /api/mcp/*
        │
        ▼
Image generation · Credits · Moderation · Storage
```

## What it can do

- Generate 1-4 images from a prompt.
- Generate animated GIFs with GPT Image 2.6 models.
- Check, list, fetch, and cancel image jobs.
- Read the account's credit balance and recent usage.
- Install an agent skill that explains the workflow to the model.

Not included in v1: editing uploaded images, reference-image uploads, video, and a remote HTTP transport. The plugin is image generation only.

## Requirements

- Node.js 20 or newer.
- A Sparkles Editor account with available image credits.
- A local browser for the login step.

## Quick start

```sh
# 1. Install the skill and start the browser login.
npx -y sparkles-image-mcp init

# 2. If your MCP client is Claude Code:
claude mcp add sparkles-image -- npx -y sparkles-image-mcp serve

# 3. Check the connection.
npx -y sparkles-image-mcp doctor
```

`init` installs `SKILL.md` into `~/.claude/skills/sparkles-image/` and prints configuration for other clients. Use `init --project` to install the skill into `./.claude/skills` instead, or `init --no-login` to skip the browser step.

### Claude Desktop / Cursor

Add this to the client's MCP configuration:

```json
{
  "mcpServers": {
    "sparkles-image": {
      "command": "npx",
      "args": ["-y", "sparkles-image-mcp", "serve"]
    }
  }
}
```

### Claude Code plugin

This repository is also a Claude Code plugin. It ships `.claude-plugin/plugin.json`, `.mcp.json`, and the `sparkles-image` skill. Install it from the repository or a local checkout, then run `npx sparkles-image-mcp login` once.

## Login

`sparkles-image-mcp login` opens the Sparkles authorization page in the browser and waits for the local callback on `127.0.0.1`. The page shows which client is asking, the account, and the requested scopes:

- `images:generate` — submit image jobs.
- `images:read` — read job status, the image library, and generated images.
- `account:read` — read the credit balance and usage.

The flow uses OAuth 2.1 authorization code with PKCE (S256) and a loopback redirect. The plugin is a public client: it has no client secret. The access token is a 15-minute ES256 JWT; the refresh token rotates on every use and is stored with `0600` permissions in:

- `$SPARKLES_CONFIG_DIR/credentials.json`, or
- `~/.config/sparkles-image-mcp/credentials.json` (or `$XDG_CONFIG_HOME/sparkles-image-mcp`).

`sparkles-image-mcp logout` revokes the grant on the site and deletes the local file. You can also revoke access from **Account → Connected MCP apps** on the Sparkles site. The plugin never sees the user's password, and no token is written to logs.

Inside an agent, the `login` tool performs the same flow, so the model can start the login when a tool reports that authentication is required.

## Tools

| Tool | Purpose |
| --- | --- |
| `login` | Open the browser authorization page. |
| `generate_image` | Generate 1-4 images from a prompt and return their bytes when ready. |
| `get_image` | Check one job and download its image when complete. |
| `list_images` | List recent image jobs. |
| `check_image_jobs` | Check up to 50 jobs without downloading images. |
| `cancel_image_jobs` | Cancel queued jobs. |
| `list_image_models` | List models, qualities, and GIF support. |
| `get_credit_balance` | Read the available credit balance. |
| `get_credit_usage` | Read recent credit charges and refunds. |

`generate_image` waits about 45 seconds. If the job is still running, it returns the job id and the model can call `get_image` later. The MCP response includes the image as standard MCP `image` content, so any client that renders image content can display it.

Images larger than 8 MB are retried as the site's WebP preview; if neither fits, the tool reports `image_too_large` instead of returning a truncated file. Animated GIFs are returned as `image/gif` when they fit.

## Credits and moderation

Every generation spends credits from the signed-in Sparkles account. The catalog reports `credits: 0` for usage-based models; the actual charge appears in `get_credit_usage` and in the site's billing history. This plugin does not promise a fixed price or a refund.

Prompts are submitted to the same moderation pipeline as images created on the website. A rejected prompt is reported as an error; the skill instructs the agent not to rephrase prompts to evade moderation. The plugin does not generate extra test images, and it does not bypass the site's billing or rate limits.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `SPARKLES_ISSUER` | `https://sparkles-editor.com` | Site origin used for OAuth and the API. |
| `SPARKLES_API_BASE` | `<issuer>/api/mcp` | Public MCP API base. |
| `SPARKLES_RESOURCE` | `<issuer>/api/mcp` | OAuth resource indicator. |
| `SPARKLES_CLIENT_ID` | `sparkles-image-mcp` | Pre-registered public OAuth client. |
| `SPARKLES_CONFIG_DIR` | `~/.config/sparkles-image-mcp` | Credential directory. |
| `SPARKLES_ACCESS_CLIENT_ID` | — | Cloudflare Access service token id, for private deployments. |
| `SPARKLES_ACCESS_CLIENT_SECRET` | — | Cloudflare Access service token secret. |
| `SPARKLES_ACCESS_COOKIE` | — | Access cookie for local verification only. Never commit it. |

The Access variables are only for deployments protected by Cloudflare Access (for example, a staging site). Production `sparkles-editor.com` does not require them.

## Development

```sh
npm install
npm test
node src/cli.mjs help
node src/cli.mjs doctor
```

Tests use `node:test`, a temporary config directory, and a local fake HTTP server. They do not call the production site, spend credits, or read real user data.

To point a development build at another site:

```sh
SPARKLES_ISSUER=https://t-d.example.com \
SPARKLES_API_BASE=https://t-d.example.com/api/mcp \
SPARKLES_CONFIG_DIR=/tmp/sparkles-mcp-test \
node src/cli.mjs doctor
```

## Open-source boundary

This repository contains only the MCP client, OAuth/PKCE client, skill, and tests. It does not contain the Sparkles website's server code, OAuth authorization server, consent page, moderation rules, prompt templates, model routing, pricing tables, NewAPI integration, database schema, or secrets. The plugin depends only on the documented public OAuth and `/api/mcp` contracts.

## License

MIT. See [LICENSE](LICENSE).
