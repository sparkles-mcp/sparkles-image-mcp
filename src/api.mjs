import crypto from 'node:crypto'
import { accessHeaders } from './config.mjs'
import { AuthError, currentAccessToken } from './oauth.mjs'

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024
const MAX_JSON_BYTES = 2 * 1024 * 1024
const MAX_ERROR_BYTES = 64 * 1024
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

export class ApiError extends Error {
  constructor(message, { status = 0, code = 'api_error', retryAfter = null } = {}) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.retryAfter = retryAfter
  }
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export const isUuid = (value) => typeof value === 'string' && uuidPattern.test(value)

export const newRequestId = () => crypto.randomUUID()

async function readCapped(response, max) {
  const length = Number(response.headers.get('content-length') || 0)
  if (length > max) {
    await response.body?.cancel()
    return { tooLarge: true, buffer: null }
  }
  if (!response.body) return { tooLarge: false, buffer: Buffer.alloc(0) }
  const reader = response.body.getReader()
  const chunks = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.length
      if (size > max) {
        await reader.cancel()
        return { tooLarge: true, buffer: null }
      }
      chunks.push(Buffer.from(value))
    }
  } finally {
    reader.releaseLock()
  }
  return { tooLarge: false, buffer: Buffer.concat(chunks) }
}

async function errorMessage(response) {
  try {
    const { buffer } = await readCapped(response, MAX_ERROR_BYTES)
    if (!buffer?.length) return ''
    const text = buffer.toString('utf8')
    try {
      const data = JSON.parse(text)
      return String(data?.error?.message || data?.message || data?.error || data?.detail || '').slice(0, 500)
    } catch {
      return text.replace(/\s+/g, ' ').trim().slice(0, 500)
    }
  } catch {
    return ''
  }
}

export class ApiClient {
  constructor(cfg, credentials) {
    this.cfg = cfg
    this.credentials = credentials
    this.refreshInFlight = null
  }

  async token(force = false) {
    const valid = this.credentials.accessToken && this.credentials.expiresAt > Date.now() + 60_000
    if (!force && valid) return this.credentials.accessToken
    // Refresh tokens rotate. Concurrent tool calls must share one refresh or
    // the server's reuse detection will revoke the whole grant.
    if (!this.refreshInFlight) {
      this.refreshInFlight = currentAccessToken(this.cfg, this.credentials, { force })
        .finally(() => {
          this.refreshInFlight = null
        })
    }
    this.credentials = await this.refreshInFlight
    return this.credentials.accessToken
  }

  url(path, query) {
    const base = this.cfg.apiBase.replace(/\/+$/, '')
    const url = new URL(`${base}/${path.replace(/^\/+/, '')}`)
    for (const [key, value] of Object.entries(query || {})) {
      if (value === undefined || value === null || value === '') continue
      url.searchParams.set(key, String(value))
    }
    return url
  }

  async fetchResponse(path, {
    method = 'GET',
    query,
    body,
    accept = 'application/json',
    timeout = 30000,
    retry = true
  } = {}) {
    const url = this.url(path, query)
    const headers = {
      Accept: accept,
      Authorization: `Bearer ${await this.token()}`,
      ...accessHeaders(this.cfg)
    }
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    let response
    try {
      response = await fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'manual',
        signal: AbortSignal.timeout(timeout)
      })
    } catch (error) {
      throw new ApiError(
        error?.name === 'TimeoutError'
          ? 'Sparkles did not answer in time. The request may still be processing.'
          : 'Could not reach Sparkles. Check the network and try again.',
        { code: error?.name === 'TimeoutError' ? 'timeout' : 'network' }
      )
    }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel()
      throw new ApiError('Sparkles returned an unexpected redirect.', {
        status: response.status,
        code: 'redirect'
      })
    }
    if (response.status === 401 && retry) {
      await response.body?.cancel()
      if (!this.credentials.refreshToken)
        throw new AuthError('Login required. Run `npx sparkles-image-mcp login`.', 'login_required')
      await this.token(true)
      return this.fetchResponse(path, { method, query, body, accept, timeout, retry: false })
    }
    if (response.ok) return response
    const message = await errorMessage(response)
    const scopeError = /insufficient_scope/.test(response.headers.get('www-authenticate') || '')
    const code = response.status === 401 ? 'unauthorized'
      : response.status === 402 ? 'insufficient_credits'
        : response.status === 403 ? (scopeError ? 'insufficient_scope' : 'forbidden')
          : response.status === 404 ? 'not_found'
            : response.status === 409 ? 'conflict'
              : response.status === 429 ? 'rate_limited'
                : `http_${response.status}`
    throw new ApiError(
      message || `Sparkles returned HTTP ${response.status}.`,
      {
        status: response.status,
        code,
        retryAfter: Number(response.headers.get('retry-after') || 0) || null
      }
    )
  }

  async json(path, options = {}) {
    const response = await this.fetchResponse(path, options)
    const type = (response.headers.get('content-type') || '').toLowerCase()
    if (!type.includes('json')) {
      const { buffer } = await readCapped(response, MAX_ERROR_BYTES)
      throw new ApiError('Sparkles returned an unexpected response.', { code: 'invalid_response' })
    }
    const { buffer, tooLarge } = await readCapped(response, MAX_JSON_BYTES)
    if (tooLarge) throw new ApiError('The Sparkles response was too large.', { code: 'invalid_response' })
    try {
      return JSON.parse(buffer.toString('utf8'))
    } catch {
      throw new ApiError('Sparkles returned invalid JSON.', { code: 'invalid_response' })
    }
  }

  catalog() {
    return this.json('images/catalog')
  }

  async generate(input) {
    const catalog = await this.catalog()
    if (!catalog?.ready) throw new ApiError('Image generation is not available right now.', { code: 'unavailable' })
    const prices = Array.isArray(catalog.prices) ? catalog.prices : []
    if (!prices.length) throw new ApiError('No image models are currently available.', { code: 'unavailable' })
    const models = [...new Set(prices.map((price) => price.model))]
    const model = input.model || catalog.defaultModel || models[0]
    if (!models.includes(model))
      throw new ApiError(`Unknown image model "${model}". Call list_image_models to see the available models.`, { code: 'invalid_model' })
    const qualities = [...new Set(prices.filter((price) => price.model === model).map((price) => price.quality))]
    const quality = input.quality || (qualities.includes('auto') ? 'auto' : qualities[0])
    if (!qualities.includes(quality))
      throw new ApiError(`Model "${model}" does not support quality "${quality}".`, { code: 'invalid_quality' })
    const price = prices.find((entry) => entry.model === model && entry.quality === quality)
    const format = input.format || 'png'
    if (format === 'gif' && input.count > 1)
      throw new ApiError('GIF output supports one image per request.', { code: 'invalid_request' })
    const body = {
      requestId: input.requestId || newRequestId(),
      prompt: input.prompt,
      count: input.count || 1,
      model,
      quality,
      size: input.size || 'auto',
      format,
      providerVersion: catalog.version,
      expectedCredits: price?.credits || 0
    }
    if (input.background) body.background = input.background
    if (format === 'gif') {
      if (input.frameCount) body.frameCount = input.frameCount
      if (input.frameDurationMs) body.frameDurationMs = input.frameDurationMs
    }
    if (input.styleId) body.styleId = input.styleId
    const result = await this.json('images/jobs', { method: 'POST', body })
    if (!result?.id) throw new ApiError('Sparkles did not return an image job.', { code: 'invalid_response' })
    return {
      id: result.id,
      ids: Array.isArray(result.ids) && result.ids.length ? result.ids : [result.id],
      model,
      quality,
      format,
      count: body.count
    }
  }

  job(id) {
    if (!isUuid(id)) throw new ApiError('Invalid image job id.', { code: 'invalid_request' })
    return this.json(`images/jobs/${id}`)
  }

  async statuses(ids) {
    const unique = [...new Set(ids)].filter(isUuid)
    if (!unique.length) throw new ApiError('No valid image job ids were provided.', { code: 'invalid_request' })
    return this.json('images/jobs/status', {
      method: 'POST',
      body: { ids: unique.slice(0, 50) }
    })
  }

  listJobs({ limit = 20, saved = false, view = 'all', cursor } = {}) {
    return this.json('images/jobs', {
      query: { limit, saved: saved ? '1' : undefined, view, cursor }
    })
  }

  cancel({ ids = [], requestIds = [] } = {}) {
    return this.json('images/cancel', {
      method: 'POST',
      body: { ids: ids.filter(isUuid), requestIds: requestIds.filter(isUuid) }
    })
  }

  wallet() {
    return this.json('credits')
  }

  usage({ page = 1, pageSize = 10 } = {}) {
    return this.json('credits/usage', { query: { page, pageSize } })
  }

  async image(id, { preferOriginal = true } = {}) {
    if (!isUuid(id)) throw new ApiError('Invalid image id.', { code: 'invalid_request' })
    let lastError
    for (const original of preferOriginal ? [true, false] : [false]) {
      let response
      try {
        response = await this.fetchResponse(`images/${id}/preview`, {
          query: original ? { original: '1' } : undefined,
          accept: 'image/png, image/jpeg, image/webp, image/gif',
          timeout: 60000
        })
      } catch (error) {
        lastError = error
        continue
      }
      const mimeType = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()
      if (!IMAGE_TYPES.has(mimeType)) {
        await response.body?.cancel()
        lastError = new ApiError('Sparkles returned an unexpected image format.', { code: 'invalid_image' })
        continue
      }
      const { buffer, tooLarge } = await readCapped(response, MAX_IMAGE_BYTES)
      if (tooLarge) {
        lastError = new ApiError('The image is larger than the 8 MB MCP limit.', { code: 'image_too_large' })
        continue
      }
      return {
        data: buffer.toString('base64'),
        mimeType,
        bytes: buffer.length,
        original
      }
    }
    if (lastError instanceof AuthError) throw lastError
    if (lastError instanceof ApiError && lastError.code === 'not_found')
      throw new ApiError('The image is not available yet or is no longer stored.', { code: 'not_found' })
    if (lastError instanceof ApiError) throw lastError
    throw new ApiError('Could not download the generated image.', { code: 'image_failed' })
  }
}
