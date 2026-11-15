// GET /p/:customer/:page — another page of an AI-designed (multi-page) website. Same rules as /p/:customer.
import { serveSite } from '../../../server/site-serve.js'
import { missingConfig } from '../../../server/google-oauth.js'
import { htmlResponse, renderNotice } from '../../../server/site-render.js'

export async function onRequestGet({ request, env, params }) {
  if (missingConfig(env).length) return htmlResponse(503, renderNotice('This website isn’t available', 'Please try again later.'), { cache: 'no-store' })
  const page = String(params.page || '').toLowerCase()
  if (!/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/.test(page)) return htmlResponse(404, renderNotice('This website isn’t available', 'Check the address and try again.'), { cache: 'no-store' })
  return serveSite(env, request, String(params.customer || '').toLowerCase(), page)
}
