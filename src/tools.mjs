import { z } from 'zod'
import { ApiClient, ApiError, isUuid, newRequestId } from './api.mjs'
import { AuthError, login } from './oauth.mjs'

const TERMINAL = new Set(['completed', 'failed', 'uncertain', 'expired'])
const POLL_INTERVAL_MS = 2000

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) {
    reject(new Error('cancelled'))
    return
  }
  const timer = setTimeout(() => {
    signal?.removeEventListener('abort', abort)
    resolve()
  }, ms)
  function abort() {
    clearTimeout(timer)
    reject(new Error('cancelled'))
  }
  signal?.addEventListener('abort', abort, { once: true })
})

const iso = (seconds) =>
  typeof seconds === 'number' && seconds > 0 ? new Date(seconds * 1000).toISOString() : undefined

// NewAPI reports wallet values as quota. The site converts quota to display
// credits with the account currency; older local ledgers already use credits.
const creditAmount = (value, currency) => {
  const amount = Number(value || 0)
  const per = Number(currency?.quotaPerUSD)
  const units = Number(currency?.unitsPerUSD)
  if (!Number.isFinite(per) || per <= 0 || !Number.isFinite(units) || units <= 0) return amount
  return Math.round((amount / per) * units * 1e6) / 1e6
}

const currencyUnit = (currency) =>
  typeof currency === 'string' ? currency : typeof currency?.unit === 'string' ? currency.unit : undefined

function jobSummary(job) {
  return {
    jobId: job.id,
    status: job.status,
    model: job.model,
    quality: job.quality,
    size: job.size,
    format: job.format,
    credits: job.credits,
    errorCode: job.error_code || job.errorCode || undefined,
    retryAfter: job.retry_after || job.retryAfter || undefined,
    createdAt: iso(job.created_at),
    expiresAt: iso(job.expires_at)
  }
}

function statusNote(job) {
  const summary = jobSummary(job)
  if (job.status === 'completed') return `Image ${job.id} is ready.`
  if (job.status === 'queued') return `Image ${job.id} is queued.`
  if (job.status === 'running') return `Image ${job.id} is still generating.`
  if (job.status === 'uncertain')
    return `Image ${job.id} has an uncertain provider result (${summary.errorCode || 'unknown'}). It may recover automatically; check it again later instead of resubmitting.`
  if (job.status === 'expired') return `Image ${job.id} expired before it finished.`
  return `Image ${job.id} failed${summary.errorCode ? ` (${summary.errorCode})` : ''}.`
}

function textResult(text, structuredContent, extraContent = []) {
  return {
    content: [{ type: 'text', text }, ...extraContent],
    structuredContent
  }
}

function errorResult(error) {
  const code = error?.code || 'error'
  const message = error?.message || 'The request failed.'
  const loginHint = error instanceof AuthError ? ' Call the `login` tool to sign in.' : ''
  return {
    isError: true,
    content: [{ type: 'text', text: `${message}${loginHint}${code !== 'error' ? ` [${code}]` : ''}` }],
    structuredContent: { error: { code, message } }
  }
}

async function pollJobs(client, ids, waitSeconds, signal) {
  const deadline = Date.now() + Math.max(0, waitSeconds) * 1000
  let jobs = []
  while (true) {
    const data = await client.statuses(ids)
    jobs = Array.isArray(data?.jobs) ? data.jobs : []
    if (jobs.length && jobs.every((job) => TERMINAL.has(job.status))) return jobs
    if (Date.now() >= deadline) return jobs
    await sleep(Math.min(POLL_INTERVAL_MS, Math.max(250, deadline - Date.now())), signal)
  }
}

const jobOutput = z.object({
  jobId: z.string(),
  status: z.string(),
  model: z.string().optional(),
  quality: z.string().optional(),
  size: z.string().optional(),
  format: z.string().optional(),
  credits: z.number().optional(),
  errorCode: z.string().optional(),
  retryAfter: z.number().optional(),
  createdAt: z.string().optional(),
  expiresAt: z.string().optional()
})

const imageOutput = z.object({
  jobId: z.string(),
  mimeType: z.string(),
  bytes: z.number()
})

export function registerTools(server, session) {
  const client = () => session.client

  const guarded = (handler) => async (args, extra) => {
    try {
      return await handler(args, extra)
    } catch (error) {
      if (error?.message === 'cancelled')
        return { isError: true, content: [{ type: 'text', text: 'The call was cancelled.' }] }
      return errorResult(error)
    }
  }

  const loginTool = guarded(async () => {
    if (session.loginPromise) return session.loginPromise
    session.loginPromise = (async () => {
      try {
        const credentials = await login(session.cfg, { log: (...args) => console.error(...args) })
        session.client = new ApiClient(session.cfg, credentials)
        return textResult(
          'Signed in to Sparkles. You can now generate images.',
          { authenticated: true, scope: credentials.scope, expiresAt: iso(Math.floor(credentials.expiresAt / 1000)) }
        )
      } finally {
        session.loginPromise = null
      }
    })()
    return session.loginPromise
  })

  server.registerTool(
    'login',
    {
      title: 'Sign in to Sparkles',
      description:
        'Open the Sparkles authorization page in the user\'s browser and wait for them to approve this MCP client. Call this when another tool reports that login is required. The user must have a Sparkles Editor account, and image generation spends credits from that account.',
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true }
    },
    loginTool
  )

  server.registerTool(
    'generate_image',
    {
      title: 'Generate images',
      description:
        'Generate 1-4 images from a text prompt with the user\'s Sparkles Editor account. This spends credits and submits the prompt to the site\'s moderation pipeline. Returns the generated image bytes when they are ready within the wait window; otherwise returns job ids for get_image. Use list_image_models first if the user has no model preference. GIF output requires a GPT Image 2.6 model and count=1.',
      inputSchema: {
        prompt: z.string().trim().min(3).max(32000).describe('Detailed image description. Write the full visual prompt, not a short keyword list.'),
        model: z.string().trim().max(150).optional().describe('Image model id from list_image_models. Defaults to the site default.'),
        quality: z.enum(['low', 'medium', 'high', 'xhigh', 'max', 'auto']).optional().describe('Output quality. Defaults to auto when the model supports it.'),
        size: z.string().regex(/^(auto|\d{2,4}x\d{2,4})$/).optional().describe('Pixel size such as 1024x1024, or auto.'),
        format: z.enum(['png', 'jpeg', 'webp', 'gif']).optional().describe('Output format. Defaults to png. GIF is supported only by GPT Image 2.6 models.'),
        count: z.number().int().min(1).max(4).optional().describe('Number of images. Defaults to 1; GIF requires 1.'),
        background: z.enum(['auto', 'opaque', 'transparent']).optional().describe('Background preference. Transparent requires png or webp.'),
        frame_count: z.number().int().min(2).max(16).optional().describe('GIF only: number of animation frames.'),
        frame_duration_ms: z.number().int().min(20).max(2000).refine((value) => value % 10 === 0, 'Must be a multiple of 10.').optional().describe('GIF only: frame delay in milliseconds, a multiple of 10.'),
        request_id: z.string().uuid().optional().describe('Optional idempotency UUID. Reuse the same value only when retrying the same request after a network error.'),
        wait_seconds: z.number().int().min(0).max(55).optional().describe('How long to wait for completion. Defaults to 45 seconds.')
      },
      outputSchema: {
        jobs: z.array(jobOutput),
        images: z.array(imageOutput),
        pending: z.boolean(),
        note: z.string().optional()
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
    },
    guarded(async (args, extra) => {
      const requestId = args.request_id || newRequestId()
      if (!isUuid(requestId)) throw new ApiError('request_id must be a UUID.', { code: 'invalid_request' })
      const format = args.format || 'png'
      if (format !== 'gif' && (args.frame_count || args.frame_duration_ms))
        throw new ApiError('frame_count and frame_duration_ms only apply to GIF output.', { code: 'invalid_request' })
      const created = await client().generate({
        prompt: args.prompt,
        model: args.model,
        quality: args.quality,
        size: args.size,
        format,
        count: args.count || 1,
        background: args.background,
        frameCount: args.frame_count,
        frameDurationMs: args.frame_duration_ms,
        requestId
      })
      const images = []
      const imageContent = []
      const notes = []
      const jobs = await pollJobs(client(), created.ids, args.wait_seconds ?? 45, extra?.signal)
      if (!jobs.length)
        throw new ApiError('Sparkles did not return the new image job. Check list_images before retrying.', { code: 'not_found' })
      if (jobs.length < created.ids.length)
        notes.push(`Only ${jobs.length} of ${created.ids.length} jobs were returned.`)
      for (const job of jobs) {
        if (job.status !== 'completed') continue
        try {
          const image = await client().image(job.id)
          images.push({ jobId: job.id, mimeType: image.mimeType, bytes: image.bytes })
          imageContent.push({ type: 'image', data: image.data, mimeType: image.mimeType })
        } catch (error) {
          notes.push(`${job.id}: ${error.message}`)
        }
      }
      const pending = jobs.some((job) => !TERMINAL.has(job.status))
      const failed = jobs.filter((job) => ['failed', 'uncertain', 'expired'].includes(job.status))
      const lines = jobs.map(statusNote)
      if (pending) lines.push('Call get_image with the job id once it finishes.')
      if (notes.length) lines.push(...notes)
      const result = textResult(lines.join('\n'), {
        jobs: jobs.map(jobSummary),
        images,
        pending,
        ...(notes.length ? { note: notes.join(' ') } : {})
      }, imageContent)
      if (failed.length && !images.length) result.isError = true
      return result
    })
  )

  server.registerTool(
    'get_image',
    {
      title: 'Get a generated image',
      description:
        'Fetch the current status of one image job, and return the image bytes if it is complete. Use this after generate_image reports that a job is still running, or to inspect an older job id.',
      inputSchema: {
        job_id: z.string().uuid().describe('Image job id returned by generate_image or list_images.')
      },
      outputSchema: {
        job: jobOutput,
        image: imageOutput.optional()
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true }
    },
    guarded(async (args) => {
      const data = await client().job(args.job_id)
      const job = data?.job
      if (!job) throw new ApiError('Image job not found.', { code: 'not_found' })
      const summary = jobSummary(job)
      if (job.status !== 'completed')
        return textResult(statusNote(job), { job: summary })
      const image = await client().image(job.id)
      return textResult(
        `Image ${job.id} is ready (${image.mimeType}, ${Math.round(image.bytes / 1024)} KB).`,
        { job: summary, image: { jobId: job.id, mimeType: image.mimeType, bytes: image.bytes } },
        [{ type: 'image', data: image.data, mimeType: image.mimeType }]
      )
    })
  )

  server.registerTool(
    'list_images',
    {
      title: 'List recent images',
      description:
        'List the user\'s recent image jobs with status and metadata. This does not download image bytes; call get_image with a job id for that.',
      inputSchema: {
        limit: z.number().int().min(1).max(30).optional().describe('Maximum jobs to return. Defaults to 20.'),
        view: z.enum(['artwork', 'all', 'failed', 'prompts']).optional().describe('artwork lists visible generated images; all includes every job. Defaults to artwork.'),
        saved: z.boolean().optional().describe('Only list images the user saved.'),
        cursor: z.string().max(512).optional().describe('Opaque nextCursor from a previous list_images call.')
      },
      outputSchema: {
        jobs: z.array(jobOutput),
        hasMore: z.boolean(),
        nextCursor: z.string().nullable().optional()
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true }
    },
    guarded(async (args) => {
      const data = await client().listJobs({
        limit: args.limit || 20,
        view: args.view || 'artwork',
        saved: args.saved === true,
        cursor: args.cursor
      })
      const jobs = (data?.jobs || []).map(jobSummary)
      return textResult(
        jobs.length ? `Found ${jobs.length} image job(s).` : 'No image jobs matched.',
        { jobs, hasMore: !!data?.hasMore, nextCursor: data?.nextCursor || null }
      )
    })
  )

  server.registerTool(
    'check_image_jobs',
    {
      title: 'Check image jobs',
      description: 'Check the status of up to 50 image jobs without downloading the images.',
      inputSchema: {
        job_ids: z.array(z.string().uuid()).min(1).max(50).describe('Image job ids to check.')
      },
      outputSchema: { jobs: z.array(jobOutput) },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true }
    },
    guarded(async (args) => {
      const data = await client().statuses(args.job_ids)
      const jobs = (data?.jobs || []).map(jobSummary)
      return textResult(jobs.map(statusNote).join('\n') || 'No jobs found.', { jobs })
    })
  )

  server.registerTool(
    'cancel_image_jobs',
    {
      title: 'Cancel image jobs',
      description:
        'Cancel queued image jobs. Jobs already running or completed cannot be cancelled. Use job ids returned by generate_image/list_images, or the request_id used to create a job.',
      inputSchema: {
        job_ids: z.array(z.string().uuid()).max(50).optional().describe('Image job ids to cancel.'),
        request_ids: z.array(z.string().uuid()).max(50).optional().describe('Request ids used when the jobs were created.')
      },
      outputSchema: { jobs: z.array(jobOutput) },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true }
    },
    guarded(async (args) => {
      if (!args.job_ids?.length && !args.request_ids?.length)
        throw new ApiError('Provide job_ids or request_ids.', { code: 'invalid_request' })
      const data = await client().cancel({ ids: args.job_ids || [], requestIds: args.request_ids || [] })
      const jobs = (data?.jobs || []).map(jobSummary)
      return textResult(jobs.length ? `Cancellation checked for ${jobs.length} job(s).` : 'No matching jobs were found.', { jobs })
    })
  )

  server.registerTool(
    'list_image_models',
    {
      title: 'List image models',
      description:
        'List the image models, qualities, and output formats currently available to this account, plus the site default model. Call this before choosing a non-default model or GIF output.',
      outputSchema: {
        ready: z.boolean(),
        defaultModel: z.string().optional(),
        provider: z.string().optional(),
        models: z.array(z.object({
          id: z.string(),
          qualities: z.array(z.string()),
          supportsGif: z.boolean()
        })),
        formats: z.array(z.string()),
        billingNote: z.string()
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true }
    },
    guarded(async () => {
      const catalog = await client().catalog()
      const byModel = new Map()
      for (const price of catalog?.prices || []) {
        if (!byModel.has(price.model)) byModel.set(price.model, [])
        byModel.get(price.model).push(price.quality)
      }
      const models = [...byModel.entries()].map(([id, qualities]) => ({
        id,
        qualities,
        supportsGif: /^gpt-image-2\.6-/.test(id)
      }))
      const billingNote =
        'Image generation is billed from the user\'s Sparkles account. Usage-based models report 0 credits in the catalog; call get_credit_usage after generation to see the charged amount.'
      return textResult(
        models.length
          ? `${models.length} image model(s) available. Default: ${catalog.defaultModel}.\n${billingNote}`
          : 'No image models are currently available.',
        {
          ready: !!catalog?.ready,
          defaultModel: catalog?.defaultModel || undefined,
          provider: catalog?.provider || undefined,
          models,
          formats: ['png', 'jpeg', 'webp', 'gif'],
          billingNote
        }
      )
    })
  )

  server.registerTool(
    'get_credit_balance',
    {
      title: 'Get credit balance',
      description: 'Read the Sparkles credits available to this account, including any subscription balance.',
      outputSchema: {
        balance: z.number(),
        walletBalance: z.number().optional(),
        subscriptionBalance: z.number().optional(),
        unlimited: z.boolean().optional(),
        currency: z.string().optional(),
        subscription: z.object({
          monthlyCredits: z.number().optional(),
          activeUntil: z.string().optional()
        }).nullable().optional()
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true }
    },
    guarded(async () => {
      const wallet = await client().wallet()
      const currency = wallet?.currency
      const subscription = wallet?.subscription
        ? {
            monthlyCredits: creditAmount(wallet.subscription.monthly_credits, currency),
            activeUntil: iso(wallet.subscription.active_until)
          }
        : null
      const structured = {
        balance: creditAmount(wallet?.balance, currency),
        walletBalance: creditAmount(wallet?.walletBalance, currency),
        subscriptionBalance: creditAmount(wallet?.subscriptionBalance, currency),
        unlimited: !!wallet?.unlimited,
        currency: currencyUnit(currency),
        subscription
      }
      const text = structured.unlimited
        ? 'This account has unlimited image credits.'
        : `Available balance: ${structured.balance}${structured.currency ? ` ${structured.currency}` : ''}.`
      return textResult(text, structured)
    })
  )

  server.registerTool(
    'get_credit_usage',
    {
      title: 'Get credit usage',
      description: 'Read recent Sparkles credit usage, including image generation charges. Amounts are negative for spending and positive for refunds.',
      inputSchema: {
        page: z.number().int().min(1).max(1000000).optional().describe('Page number. Defaults to 1.'),
        page_size: z.union([z.literal(10), z.literal(20), z.literal(50)]).optional().describe('Entries per page. Defaults to 10.')
      },
      outputSchema: {
        entries: z.array(z.object({
          id: z.string(),
          delta: z.number(),
          model: z.string(),
          kind: z.string(),
          createdAt: z.string().optional()
        })),
        page: z.number(),
        pageSize: z.number(),
        total: z.number(),
        currency: z.string().optional()
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true }
    },
    guarded(async (args) => {
      const data = await client().usage({ page: args.page || 1, pageSize: args.page_size || 10 })
      const currency = data?.currency
      const entries = (data?.entries || []).map((entry) => ({
        id: String(entry.id),
        delta: creditAmount(entry.delta, currency),
        model: entry.model || '',
        kind: entry.kind || 'usage',
        createdAt: iso(entry.created_at)
      }))
      return textResult(
        entries.length
          ? entries.map((entry) => `${entry.createdAt || ''} ${entry.kind} ${entry.delta} ${entry.model}`.trim()).join('\n')
          : 'No credit usage was found.',
        {
          entries,
          page: Number(data?.page || 1),
          pageSize: Number(data?.pageSize || 10),
          total: Number(data?.total || 0),
          currency: currencyUnit(currency)
        }
      )
    })
  )
}
