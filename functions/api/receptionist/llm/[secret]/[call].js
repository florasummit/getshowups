// GET (WebSocket) /api/receptionist/llm/:secret/:call — Retell's custom-LLM connection for one voice call we created.
// Retell sends no auth on this socket (docs.retellai.com/integrate-llm/setup-websocket-server), so the agent's
// llm_websocket_url carries a secret path segment (RETELL_WS_SECRET; Retell appends the call id). Optional
// RETELL_WS_IPS (comma-separated) also restricts the source IP. Then the call id — created by our server — is the only
// routing input; unknown, ended or expired calls are closed immediately.
import { hitByIp } from '../../../../../server/ratelimit.js'
import { timingSafeEqual } from '../../../../../server/google-oauth.js'
import { attachRetellSocket } from '../../../../../server/receptionist/voice.js'

export async function onRequestGet({ request, env, params }) {
  if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected WebSocket', { status: 426 })
  const rl = await hitByIp(env, 'receptionistSocket', request)
  if (rl.limited) return new Response('Too many requests', { status: 429 })
  const secret = String(env.RETELL_WS_SECRET || '')
  if (secret.length < 32) return new Response('Not configured', { status: 503 })
  if (!timingSafeEqual(String(params.secret || ''), secret)) return new Response('Forbidden', { status: 403 })
  const ips = String(env.RETELL_WS_IPS || '').split(',').map((s) => s.trim()).filter(Boolean)
  if (ips.length && !ips.includes(request.headers.get('CF-Connecting-IP') || '')) return new Response('Forbidden', { status: 403 })
  // eslint-disable-next-line no-undef -- Workers runtime global
  const pair = new WebSocketPair()
  const [client, server] = Object.values(pair)
  server.accept()
  await attachRetellSocket(env, server, String(params.call || ''))
  return new Response(null, { status: 101, webSocket: client })
}
