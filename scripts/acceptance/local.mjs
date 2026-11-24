// Serves the built dashboard and the REAL dashboard handlers on 127.0.0.1 over synthetic businesses (worlds.mjs), with the
// real assistant model. Google, email, texts, ads and payments are not configured, so nothing can leave this machine except
// the model calls. Key: OPERATOR_ANTHROPIC_API_KEY in the caller's environment (never stored or printed).
import { createServer } from 'node:http'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { extname, join } from 'node:path'
import { world } from './worlds.mjs'

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.woff2': 'font/woff2', '.webp': 'image/webp', '.jpg': 'image/jpeg' }
export async function serve(dist, port = 8799) {
  const sql = world()
  const stmt = (q, a = []) => ({ q, args: a, bind: (...x) => stmt(q, x), first: async () => sql.prepare(q).get(...a) ?? null, all: async () => ({ results: sql.prepare(q).all(...a) }), run: async () => ({ meta: { changes: Number(sql.prepare(q).run(...a).changes) } }) })
  const origin = `http://127.0.0.1:${port}`
  const env = {
    GOOGLE_CLIENT_ID: 'c', GOOGLE_CLIENT_SECRET: 's', GOOGLE_REDIRECT_URI: `${origin}/api/google/oauth/callback`, TOKEN_ENCRYPTION_KEY: 'k'.repeat(44), ADMIN_API_TOKEN: 'a'.repeat(40),
    ONBOARDING_DB: { prepare: (q) => stmt(q), batch: async (l) => l.map((s) => ({ meta: { changes: Number(sql.prepare(s.q).run(...s.args).changes) } })) },
    GOOGLE_TOKENS: { get: async (k) => (String(k).startsWith('google:') ? '{}' : null), put: async () => {}, delete: async () => {} },
    OPERATOR_PROVIDER: 'claude', OPERATOR_ANTHROPIC_API_KEY: process.env.OPERATOR_ANTHROPIC_API_KEY, OPERATOR_BUSINESS_DAILY_USD: '1',
  }
  // Model comparison only (docs/INTELLIGENCE.md 5): the same product with another model or effort; never used in production.
  if (process.env.ACCEPTANCE_MODEL) {
    const { default: Anthropic } = await import('@anthropic-ai/sdk')
    const real = new Anthropic({ apiKey: env.OPERATOR_ANTHROPIC_API_KEY, maxRetries: 2 })
    const [model, effort] = process.env.ACCEPTANCE_MODEL.split(':')
    env.ANTHROPIC_CLIENT = { messages: { create: (b) => real.messages.create({ ...b, model, output_config: { effort } }) } }
  }
  const route = (path) => [`${path}.js`, `${path}/index.js`].map((p) => new URL(`../../functions${p}`, import.meta.url)).find((u) => existsSync(u))
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, origin)
    const send = (status, type, body) => (res.writeHead(status, { 'Content-Type': type }), res.end(body))
    if (url.pathname.startsWith('/api/')) {
      const file = /^[\w/-]+$/.test(url.pathname) && route(url.pathname)
      if (!file) return send(404, 'application/json', '{"error":"not_found"}')
      const chunks = []
      for await (const c of req) chunks.push(c)
      const handler = (await import(file))[req.method === 'POST' ? 'onRequestPost' : 'onRequestGet']
      if (!handler) return send(405, 'application/json', '{}')
      try {
        const r = await handler({ request: new Request(url, { method: req.method, headers: req.headers, ...(chunks.length ? { body: Buffer.concat(chunks) } : {}) }), env, params: {}, waitUntil: () => {} })
        return send(r.status, r.headers.get('Content-Type') || 'application/json', await r.text())
      } catch (err) {
        console.error('handler failed', url.pathname, err?.message)
        return send(500, 'application/json', '{"error":"failed"}')
      }
    }
    const f = join(dist, url.pathname)
    const file = f.startsWith(dist) && existsSync(f) && statSync(f).isFile() ? f : join(dist, 'index.html')
    send(200, TYPES[extname(file)] || 'application/octet-stream', readFileSync(file))
  })
  await new Promise((ok) => server.listen(port, '127.0.0.1', ok))
  return { origin, sql, close: () => server.close(), usage: () => sql.prepare("SELECT customer, props FROM events WHERE type = 'ai_ask' ORDER BY at").all().map((r) => ({ customer: r.customer, ...JSON.parse(r.props) })), clearLimits: () => sql.exec('DELETE FROM rate_limits') }
}
