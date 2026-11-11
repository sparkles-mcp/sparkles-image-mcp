import http from 'node:http'
import { once } from 'node:events'

export const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
)

export const JOB_ID = '11111111-1111-4111-8111-111111111111'
export const JOB_ID_2 = '22222222-2222-4222-8222-222222222222'

const json = (response, value, status = 200) => {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
  response.end(JSON.stringify(value))
}

export async function startFakeServer(options = {}) {
  const state = {
    requests: [],
    accepted: new Set(['token-1', 'refreshed-token', 'login-token']),
    tokenError: null,
    original404: false,
    previewMime: 'image/png',
    previewBytes: PNG_1X1,
    catalog: {
      ready: true,
      provider: 'Test provider',
      version: 7,
      defaultModel: 'gpt-image-2.6-sunburst',
      billingSource: 'newapi',
      prices: [
        { model: 'gpt-image-2.6-sunburst', quality: 'auto', credits: 0 },
        { model: 'gpt-image-2.6-sunburst', quality: 'high', credits: 0 },
        { model: 'gpt-image-2.6-flare', quality: 'auto', credits: 0 },
        { model: 'gpt-image-5-legacy', quality: 'medium', credits: 0 }
      ]
    },
    jobId: JOB_ID,
    ids: [JOB_ID],
    statuses: {
      [JOB_ID]: { id: JOB_ID, status: 'completed', model: 'gpt-image-2.6-sunburst', error_code: null, retry_after: 0 }
    },
    jobs: {
      [JOB_ID]: {
        id: JOB_ID,
        status: 'completed',
        model: 'gpt-image-2.6-sunburst',
        quality: 'auto',
        size: 'auto',
        format: 'png',
        credits: 0,
        created_at: 1_760_000_000,
        expires_at: 1_760_086_400,
        error_code: null,
        retry_count: 0,
        retry_after: 0
      }
    },
    list: [],
    wallet: {
      billingSource: 'newapi',
      currency: 'USD',
      balance: 1234,
      walletBalance: 1000,
      subscriptionBalance: 234,
      unlimited: false,
      subscription: { monthly_credits: 500, active_until: 1_760_100_000 }
    },
    usage: {
      entries: [{ id: '9', delta: -12, model: 'gpt-image-2.6-sunburst', kind: 'usage', created_at: 1_760_000_000 }],
      page: 1,
      pageSize: 10,
      total: 1,
      currency: 'USD'
    },
    ...options
  }

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url || '/', 'http://127.0.0.1')
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const raw = Buffer.concat(chunks).toString('utf8')
    let body = null
    try {
      body = raw ? JSON.parse(raw) : null
    } catch {
      body = raw
    }
    state.requests.push({
      method: request.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      body,
      raw,
      headers: request.headers
    })

    if (url.pathname === '/.well-known/oauth-authorization-server') {
      if (state.metadataStatus && state.metadataStatus !== 200)
        return json(response, { message: 'metadata unavailable' }, state.metadataStatus)
      return json(response, state.metadata || {
        issuer: origin,
        authorization_endpoint: `${origin}/oauth/authorize`,
        token_endpoint: `${origin}/api/oauth/token`,
        revocation_endpoint: `${origin}/api/oauth/revoke`
      })
    }

    if (url.pathname === '/api/oauth/token' && request.method === 'POST') {
      const form = new URLSearchParams(raw)
      if (state.tokenError) return json(response, state.tokenError, 400)
      if (form.get('grant_type') === 'refresh_token') {
        if (form.get('refresh_token') !== 'r1' && form.get('refresh_token') !== 'login-refresh')
          return json(response, { error: 'invalid_grant' }, 400)
        return json(response, {
          access_token: 'refreshed-token',
          token_type: 'Bearer',
          expires_in: 900,
          refresh_token: 'r2',
          scope: 'images:generate images:read account:read'
        })
      }
      return json(response, {
        access_token: 'login-token',
        token_type: 'Bearer',
        expires_in: 900,
        refresh_token: 'login-refresh',
        scope: 'images:generate images:read account:read'
      })
    }

    if (url.pathname === '/api/oauth/revoke') {
      return json(response, {})
    }

    const api = url.pathname.startsWith('/api/mcp/') ? url.pathname.slice('/api/mcp/'.length) : null
    if (!api) return json(response, { message: 'not found' }, 404)

    const token = (request.headers.authorization || '').match(/^Bearer (.+)$/)?.[1]
    if (!token) return json(response, { message: 'missing token' }, 401)
    if (!state.accepted.has(token)) return json(response, { message: 'expired token' }, 401)

    const failure = state.failures?.[api]
    if (failure) {
      response.writeHead(failure.status || 500, {
        'Content-Type': 'application/json',
        ...(failure.headers || {})
      })
      return response.end(JSON.stringify(failure.body || { message: 'failed' }))
    }

    if (api === 'images/catalog') return json(response, state.catalog)

    if (api === 'images/jobs' && request.method === 'POST') {
      return json(response, { id: state.jobId, ...(state.ids.length > 1 ? { ids: state.ids } : {}) })
    }

    if (api === 'images/jobs/status' && request.method === 'POST') {
      return json(response, {
        jobs: (body?.ids || []).map((id) => state.statuses[id] || { id, status: 'running', model: 'gpt-image-2.6-sunburst', error_code: null, retry_after: 0 })
      })
    }

    if (api === 'images/jobs' && request.method === 'GET')
      return json(response, { jobs: state.list, hasMore: false, nextCursor: null })

    if (api === 'images/cancel' && request.method === 'POST')
      return json(response, { jobs: [] })

    if (api === 'credits') return json(response, state.wallet)
    if (api === 'credits/usage') return json(response, state.usage)

    const jobMatch = api.match(/^images\/jobs\/([0-9a-f-]{36})$/)
    if (jobMatch) return json(response, { job: state.jobs[jobMatch[1]] })

    const previewMatch = api.match(/^images\/([0-9a-f-]{36})\/preview$/)
    if (previewMatch) {
      if (url.searchParams.get('original') === '1' && state.original404)
        return json(response, { message: 'not found' }, 404)
      response.writeHead(200, {
        'Content-Type': state.previewMime,
        'Content-Length': String(state.previewBytes.length),
        'Cache-Control': 'private, no-store'
      })
      return response.end(state.previewBytes)
    }

    return json(response, { message: 'not found' }, 404)
  })

  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const origin = `http://127.0.0.1:${server.address().port}`
  return {
    origin,
    state,
    close: () => new Promise((resolve) => server.close(resolve))
  }
}
