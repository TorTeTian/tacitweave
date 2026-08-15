const API_PATH = '/tacitweave/api'
const MAX_BODY_BYTES = 64 * 1024

export function registerMemoryDashboardApi(ctx, store) {
  return ctx.webServer.register({
    kind: 'exact',
    path: API_PATH,
    handler: async (req, res) => {
      if (!isLoopback(req.socket?.remoteAddress)) return send(res, 403, { error: 'loopback_only' })
      if (req.method === 'GET') return send(res, 200, store.dashboardState())
      if (req.method !== 'POST') return send(res, 405, { error: 'method_not_allowed' })
      if (!isSameOrigin(req)) return send(res, 403, { error: 'same_origin_required' })
      try {
        const input = JSON.parse(await readBody(req))
        const result = applyAction(store, input)
        return send(res, 200, { result, state: store.dashboardState() })
      } catch (error) {
        return send(res, 400, { error: String(error?.message ?? error) })
      }
    },
  })
}

export function applyAction(store, input) {
  if (!input || typeof input !== 'object') throw new Error('Request body must be an object.')
  if (input.action === 'update_controls') return store.updateControls(input.patch)
  if (input.action === 'set_memory_enabled') {
    if (!['long_term', 'temporary'].includes(input.kind)) throw new Error('Invalid memory kind.')
    if (typeof input.id !== 'string' || !input.id) throw new Error('Memory id is required.')
    if (typeof input.enabled !== 'boolean') throw new Error('enabled must be boolean.')
    return store.setMemoryEnabled(input.kind, input.id, input.enabled)
  }
  if (input.action === 'review_temporary') {
    if (typeof input.id !== 'string' || !input.id) throw new Error('Candidate id is required.')
    if (!['accept', 'reject', 'defer'].includes(input.decision)) throw new Error('Invalid review decision.')
    return store.applyReview(input.id, input.decision)
  }
  throw new Error('Unknown action.')
}

function isLoopback(address) {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

function isSameOrigin(req) {
  const origin = req.headers?.origin
  const host = req.headers?.host
  if (typeof origin !== 'string' || typeof host !== 'string') return false
  try {
    const parsed = new URL(origin)
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.host === host
  } catch {
    return false
  }
}

async function readBody(req) {
  let size = 0
  const chunks = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('Request body is too large.')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function send(res, status, value) {
  const body = JSON.stringify(value)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.setHeader('x-content-type-options', 'nosniff')
  res.end(body)
}
