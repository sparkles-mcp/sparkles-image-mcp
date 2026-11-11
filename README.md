# Sparkles Image MCP

An open-source [Model Context Protocol](https://modelcontextprotocol.io) server that generates images and animated GIFs with a [Sparkles Editor](https://sparkles-editor.com) account.

The plugin runs locally and speaks MCP over stdio. The user signs in through the Sparkles website with OAuth, and the plugin calls the site's public `/api/mcp` API. Image generation, credits, moderation, and storage stay on Sparkles.

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
Image generation · Credits · Moderation · Storage · Private library
```

## What it provides

- Generate 1-4 images from one prompt, or one animated GIF.
- Check, list, fetch, and cancel image jobs.
- Read the account's credit balance and recent usage.
- Install an agent skill that explains the workflow to the model.
- Generated images are ordinary Sparkles images: they appear in the site's **Library** and in the image workspace's recent artwork history, with the same retention rules as images created on the website.

Not included in v1: image editing, reference-image uploads, video generation, and a remote HTTP transport.

## Requirements

- Node.js 20 or newer.
- A Sparkles Editor account with available image credits.
- A local browser for the one-time login.

## Install

### Claude Code plugin (recommended)

Inside Claude Code:

```text
/plugin marketplace add sparkles-mcp/sparkles-image-mcp
/plugin install sparkles-image@sparkles-image-mcp
```

The plugin supplies the MCP server entry and the `sparkles-image` skill. After installing, ask the agent to generate an image. If it reports that login is required, it will call the `login` tool and open the authorization page.

### Manual MCP configuration

Use this when you do not want the plugin, or when configuring Claude Desktop, Cursor, or another MCP client.

Claude Code:

```sh
claude mcp add --scope user \
  --env SPARKLES_ISSUER=https://sparkles-editor.com \
  --env SPARKLES_API_BASE=https://sparkles-editor.com/api/mcp \
  --env SPARKLES_CONFIG_DIR="$HOME/.config/sparkles-image-mcp" \
  sparkles-image -- npx -y github:sparkles-mcp/sparkles-image-mcp serve
```

Claude Desktop / Cursor (JSON):

```json
{
  "mcpServers": {
    "sparkles-image": {
      "command": "npx",
      "args": ["-y", "github:sparkles-mcp/sparkles-image-mcp", "serve"],
      "env": {
        "SPARKLES_ISSUER": "https://sparkles-editor.com",
        "SPARKLES_API_BASE": "https://sparkles-editor.com/api/mcp",
        "SPARKLES_CONFIG_DIR": "/home/you/.config/sparkles-image-mcp"
      }
    }
  }
}
```

Do not install the plugin and a manual entry named `sparkles-image` at the same time. They would start two servers with the same name.

### CLI setup helper

The same package also has a terminal CLI:

```sh
npx -y github:sparkles-mcp/sparkles-image-mcp init
```

`init` installs `SKILL.md` into `~/.claude/skills/sparkles-image/`, prints client configuration, and starts the browser login. Options:

| Option | Meaning |
| --- | --- |
| `--project` | Install the skill in `./.claude/skills` instead of the home directory. |
| `--no-login` | Print configuration and install the skill without opening the browser. |
| `--force` | Replace an existing, different `SKILL.md`. |

Other commands: `serve`, `login`, `logout`, `doctor`, `version`, `help`.

```sh
npx -y github:sparkles-mcp/sparkles-image-mcp doctor
```

`doctor` prints the resolved issuer, API base, config directory, login state, balance, model catalog status, and authorization-metadata status. It does not print tokens.

## Signing in

Login uses OAuth 2.1 authorization code with PKCE (S256) and a loopback redirect on `127.0.0.1`. The plugin is a public client and has no client secret.

The consent page shows the requesting app, the signed-in account, and the requested scopes:

| Scope | Allows |
| --- | --- |
| `images:generate` | Submit and cancel image jobs. |
| `images:read` | Read job status, the image library, and generated image bytes. |
| `account:read` | Read the credit balance and usage history. |

The access token is a 15-minute ES256 JWT. The refresh token rotates on every use. Credentials are stored in:

- `$SPARKLES_CONFIG_DIR/credentials.json`, or
- `~/.config/sparkles-image-mcp/credentials.json` (or `$XDG_CONFIG_HOME/sparkles-image-mcp`).

The file is written atomically with `0600` permissions. The plugin never sees the account password and never writes tokens to logs or tool output.

### Signing out

```sh
npx -y github:sparkles-mcp/sparkles-image-mcp logout
```

Logout revokes the refresh token on the site and deletes the local credentials. If the site cannot confirm revocation (for example, while offline), the local file is still deleted, but the CLI warns that the server-side grant may remain. In that case, revoke it from **Account → Connected MCP apps** at <https://sparkles-editor.com/account>.

Removing the plugin or deleting the credentials file does not by itself revoke a grant that is still active on the site. Use logout or the account page.

## Tools

| Tool | Purpose | Read-only |
| --- | --- | --- |
| `login` | Open the browser authorization page and wait for approval. | No |
| `generate_image` | Generate 1-4 images or one GIF. | No |
| `get_image` | Check one job and return its image when complete. | Yes |
| `list_images` | List recent image jobs (metadata only). | Yes |
| `check_image_jobs` | Check up to 50 jobs without downloading images. | Yes |
| `cancel_image_jobs` | Cancel queued jobs. | No |
| `list_image_models` | List models, qualities, formats, and the default model. | Yes |
| `get_credit_balance` | Read the available credit balance. | Yes |
| `get_credit_usage` | Read recent charges and refunds. | Yes |

### `generate_image`

| Parameter | Type | Default | Notes |
| --- | --- | --- | --- |
| `prompt` | string | required | 3-32,000 characters. Write a full visual prompt. |
| `model` | string | site default | Use an id from `list_image_models`. |
| `quality` | enum | `auto` | `low`, `medium`, `high`, `xhigh`, `max`, `auto`. Model support varies. |
| `size` | string | `auto` | `auto` or `WIDTHxHEIGHT`. Each side is 3-4 digits, a multiple of 16, at most 3840; aspect ratio at most 3:1; total pixels 655,360-8,294,400. |
| `format` | enum | `png` | `png`, `jpeg`, `webp`, `gif`. GIF requires a GIF-capable model. |
| `count` | integer | `1` | 1-4. GIF output requires `1`. |
| `background` | enum | — | `auto`, `opaque`, `transparent`. Transparent requires `png` or `webp`. |
| `frame_count` | integer | `9` | GIF only: 2-16 frames. |
| `frame_duration_ms` | integer | `200` | GIF only: 20-2,000 ms, a multiple of 10. |
| `request_id` | UUID | generated | Idempotency key. Reuse it only when retrying the identical request after a network error. |
| `wait_seconds` | integer | `25` | 0-30. Keep the whole tool call below the MCP client's usual 60-second timeout. |

The result contains job metadata and, for completed jobs, standard MCP `image` content. Inline images are capped at **6 MB combined** per response so the JSON-RPC message stays below the 10 MiB stdio limit. If an image is larger, or the download budget is exhausted, the tool returns the job id and asks the agent to call `get_image`. Each completed image can then be fetched separately.

If the job is still running when the wait window ends, the result has `pending: true`; call `get_image` later instead of submitting the prompt again.

### `get_image`

| Parameter | Type | Notes |
| --- | --- | --- |
| `job_id` | UUID | Job id from `generate_image` or `list_images`. |

Returns the job status and, when the job is complete, the image bytes. A job that is no longer stored returns `not_found`.

### `list_images`

| Parameter | Type | Default | Notes |
| --- | --- | --- | --- |
| `limit` | integer | `20` | 1-30 per page. |
| `view` | enum | `artwork` | `artwork` (available images), `all`, `failed`, `prompts`. |
| `saved` | boolean | `false` | Only permanently saved images. |
| `cursor` | string | — | `nextCursor` from the previous page. |

This returns metadata only. Use `get_image` for the bytes.

### `check_image_jobs`

| Parameter | Type | Notes |
| --- | --- | --- |
| `job_ids` | UUID array | 1-50 ids. |

### `cancel_image_jobs`

| Parameter | Type | Notes |
| --- | --- | --- |
| `job_ids` | UUID array | Up to 50 queued jobs. |
| `request_ids` | UUID array | Up to 50 creation request ids. |

Provide at least one of the two. Running and completed jobs cannot be cancelled.

### `list_image_models`

Returns the available model ids, their qualities, GIF support, the site default model, and the supported output formats. Call it before choosing a non-default model or GIF.

### `get_credit_balance`

Returns the spendable balance, wallet and subscription portions, unlimited status, and subscription end date when present. Values use the same display units as the Sparkles website.

### `get_credit_usage`

| Parameter | Type | Default | Notes |
| --- | --- | --- | --- |
| `page` | integer | `1` | 1-1,000,000. |
| `page_size` | integer | `10` | `10`, `20`, or `50`. |

Negative amounts are charges; positive amounts are refunds.

## Images in the Sparkles library

Every MCP generation creates a normal Sparkles image job for the signed-in account. Completed images appear in:

- **Library → Artwork**: <https://sparkles-editor.com/library?view=artwork>
- The recent artwork strip in the image workspace.

The retention rules are the same as the website:

- New ordinary temporary images: **1 day** after generation completes, or **28 days** while a subscription is active.
- Images added to an infinite canvas: 7 days from first addition.
- Permanently saved images: kept within the account's storage allowance.
- Existing images keep their originally recorded expiry.

Download or permanently save an image you want to keep. The MCP result also prints the library link when at least one image completed.

## Credits and moderation

Every generation spends credits from the signed-in Sparkles account. The model catalog may report `credits: 0` for usage-based models; the actual charge appears in `get_credit_usage` and in the site's billing history. The plugin does not promise a fixed price or a refund.

Prompts go through the same moderation pipeline as images created on the website. A rejected prompt is returned as an error. Do not rephrase a rejected prompt to evade moderation.

The plugin does not generate extra test images, bypass rate limits, or call the site's internal billing or model services.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `SPARKLES_ISSUER` | `https://sparkles-editor.com` | Site origin used for OAuth and the API. |
| `SPARKLES_API_BASE` | `<issuer>/api/mcp` | Public MCP API base. |
| `SPARKLES_RESOURCE` | `<issuer>/api/mcp` | OAuth resource indicator. |
| `SPARKLES_CLIENT_ID` | `sparkles-image-mcp` | Pre-registered public OAuth client id. |
| `SPARKLES_SCOPE` | `images:generate images:read account:read` | Space-separated scopes to request. Reducing scopes also disables the matching tools. |
| `SPARKLES_CONFIG_DIR` | `~/.config/sparkles-image-mcp` | Credential directory. Must be the same for `login` and `serve`. |
| `SPARKLES_ACCESS_CLIENT_ID` | — | Cloudflare Access service token id, for private deployments. |
| `SPARKLES_ACCESS_CLIENT_SECRET` | — | Cloudflare Access service token secret. |
| `SPARKLES_ACCESS_COOKIE` | — | Cloudflare Access cookie for local verification only. Never commit it. |

The Access variables are only for deployments protected by Cloudflare Access, such as a staging site. Production `sparkles-editor.com` does not require them.

If you change `SPARKLES_CONFIG_DIR`, set it in both the login command and the MCP server environment, or the server will not find the credentials.

## Troubleshooting

Every tool error includes a code in square brackets, for example `[insufficient_credits]`. Start with `doctor`.

| Code | Meaning | What to do |
| --- | --- | --- |
| `login_required` | No local credentials. | Call the `login` tool or run the CLI `login` command. |
| `login_expired` | The refresh token was rejected or revoked. | Sign in again. If it repeats, revoke the old grant on the account page. |
| `access_denied` | The user declined the authorization page. | Run login again when ready. |
| `login_timeout` | No approval within 5 minutes. | Run login again. |
| `callback_failed` | The local loopback listener could not start. | Check that `127.0.0.1` is allowed by local security software. |
| `access_blocked` | A redirect indicates Cloudflare Access. | Configure the Access service token variables, or use a site without Access. |
| `invalid_metadata` / `invalid_issuer` | The authorization server metadata names an unexpected issuer or origin. | Check `SPARKLES_ISSUER`; do not point the client at an untrusted site. |
| `insufficient_credits` | The account cannot pay for the request. | Top up on the site or reduce the request; do not retry blindly. |
| `insufficient_scope` | The grant lacks a scope needed by the tool. | Sign in again and approve all scopes, or fix `SPARKLES_SCOPE`. |
| `unauthorized` / `forbidden` | The token was rejected. | Run `doctor`; sign in again if needed. |
| `invalid_model` / `invalid_quality` | The catalog changed or the value is unsupported. | Call `list_image_models` and use current values. |
| `invalid_request` | Invalid size, frame options, or idempotency id. | Check the parameter limits above. |
| `conflict` (HTTP 409) | Model, quality, or price changed between catalog read and submission. | Refresh the catalog and confirm the new price with the user. |
| `rate_limited` | The site asked the client to slow down. | Wait for `retryAfter`, then retry once. |
| `not_found` | The job or stored image does not exist or has expired. | Check `list_images`; do not regenerate automatically. |
| `image_too_large` | The original and the preview both exceed 6 MB. | Open the image in the Sparkles library instead. |
| `image_failed` / `invalid_image` | The image download failed or had an unexpected format. | Retry `get_image` once; otherwise view it on the site. |
| `timeout` / `network` | The request did not complete. It may still be processing. | Call `list_images` before submitting the same prompt again. |
| `unavailable` | Image generation is disabled or has no models. | Try later; check the site. |
| `cancelled` | The MCP client cancelled the call. | No action needed. |

If login opens the wrong site, check `SPARKLES_ISSUER`. If the browser does not open, the CLI prints the authorization URL; open it manually.

## Upgrade and uninstall

- **CLI / manual MCP entry**: `npx -y github:sparkles-mcp/sparkles-image-mcp` always runs the current `main` from GitHub. No separate upgrade step.
- **Claude Code plugin**: update or remove it from the `/plugin` menu.
- **Manual Claude Code entry**: `claude mcp remove sparkles-image`.
- **Skill**: delete `~/.claude/skills/sparkles-image/` (or `./.claude/skills/sparkles-image/`).
- **Credentials**: run `logout`, then delete `$SPARKLES_CONFIG_DIR` if it still exists.

## Privacy and security

- Images, prompts, and account data are handled by Sparkles under its [Privacy Policy](https://sparkles-editor.com/privacy).
- The plugin stores only OAuth credentials on the local machine. It does not store prompts or images outside the MCP client's own conversation.
- Tokens are scoped, short-lived, and revocable from the account page.
- Report a suspected vulnerability privately to <support@sparkles-editor.com>. Do not open a public issue containing exploit details, tokens, or private images.

## Development

```sh
npm install
npm test
node src/cli.mjs help
node src/cli.mjs doctor
```

Tests use `node:test`, a temporary config directory, and a local fake HTTP server. They do not call the production site, spend credits, or read real user data.

To point a development build at an isolated site:

```sh
SPARKLES_ISSUER=https://t-d.example.com \
SPARKLES_API_BASE=https://t-d.example.com/api/mcp \
SPARKLES_CONFIG_DIR=/tmp/sparkles-mcp-test \
node src/cli.mjs doctor
```

## Open-source boundary

This repository contains only the MCP client, its OAuth/PKCE client, the agent skill, and tests. It does not contain the Sparkles website's server code, authorization server implementation, consent page, moderation rules, prompt templates, model routing, pricing tables, database schema, or secrets. The plugin depends only on the documented public OAuth and `/api/mcp` contracts.

## License

MIT. See [LICENSE](LICENSE).
