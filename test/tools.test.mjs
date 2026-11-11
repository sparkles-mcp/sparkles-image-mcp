import assert from 'node:assert/strict'
import test from 'node:test'
import { ApiError } from '../src/api.mjs'
import { AuthError } from '../src/oauth.mjs'
import { registerTools } from '../src/tools.mjs'
import { JOB_ID, JOB_ID_2, PNG_1X1 } from './helpers.mjs'

function setup(client) {
  const handlers = new Map()
  const server = {
    registerTool(name, config, handler) {
      handlers.set(name, { config, handler })
    }
  }
  registerTools(server, { cfg: { issuer: 'https://example.test' }, client })
  return handlers
}

const completedClient = (overrides = {}) => ({
  generate: async () => ({ ids: [JOB_ID, JOB_ID_2], model: 'gpt-image-2.6-sunburst', quality: 'auto', format: 'png', count: 2 }),
  statuses: async (ids) => ({
    jobs: ids.map((id) => ({ id, status: 'completed', model: 'gpt-image-2.6-sunburst' }))
  }),
  image: async () => ({ data: PNG_1X1.toString('base64'), mimeType: 'image/png', bytes: PNG_1X1.length, original: true }),
  catalog: async () => ({
    ready: true,
    defaultModel: 'gpt-image-2.6-sunburst',
    provider: 'Test',
    prices: [
      { model: 'gpt-image-2.6-sunburst', quality: 'auto', credits: 0 },
      { model: 'gpt-image-2.6-flare', quality: 'auto', credits: 0 },
      { model: 'gpt-image-5-legacy', quality: 'medium', credits: 0 }
    ]
  }),
  wallet: async () => ({
    balance: 1234,
    walletBalance: 1000,
    subscriptionBalance: 234,
    unlimited: false,
    currency: 'USD',
    subscription: { monthly_credits: 500, active_until: 1_760_100_000 }
  }),
  usage: async () => ({
    entries: [{ id: '9', delta: -12, model: 'gpt-image-2.6-sunburst', kind: 'usage', created_at: 1_760_000_000 }],
    page: 1,
    pageSize: 10,
    total: 1,
    currency: 'USD'
  }),
  listJobs: async () => ({
    jobs: [{ id: JOB_ID, status: 'completed', model: 'gpt-image-2.6-sunburst', format: 'png' }],
    hasMore: false,
    nextCursor: null
  }),
  cancel: async () => ({ jobs: [] }),
  ...overrides
})

test('generate_image returns image content for completed jobs', async () => {
  const handlers = setup(completedClient())
  const result = await handlers.get('generate_image').handler({ prompt: 'A red fox in snow' }, {})
  assert.equal(result.isError, undefined)
  assert.equal(result.structuredContent.images.length, 2)
  assert.equal(result.content.filter((entry) => entry.type === 'image').length, 2)
  assert.equal(result.content[0].type, 'text')
})

test('generate_image reports pending jobs without pretending they succeeded', async () => {
  const client = completedClient({
    statuses: async (ids) => ({ jobs: ids.map((id) => ({ id, status: 'running', model: 'gpt-image-2.6-sunburst' })) })
  })
  const handlers = setup(client)
  const result = await handlers.get('generate_image').handler({ prompt: 'A red fox in snow', wait_seconds: 0 }, {})
  assert.equal(result.isError, undefined)
  assert.equal(result.structuredContent.pending, true)
  assert.equal(result.structuredContent.images.length, 0)
  assert.match(result.content[0].text, /Call get_image/)
})

test('generate_image marks a failed job as an error', async () => {
  const client = completedClient({
    statuses: async (ids) => ({ jobs: ids.map((id) => ({ id, status: 'failed', error_code: 'provider_error' })) })
  })
  const handlers = setup(client)
  const result = await handlers.get('generate_image').handler({ prompt: 'A red fox in snow', wait_seconds: 0 }, {})
  assert.equal(result.isError, true)
  assert.match(result.content[0].text, /provider_error/)
})

test('tool errors do not attach output-schema-invalid structured content', async () => {
  const handlers = setup(completedClient({
    generate: async () => {
      throw new AuthError('Login required.', 'login_required')
    }
  }))
  const result = await handlers.get('generate_image').handler({ prompt: 'A red fox in snow' }, {})
  assert.equal(result.isError, true)
  assert.equal('structuredContent' in result, false)
})

test('generate_image accepts UUIDv7 request ids', async () => {
  let received
  const handlers = setup(completedClient({
    generate: async (input) => {
      received = input
      return { ids: [JOB_ID], model: 'gpt-image-2.6-sunburst', quality: 'auto', format: 'png', count: 1, requestId: input.requestId }
    }
  }))
  const requestId = '0190a5b0-7c3e-7abc-8def-0123456789ab'
  const result = await handlers.get('generate_image').handler({ prompt: 'A red fox in snow', request_id: requestId }, {})
  assert.equal(result.isError, undefined)
  assert.equal(received.requestId, requestId)
  assert.equal(result.structuredContent.requestId, requestId)
})

test('generate_image rejects an invalid pixel size before submitting', async () => {
  let submitted = false
  const handlers = setup(completedClient({
    generate: async () => {
      submitted = true
      throw new Error('should not submit')
    }
  }))
  const result = await handlers.get('generate_image').handler({ prompt: 'A red fox in snow', size: '1920x1080' }, {})
  assert.equal(result.isError, true)
  assert.match(result.content[0].text, /Invalid size/)
  assert.equal(submitted, false)
})

test('generate_image keeps the combined image payload under the transport limit', async () => {
  const big = Buffer.alloc(2_200_000, 7)
  const ids = [JOB_ID, JOB_ID_2, '33333333-3333-4333-8333-333333333333', '44444444-4444-4444-8444-444444444444']
  const handlers = setup(completedClient({
    generate: async () => ({ ids, model: 'gpt-image-2.6-sunburst', quality: 'auto', format: 'png', count: 4, requestId: JOB_ID }),
    statuses: async (requested) => ({ jobs: requested.map((id) => ({ id, status: 'completed', model: 'gpt-image-2.6-sunburst' })) }),
    image: async () => ({ data: big.toString('base64'), mimeType: 'image/png', bytes: big.length, original: true })
  }))
  const result = await handlers.get('generate_image').handler({ prompt: 'Four large images', count: 4, wait_seconds: 0 }, {})
  assert.equal(result.isError, undefined)
  assert.equal(result.structuredContent.images.length, 2)
  assert.match(result.structuredContent.note, /get_image/)
  assert.equal(result.content.filter((entry) => entry.type === 'image').length, 2)
})

test('generate_image errors when the created job cannot be found', async () => {
  const client = completedClient({
    statuses: async () => ({ jobs: [] })
  })
  const handlers = setup(client)
  const result = await handlers.get('generate_image').handler({ prompt: 'A red fox in snow', wait_seconds: 0 }, {})
  assert.equal(result.isError, true)
  assert.match(result.content[0].text, /did not return the new image job/)
})

test('generate_image surfaces API errors with their code', async () => {
  const handlers = setup(completedClient({
    generate: async () => {
      throw new ApiError('Insufficient credits.', { status: 402, code: 'insufficient_credits' })
    }
  }))
  const result = await handlers.get('generate_image').handler({ prompt: 'A red fox in snow' }, {})
  assert.equal(result.isError, true)
  assert.match(result.content[0].text, /Insufficient credits/)
  assert.match(result.content[0].text, /insufficient_credits/)
})

test('an auth error tells the model to use the login tool', async () => {
  const handlers = setup(completedClient({
    generate: async () => {
      throw new AuthError('Login required.', 'login_required')
    }
  }))
  const result = await handlers.get('generate_image').handler({ prompt: 'A red fox in snow' }, {})
  assert.equal(result.isError, true)
  assert.match(result.content[0].text, /`login` tool/)
})

test('generate_image rejects GIF-only options on a still image', async () => {
  const handlers = setup(completedClient())
  const result = await handlers.get('generate_image').handler({
    prompt: 'A red fox in snow',
    frame_count: 8
  }, {})
  assert.equal(result.isError, true)
  assert.match(result.content[0].text, /only apply to GIF/)
})

test('get_image returns an image only when the job is complete', async () => {
  const handlers = setup(completedClient({
    job: async () => ({
      job: { id: JOB_ID, status: 'running', model: 'gpt-image-2.6-sunburst', format: 'png' }
    })
  }))
  const running = await handlers.get('get_image').handler({ job_id: JOB_ID }, {})
  assert.equal(running.content.some((entry) => entry.type === 'image'), false)
  assert.match(running.content[0].text, /still generating/)

  const completedHandlers = setup(completedClient({
    job: async () => ({
      job: { id: JOB_ID, status: 'completed', model: 'gpt-image-2.6-sunburst', format: 'png' }
    })
  }))
  const completed = await completedHandlers.get('get_image').handler({ job_id: JOB_ID }, {})
  assert.equal(completed.content.some((entry) => entry.type === 'image'), true)
})

test('list_image_models exposes per-model qualities and GIF support', async () => {
  const handlers = setup(completedClient())
  const result = await handlers.get('list_image_models').handler({}, {})
  assert.equal(result.structuredContent.ready, true)
  const flare = result.structuredContent.models.find((model) => model.id === 'gpt-image-2.6-flare')
  const legacy = result.structuredContent.models.find((model) => model.id === 'gpt-image-5-legacy')
  assert.equal(flare.supportsGif, true)
  assert.equal(legacy.supportsGif, false)
  assert.match(result.structuredContent.billingNote, /billed/)
})

test('credit tools map the wallet and usage fields', async () => {
  const handlers = setup(completedClient())
  const balance = await handlers.get('get_credit_balance').handler({}, {})
  assert.equal(balance.structuredContent.balance, 1234)
  assert.equal(balance.structuredContent.subscription.monthlyCredits, 500)
  const usage = await handlers.get('get_credit_usage').handler({ page_size: 10 }, {})
  assert.equal(usage.structuredContent.entries[0].delta, -12)
  assert.equal(usage.structuredContent.entries[0].id, '9')
})

test('credit tools convert billing units into display credits', async () => {
  const handlers = setup(completedClient({
    wallet: async () => ({
      balance: 160008437,
      walletBalance: 160008437,
      subscriptionBalance: 0,
      unlimited: false,
      currency: { unit: 'Credits', quotaPerUSD: 500000, unitsPerUSD: 10 },
      subscription: { monthly_credits: 5000000, active_until: 1_760_100_000 }
    }),
    usage: async () => ({
      entries: [{ id: '9', delta: -43981, model: 'deepseek-flash', kind: 'usage', created_at: 1_760_000_000 }],
      page: 1,
      pageSize: 10,
      total: 1,
      currency: { unit: 'Credits', quotaPerUSD: 500000, unitsPerUSD: 10 }
    })
  }))
  const balance = await handlers.get('get_credit_balance').handler({}, {})
  assert.equal(balance.structuredContent.balance, 3200.16874)
  assert.equal(balance.structuredContent.subscription.monthlyCredits, 100)
  assert.equal(balance.structuredContent.currency, 'Credits')
  assert.match(balance.content[0].text, /3200\.16874 Credits/)
  const usage = await handlers.get('get_credit_usage').handler({ page_size: 10 }, {})
  assert.equal(usage.structuredContent.entries[0].delta, -0.87962)
  assert.equal(usage.structuredContent.currency, 'Credits')
})

test('list_images returns metadata and no image bytes', async () => {
  const handlers = setup(completedClient())
  const result = await handlers.get('list_images').handler({ limit: 5 }, {})
  assert.equal(result.structuredContent.jobs.length, 1)
  assert.equal(result.content.length, 1)
})

test('cancel_image_jobs requires at least one id', async () => {
  const handlers = setup(completedClient())
  const result = await handlers.get('cancel_image_jobs').handler({}, {})
  assert.equal(result.isError, true)
  assert.match(result.content[0].text, /job_ids or request_ids/)
})

test('check_image_jobs summarizes statuses', async () => {
  const handlers = setup(completedClient())
  const result = await handlers.get('check_image_jobs').handler({ job_ids: [JOB_ID] }, {})
  assert.equal(result.structuredContent.jobs[0].status, 'completed')
  assert.match(result.content[0].text, /ready/)
})
