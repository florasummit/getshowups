// GET /p/:customer — the business's public website (server-rendered, script-free, SEO-ready).
import { serveSite } from '../../server/site-serve.js'
import { missingConfig } from '../../server/google-oauth.js'
import { htmlResponse, renderNotice } from '../../server/site-render.js'

export async function onRequestGet({ request, env, params }) {
  if (missingConfig(env).length) return htmlResponse(503, renderNotice('This website isn’t available', 'Please try again later.'), { cache: 'no-store' })
  return serveSite(env, request, String(params.customer || '').toLowerCase())
}
