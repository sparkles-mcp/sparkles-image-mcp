---
name: sparkles-image
description: Generate images and animated GIFs with the Sparkles Image MCP. Use when the user asks to create, draw, render, illustrate, design, or generate a picture, artwork, poster, photo, icon, or GIF.
license: MIT
---

# Sparkles Image

Use the `sparkles-image` MCP tools to generate images with the user's Sparkles Editor account. The MCP handles login, credits, moderation, and file delivery. You never need an API key, a NewAPI key, or the site's internal endpoints.

## Before generating

1. Check that the `sparkles-image` tools are available. If they are not, tell the user to install the MCP server and skill; do not invent image results.
2. If a tool returns a login error, call `login`. It opens the Sparkles authorization page in the user's browser. Ask the user to approve the request there, then retry the original tool call.
3. If the user cares about a specific model, quality, or format, call `list_image_models` first. Model ids and qualities change; never guess them.
4. Image generation spends credits from the user's Sparkles account. Do not generate extra variants, "options", or test images unless the user asked for them. `count` may be 1-4.

## Generating

Call `generate_image` with a complete visual prompt. Preserve the user's intent, but turn short requests into a usable prompt: subject, action, setting, composition, lighting, color, style, camera or medium, and aspect ratio where relevant.

- Default to `format: "png"` and let the server choose the default model and quality.
- Use `count` only when the user asks for multiple images. Each image is billed.
- For animated GIFs, use a `gpt-image-2.6-*` model with `format: "gif"`, `count: 1`, and optionally `frame_count` (2-16) and `frame_duration_ms` (a multiple of 10).
- Do not add text to an image unless the user asks for it; image models often misspell text.
- Never put passwords, API keys, private URLs, or other secrets in a prompt.

`generate_image` waits up to about 45 seconds. If it returns `pending: true`, the job is still running: call `get_image` with the job id after a short wait instead of submitting the same prompt again. Reuse the same `request_id` only when retrying the identical request after a network error.

## Showing results

Only claim an image was generated when the tool returned image content or `get_image` returned `image` metadata.

- Show the returned image(s) directly when the client displays images.
- Mention the job id so the user can find the image later.
- If the user asks for an older image, use `list_images` to find its job id, then `get_image`.
- `list_images` returns metadata only; it does not download image bytes.

## Handling failures

Read the tool's `errorCode` or error message before retrying:

- `login_required` / `login_expired`: call `login`, then retry once.
- `insufficient_credits`: show `get_credit_balance` and tell the user to top up on the Sparkles site. Do not retry.
- Moderation or policy errors: tell the user the prompt was rejected. Do not rephrase the prompt to evade moderation.
- `invalid_model`, `invalid_quality`, or a 409 "settings changed" error: call `list_image_models` again and use the current catalog values.
- A failed or `uncertain` job: do not silently resubmit. Check the job again later or ask the user. `uncertain` means the provider result could not be confirmed; it may still recover.
- Network or timeout errors: the job may already exist. Call `list_images` before generating the same prompt again.
- A completed job whose image cannot be downloaded (`not_found`, `image_too_large`): report that the image is available on the Sparkles site but could not be returned through MCP. Do not regenerate it automatically.

To stop queued work, use `cancel_image_jobs` with the job ids. Running jobs cannot be cancelled.

## Credits

Use `get_credit_balance` for the available balance and `get_credit_usage` for recent charges. Usage-based image models report 0 credits in the catalog; the actual charge appears in `get_credit_usage` and on the Sparkles site. Do not promise a fixed price or a refund.

## Tools

- `login` - open the browser authorization page and store the local token.
- `generate_image` - generate 1-4 images from a prompt.
- `get_image` - check one job and fetch its image when complete.
- `list_images` - list recent image jobs.
- `check_image_jobs` - check up to 50 jobs without downloading images.
- `cancel_image_jobs` - cancel queued jobs.
- `list_image_models` - list models, qualities, and GIF support.
- `get_credit_balance` - read the available credit balance.
- `get_credit_usage` - read recent credit charges and refunds.
