// GET (WebSocket) /api/receptionist/llm/:call — Retell's custom-LLM connection for one voice call we created.
// The call id is the only routing input; unknown, ended or expired calls are closed immediately.
import { hitByIp } from '../../../../server/ratelimit.js'
import { attachRetellSocket } from '../../../../server/receptionist/voice.js'

export async function onRequestGet({ request, env, params }) {
  if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected WebSocket', { status: 426 })
  const rl = await hitByIp(env, 'receptionistSocket', request)
  if (rl.limited) return new Response('Too many requests', { status: 429 })
  // eslint-disable-next-line no-undef -- Workers runtime global
  const pair = new WebSocketPair()
  const [client, server] = Object.values(pair)
  server.accept()
  await attachRetellSocket(env, server, String(params.call || ''))
  return new Response(null, { status: 101, webSocket: client })
}
