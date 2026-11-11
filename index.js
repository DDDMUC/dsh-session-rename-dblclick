// dsh-session-rename-dblclick — host half.
//
// One loopback-only route serves the browser half:
//
//   POST /dsh-session-rename/rename   { sessionId, title }
//     -> { ok: true, title, seq? }  |  { ok: false, code, error }
//
// The rename itself is the shipped `sessionController.rename` — the same call
// the built-in "重命名" menu row makes — so the accepted title, the durable
// `session/title` event and the sidebar/header projections stay exactly as the
// product defines them. No SDK import: every service resolves through the
// cordis context at call time, and a profile without the controller degrades to
// the `sessionTitle` fold instead of failing to load.
export const name = 'dsh-session-rename-dblclick'

const ROUTE_PREFIX = '/dsh-session-rename'
const MAX_TITLE = 200

// --- http --------------------------------------------------------------------

function isLoopbackAddress(address) {
  if (typeof address !== 'string' || address.length === 0) return false
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1' || address.startsWith('127.')
}

function isLocalHostHeader(host) {
  if (typeof host !== 'string' || host.length === 0) return false
  const name = host.split(':')[0].replace(/^\[|\]$/g, '').toLowerCase()
  return name === 'localhost' || name === '127.0.0.1' || name === '::1'
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk) => {
      data += chunk
      if (data.length > 1e6) req.destroy()
    })
    req.on('end', () => resolve(data))
    req.on('error', reject)
    req.on('aborted', () => reject(new Error('aborted')))
  })
}

// A write endpoint: loopback socket, loopback Host header, and a same-origin
// check when the browser sends Origin. Tunneled or LAN clients get 403 before
// any Session is touched.
function guard(req, res) {
  if (!isLoopbackAddress(req.socket && req.socket.remoteAddress)) {
    sendJson(res, 403, { ok: false, code: 'forbidden', error: 'loopback only' })
    return false
  }
  const host = req.headers.host
  if (!isLocalHostHeader(host)) {
    sendJson(res, 403, { ok: false, code: 'forbidden', error: 'unexpected host' })
    return false
  }
  const origin = req.headers.origin
  if (typeof origin === 'string' && origin.length > 0) {
    let originHost = null
    try {
      originHost = new URL(origin).host
    } catch {
      originHost = null
    }
    if (originHost !== host) {
      sendJson(res, 403, { ok: false, code: 'forbidden', error: 'cross-origin request' })
      return false
    }
  }
  return true
}

// --- rename ------------------------------------------------------------------

/**
 * Normalize a proposed title the way a single-line input would: collapse inner
 * whitespace, trim the ends, refuse an empty result, cap the length.
 * @returns {string | null} the title to persist, or null when nothing is left.
 */
function normalizeTitle(raw) {
  if (typeof raw !== 'string') return null
  const collapsed = raw.replace(/\s+/g, ' ').trim()
  if (collapsed.length === 0) return null
  return collapsed.slice(0, MAX_TITLE)
}

/**
 * Rename one Session through the shipped controller, falling back to the title
 * fold when this profile exposes no controller to a Host plugin.
 * @returns {Promise<{ title: string, seq?: number }>} the accepted title.
 */
async function renameSession(ctx, sessionId, title) {
  const controller = ctx.get('sessionController')
  if (controller && typeof controller.rename === 'function') {
    const value = await controller.rename({ sessionId, title })
    return {
      title: value && typeof value.title === 'string' ? value.title : title,
      seq: value && typeof value.seq === 'number' ? value.seq : undefined,
    }
  }
  const agents = ctx.get('agents')
  const titles = ctx.get('sessionTitle')
  const agent = agents && typeof agents.get === 'function' ? agents.get(sessionId) : undefined
  if (agent && agent.session && titles && typeof titles.rename === 'function') {
    const snapshot = titles.rename(agent.session, title)
    return { title: snapshot && typeof snapshot.title === 'string' ? snapshot.title : title }
  }
  throw new Error('sessionController unavailable')
}

// --- plugin ------------------------------------------------------------------

export function apply(ctx) {
  const registerRoutes = (webServer, fiber) => {
    fiber.effect(() => webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/rename`,
      handler: async (req, res) => {
        if (!guard(req, res)) return
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, code: 'method', error: 'POST only' })
          return
        }
        let body = {}
        try {
          const raw = await readBody(req)
          if (raw) body = JSON.parse(raw)
        } catch {
          sendJson(res, 400, { ok: false, code: 'invalid', error: 'malformed JSON body' })
          return
        }
        const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
        if (!sessionId) {
          sendJson(res, 400, { ok: false, code: 'invalid', error: 'sessionId required' })
          return
        }
        const title = normalizeTitle(body.title)
        if (!title) {
          sendJson(res, 400, { ok: false, code: 'invalid', error: 'title required' })
          return
        }
        try {
          const value = await renameSession(ctx, sessionId, title)
          sendJson(res, 200, { ok: true, ...value })
        } catch (error) {
          sendJson(res, 500, {
            ok: false,
            code: 'rename-failed',
            error: String((error && error.message) || error),
          })
        }
      },
    }))
  }

  const webServer = ctx.get('webServer')
  if (webServer) {
    registerRoutes(webServer, ctx)
  } else {
    try {
      ctx.inject(['webServer'], (sub) => registerRoutes(sub.webServer, sub))
    } catch {
      // no web carrier on this profile: the client half simply never posts
    }
  }
}
