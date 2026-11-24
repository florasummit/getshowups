// Voice reliability harness: mocked Retell custom-LLM frames + a mocked Anthropic streaming API (loopback mock origin,
// timed server-sent events that honour abort) drive the real socket handler (server/receptionist/voice.js) and engine.
// It measures time to first spoken chunk, whole-turn time and tool time, and checks protocol behaviour: barge-in
// aborts the stale answer, the holding line is spoken when a slow tool starts, a failed turn never silences the call,
// a frame without a response_id can't disable staleness checks, keepalive is answered during a turn, words of a
// talked-over turn are not lost, and a booking that already happened is never dropped by an interruption.
// VOICE_BENCH=1 prints the latency table (mocked harness only; numbers are our own overhead, not Retell/Claude).
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { encrypt } from '../server/google-oauth.js'
import { attachRetellSocket } from '../server/receptionist/voice.js'
import { startConversation } from '../server/receptionist/engine.js'

const MOCK = 'http://127.0.0.1:9931'
const KEY = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
const SECRETS = ['sk-ant-test-SECRET', '1//rt', 'ya29.at', KEY]

function d1() {
  const sql = new DatabaseSync(':memory:')
  for (const f of readdirSync(new URL('../migrations/', import.meta.url)).sort()) sql.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8'))
  const stmt = (q, args = []) => ({
    q,
    args,
    bind: (...a) => stmt(q, a),
    first: async () => sql.prepare(q).get(...args) ?? null,
    all: async () => ({ results: sql.prepare(q).all(...args) }),
    run: async () => ({ meta: { changes: sql.prepare(q).run(...args).changes } }),
  })
  return {
    sql,
    prepare: (q) => stmt(q),
    batch: async (list) => {
      sql.exec('BEGIN')
      try {
        for (const s of list) sql.prepare(s.q).run(...s.args)
        sql.exec('COMMIT')
      } catch (e) {
        sql.exec('ROLLBACK')
        throw e
      }
    },
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
// A scripted model answer, streamed: `firstMs` before the first event, `gapMs` between text pieces, `stallMs` after
// the last content block before the message ends (a slow tail, e.g. a long tool input).
const said = (text, o = {}) => ({ content: [{ type: 'text', text }], stop_reason: 'end_turn', ...o })
const tools = (uses, o = {}) => ({ content: uses, stop_reason: 'tool_use', ...o })
const use = (name, input) => ({ type: 'tool_use', id: `toolu_${Math.random().toString(36).slice(2, 10)}`, name, input })

function timedSse(out, model, signal) {
  const enc = new TextEncoder()
  const ev = (type, data) => enc.encode(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
  let aborted = false
  const body = new ReadableStream({
    async start(c) {
      const onAbort = () => {
        aborted = true
        try {
          c.error(new DOMException('aborted', 'AbortError'))
        } catch {}
      }
      signal?.addEventListener('abort', onAbort)
      const push = async (chunk, wait = 0) => {
        if (wait) await sleep(wait)
        if (!aborted) c.enqueue(chunk)
      }
      await push(ev('message_start', { message: { id: 'msg_t', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1000, output_tokens: 1 } } }), out.firstMs || 0)
      for (const [i, b] of out.content.entries()) {
        if (b.type === 'text') {
          await push(ev('content_block_start', { index: i, content_block: { type: 'text', text: '' } }))
          for (const piece of b.text.match(/.{1,12}/gs) || []) await push(ev('content_block_delta', { index: i, delta: { type: 'text_delta', text: piece } }), out.gapMs || 0)
        } else {
          await push(ev('content_block_start', { index: i, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } }))
          await push(ev('content_block_delta', { index: i, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } }), out.gapMs || 0)
        }
        await push(ev('content_block_stop', { index: i }))
      }
      await push(ev('message_delta', { delta: { stop_reason: out.stop_reason, stop_sequence: null }, usage: { output_tokens: 40 } }), out.stallMs || 0)
      await push(ev('message_stop', {}))
      signal?.removeEventListener('abort', onAbort)
      if (!aborted) c.close()
    },
  })
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
}

let env, db, kv, script, modelRequests, origFetch, origError, logs, busy, googleDelayMs

beforeEach(() => {
  db = d1()
  kv = new Map()
  script = []
  modelRequests = []
  busy = []
  googleDelayMs = 0
  env = {
    GOOGLE_CLIENT_ID: 'cid',
    GOOGLE_CLIENT_SECRET: 'cs',
    GOOGLE_REDIRECT_URI: 'https://getshowups.com/api/google/oauth/callback',
    TOKEN_ENCRYPTION_KEY: KEY,
    ADMIN_API_TOKEN: 'a'.repeat(40),
    ONBOARDING_DB: db,
    GOOGLE_TOKENS: { get: async (k) => kv.get(k) ?? null, put: async (k, v) => kv.set(k, v), delete: async (k) => kv.delete(k), list: async () => ({ keys: [], list_complete: true }) },
    RECEPTIONIST_ANTHROPIC_API_KEY: 'sk-ant-test-SECRET',
    AI_API_MOCK_ORIGIN: MOCK,
    RECEPTIONIST_VOICE_BUSINESSES: 'alpha', // voice released for the test business (voice gate)
  }
  origFetch = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url)
    const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
    if (u === `${MOCK}/anthropic/v1/messages`) {
      const body = JSON.parse(init.body)
      const req = { body, signal: init.signal, at: Date.now() }
      modelRequests.push(req)
      const step = script.shift()
      if (!step) return json(500, { type: 'error', error: { type: 'api_error', message: 'no scripted step' } })
      if (step.status) return json(step.status, { type: 'error', error: { type: 'invalid_request_error', message: 'x' } })
      const out = typeof step === 'function' ? await step(body) : step
      return timedSse(out, body.model, init.signal)
    }
    if (u === 'https://oauth2.googleapis.com/token') return json(200, { access_token: 'ya29.at', scope: 'x', expires_in: 3600 })
    if (u.endsWith('/freeBusy')) {
      if (googleDelayMs) await sleep(googleDelayMs)
      return json(200, { calendars: { primary: { busy } } })
    }
    if (u.includes('/events?sendUpdates=all')) return json(200, { id: JSON.parse(init.body).id })
    throw new Error(`unexpected ${u}`)
  }
  logs = []
  origError = console.error
  console.error = (...a) => logs.push(a.map(String).join(' '))
})

afterEach(() => {
  globalThis.fetch = origFetch
  console.error = origError
  for (const s of SECRETS) assert.ok(!logs.join('\n').includes(s), `secret leaked: ${s.slice(0, 8)}`)
})

async function seed(id) {
  const t = Date.now()
  db.sql
    .prepare("INSERT INTO customers (id, name, timezone, service_zips, day_start, day_end, workdays, hours_confirmed_at, created_at, updated_at) VALUES (?, ?, 'UTC', '29401,29403', '00:00', '23:00', '0,1,2,3,4,5,6', ?, ?, ?)")
    .run(id, `${id} Co`, t, t, t)
  db.sql.prepare('INSERT INTO customer_users (email, customer, created_at) VALUES (?, ?, ?)').run(`owner@${id}.example`, id, t)
  db.sql
    .prepare("INSERT INTO business_profiles (customer, phone, industry, description, services, cities, updated_at) VALUES (?, '(843) 555-0199', 'Pool service', 'Family-run pool care.', ?, '[\"Charleston\"]', ?)")
    .run(id, JSON.stringify([{ name: 'Weekly pool care', price: '$280/month' }]), t)
  db.sql.prepare('INSERT OR REPLACE INTO receptionist_settings (customer, enabled, mode, updated_at) VALUES (?, 1, ?, 1)').run(id, 'ai_first')
  kv.set(`google:${id}`, JSON.stringify({ customer: id, clientId: 'cid', scope: 'x', refreshToken: await encrypt({ TOKEN_ENCRYPTION_KEY: KEY }, '1//rt') }))
}

// A Retell-like socket: records what we send with the time it was sent.
function ws() {
  const sent = []
  const handlers = {}
  return { sent, handlers, send: (s) => sent.push({ ...JSON.parse(s), t: Date.now() }), close: (code) => sent.push({ closed: code, t: Date.now() }), addEventListener: (t, f) => (handlers[t] = f) }
}
async function callFor(id) {
  const conv = await startConversation(env, { id }, 'voice')
  const callId = `call_${Math.random().toString(36).slice(2, 14)}`
  db.sql.prepare("INSERT INTO receptionist_calls (call_id, customer, conversation_id, provider, created_at) VALUES (?, ?, ?, 'retell', ?)").run(callId, id, conv.id, Date.now())
  const s = ws()
  assert.equal(await attachRetellSocket(env, s, callId), true)
  return { s, callId, convId: conv.id }
}
const frame = (s, o) => s.handlers.message({ data: JSON.stringify(o) })
const ask = (s, id, transcript) => frame(s, { interaction_type: 'response_required', response_id: id, transcript })
const until = async (fn, ms = 3000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (fn()) return true
    await sleep(5)
  }
  return false
}
const done = (s, id) => s.sent.some((m) => m.response_id === id && m.content_complete === true)
const turnEvents = (convId) =>
  db.sql
    .prepare("SELECT detail FROM receptionist_events WHERE conversation_id = ? AND kind = 'voice_turn' ORDER BY id")
    .all(convId)
    .map((r) => Object.fromEntries(r.detail.split(';').map((kv) => kv.split('=')).map(([k, v]) => [k, /^-?\d+$/.test(v) ? Number(v) : v])))
const pct = (xs, p) => {
  const a = [...xs].sort((x, y) => x - y)
  return a[Math.min(a.length - 1, Math.ceil((p / 100) * a.length) - 1)]
}

test('latency harness: first chunk follows the model\'s first token closely; timings are recorded as numbers only', async () => {
  await seed('alpha')
  const N = Number(process.env.VOICE_BENCH_N) || 20
  const FIRST = 40
  const t = []
  // 40 turns per call (conversations stop at 60 turns by design), as many calls as needed for N turns.
  for (let done0 = 0; done0 < N; ) {
    const { s, convId } = await callFor('alpha')
    const transcript = [{ role: 'agent', content: 'Hi' }]
    for (let i = 1; i <= Math.min(40, N - done0); i++) {
      script.push(said('Sure, I can help with that. What is your ZIP code?', { firstMs: FIRST, gapMs: 2 }))
      transcript.push({ role: 'user', content: `question number ${i}` })
      ask(s, i, transcript)
      assert.ok(await until(() => done(s, i)), `turn ${i} answered`)
      transcript.push({ role: 'agent', content: 'Sure, I can help with that. What is your ZIP code?' })
    }
    const got = turnEvents(convId)
    t.push(...got)
    done0 += got.length
  }
  assert.equal(t.length, N)
  assert.ok(t.every((e) => e.r === 'ok' && e.tok >= FIRST && e.first >= e.tok && e.total >= e.first && e.calls === 1 && e.hold === -1), JSON.stringify(t[0]))
  // Our overhead before the first spoken words (D1 reads, prompt build, SDK), on top of the model's first token;
  // the gap between the model's first token (tok) and the first whole sentence handed to Retell (first).
  const overhead = t.map((e) => e.first - FIRST)
  const before = t.map((e) => e.tok - FIRST)
  const sentence = t.map((e) => e.first - e.tok)
  const totals = t.map((e) => e.total)
  if (process.env.VOICE_BENCH) console.log(JSON.stringify({ harness: 'mocked', n: N, modelFirstTokenMs: FIRST, beforeModelP50: pct(before, 50), beforeModelP95: N >= 20 ? pct(before, 95) : null, firstTokenToSentenceP50: pct(sentence, 50), overheadP50: pct(overhead, 50), overheadP95: N >= 20 ? pct(overhead, 95) : null, overheadMax: Math.max(...overhead), totalP50: pct(totals, 50), totalP95: N >= 20 ? pct(totals, 95) : null }))
  assert.ok(pct(overhead, 50) < 250, `overhead P50 ${pct(overhead, 50)} ms`)
  // Events carry codes and numbers only (no transcript text).
  const raw = db.sql.prepare("SELECT detail FROM receptionist_events WHERE kind = 'voice_turn'").all().map((r) => r.detail).join('|')
  assert.ok(!/question|ZIP/i.test(raw))
  assert.match(raw, /^r=ok;q=\d+;tok=\d+;first=\d+;hold=-1;total=\d+;model=\d+;tools=\d+;calls=1/)
})

test('barge-in: the stale answer is aborted at once, so the new turn does not wait for it', async () => {
  await seed('alpha')
  const { s, convId } = await callFor('alpha')
  // Turn 1: first words quickly, then a 3 s stall (a slow model). The caller talks over it at ~60 ms.
  script.push(said('Let me think about that one. It depends on a lot of things really.', { firstMs: 10, gapMs: 1, stallMs: 3000 }))
  script.push((body) => {
    const words = body.messages.filter((m) => m.role === 'user' && typeof m.content === 'string').map((m) => m.content)
    assert.deepEqual(words, ['how much is it actually'], 'the dropped turn is not in the history; its words arrive once')
    return said('Weekly pool care is $280/month.', { firstMs: 20 })
  })
  ask(s, 1, [{ role: 'agent', content: 'Hi' }, { role: 'user', content: 'how much is it' }])
  await sleep(60)
  const t2 = Date.now()
  ask(s, 2, [{ role: 'agent', content: 'Hi' }, { role: 'user', content: 'how much is it actually' }])
  assert.ok(await until(() => done(s, 2)), 'turn 2 answered')
  const first2 = s.sent.find((m) => m.response_id === 2 && m.content)
  assert.ok(first2.t - t2 < 1000, `turn 2 first chunk after ${first2.t - t2} ms (a non-aborted stale answer would hold it ~3 s)`)
  assert.equal(modelRequests[0].signal?.aborted, true, 'the stale model request was aborted')
  const ev = db.sql.prepare('SELECT kind, detail FROM receptionist_events WHERE conversation_id = ? ORDER BY id').all(convId).map((e) => `${e.kind}:${e.detail}`)
  assert.ok(ev.includes('turn:talked_over'))
  assert.ok(!ev.some((e) => e.startsWith('model:')), 'an interruption is never recorded as a model failure')
  const turns = turnEvents(convId)
  assert.deepEqual(turns.map((e) => e.r), ['stale', 'ok'])
  // The aborted call was billed (1000 input + 1 output tokens, as the stream reported): its cost is on the conversation with turn 2's.
  assert.equal(db.sql.prepare('SELECT cost_micros FROM receptionist_conversations WHERE id = ?').get(convId).cost_micros, 4020 + 4000 + 40 * 20)
})

test('cost and latency shape of a turn: the conversation is cached as well as the prompt, and the record reads run together', async () => {
  await seed('alpha')
  const { s } = await callFor('alpha')
  script.push(said('Weekly pool care is $280/month.', { firstMs: 1 }))
  const prepare = db.prepare
  // Production D1 takes ~90 ms per read; here 60 ms each. Read one after another the turn's eight reads took ~480 ms.
  db.prepare = (q) => {
    const wrap = (st) => ({ ...st, bind: (...x) => wrap(st.bind(...x)), first: async () => (await sleep(60), st.first()) })
    return wrap(prepare(q))
  }
  const t = Date.now()
  ask(s, 1, [{ role: 'agent', content: 'Hi' }, { role: 'user', content: 'how much is it' }])
  assert.ok(await until(() => done(s, 1)), 'answered')
  assert.ok(modelRequests[0].at - t < 300, `model asked after ${modelRequests[0].at - t} ms`)
  const { body } = modelRequests[0]
  assert.deepEqual([body.cache_control, body.system[0].cache_control], [{ type: 'ephemeral' }, { type: 'ephemeral' }])
  // Per-turn telemetry for both channels: numbers only, short enough to be stored whole.
  const usage = db.sql.prepare("SELECT detail FROM receptionist_events WHERE kind = 'turn_usage'").get().detail
  assert.match(usage, /^ch=voice;total=\d+;model=\d+;tools=\d+;calls=1;in=1000;cr=0;cw=0;out=40;c=4800$/)
  assert.ok(usage.length < 120)
})

// Changed with the conditional holding line (HOLD_AFTER_MS): a quick lookup is answered directly; the line is spoken
// only when the caller would otherwise wait, timed from the tool call's start (not from the end of the model call).
test('holding line: a quick calendar lookup gets none; a slow one gets it once, about HOLD_AFTER_MS after the tool call started and before the tool returned', async () => {
  const { HOLD_AFTER_MS } = await import('../server/receptionist/engine.js')
  await seed('alpha')
  const { s, convId } = await callFor('alpha')
  // Quick: tool call streamed in ~10 ms, Google at once, the answer's first token 10 ms later → no holding line.
  script.push(tools([use('find_available_times', { date: '', part_of_day: 'any' })], { firstMs: 10 }))
  script.push(said('I have Tuesday at 9 or Wednesday at 2.', { firstMs: 10 }))
  ask(s, 1, [{ role: 'user', content: 'when can you come' }])
  assert.ok(await until(() => done(s, 1)))
  assert.deepEqual(s.sent.filter((m) => m.response_id === 1 && m.content).map((m) => m.content), ['I have Tuesday at 9 or Wednesday at 2.'], 'direct answer, no holding line')
  // Slow: Google takes 1.5 s → the line at ~HOLD_AFTER_MS after the tool call started, once; the answer after it.
  googleDelayMs = 1500
  const t0 = Date.now()
  script.push(tools([use('find_available_times', { date: '', part_of_day: 'morning' })], { firstMs: 10 }))
  script.push(said('Thursday at 11 works.', { firstMs: 10 }))
  ask(s, 2, [{ role: 'user', content: 'when can you come' }, { role: 'agent', content: 'I have Tuesday at 9 or Wednesday at 2.' }, { role: 'user', content: 'any mornings' }])
  assert.ok(await until(() => done(s, 2), 5000))
  const hold = s.sent.find((m) => m.response_id === 2 && m.content === 'One moment while I check the calendar.')
  assert.ok(hold, 'holding line spoken')
  assert.ok(hold.t - t0 >= HOLD_AFTER_MS - 50 && hold.t - t0 < HOLD_AFTER_MS + 400, `holding line after ${hold.t - t0} ms (Google took 1500 ms)`)
  assert.equal(s.sent.filter((m) => m.content === 'One moment while I check the calendar.').length, 1, 'said once')
  assert.deepEqual(s.sent.filter((m) => m.response_id === 2 && m.content).map((m) => m.content), ['One moment while I check the calendar.', 'Thursday at 11 works.'])
  const [quick, slow] = turnEvents(convId)
  assert.equal(quick.hold, -1)
  // The holding line is the first chunk Retell gets (hold == first); the answer's first token (tok) comes after the tool.
  assert.ok(slow.hold >= HOLD_AFTER_MS - 50 && Math.abs(slow.hold - slow.first) <= 5 && slow.tok > slow.hold && slow.tools >= 1400 && slow.calls === 2, JSON.stringify(slow))
})

test('a failed turn (storage error) never silences the rest of the call; a frame without response_id is ignored', async () => {
  await seed('alpha')
  const { s, convId } = await callFor('alpha')
  const prepare = db.prepare
  let failOnce = true
  db.prepare = (q) => {
    if (failOnce && /^SELECT \* FROM receptionist_conversations/.test(q)) {
      failOnce = false
      throw new Error('D1_ERROR: storage unavailable')
    }
    return prepare(q)
  }
  ask(s, 1, [{ role: 'user', content: 'hello' }])
  assert.ok(await until(() => done(s, 1)), 'turn 1 still gets an answer')
  assert.equal(s.sent.find((m) => m.response_id === 1 && m.content).content, 'Sorry, give me a moment and try that again.')
  // reminder_required without a usable response_id: ignored, and it must not break later staleness checks.
  frame(s, { interaction_type: 'reminder_required', transcript: [] })
  script.push(said('First answer.', { firstMs: 10, stallMs: 2000 }))
  script.push(said('Second answer.', { firstMs: 10 }))
  ask(s, 2, [{ role: 'user', content: 'hello again' }])
  await sleep(40)
  ask(s, 3, [{ role: 'user', content: 'hello again, are you there' }])
  assert.ok(await until(() => done(s, 3)), 'turn 3 answered after turn 2 was talked over')
  assert.equal(modelRequests[0].signal?.aborted, true)
  assert.ok(db.sql.prepare("SELECT 1 FROM receptionist_events WHERE conversation_id = ? AND kind = 'voice_frame' AND detail = 'bad_response_id'").get(convId))
  assert.ok(logs.some((l) => /receptionist voice turn failed: Error/.test(l)) && !logs.some((l) => /storage unavailable/.test(l)), 'error name only')
})

test('keepalive: ping_pong is answered at once while a turn is generating', async () => {
  await seed('alpha')
  const { s } = await callFor('alpha')
  script.push(said('Working on it.', { firstMs: 500 }))
  ask(s, 1, [{ role: 'user', content: 'hi' }])
  await sleep(20)
  const t = Date.now()
  frame(s, { interaction_type: 'ping_pong', timestamp: t })
  const pong = s.sent.find((m) => m.response_type === 'ping_pong')
  assert.equal(pong?.timestamp, t)
  assert.ok(pong.t - t < 50)
  assert.ok(await until(() => done(s, 1)))
})

test('missed speech: words of a talked-over turn are kept when the holding line was heard in between', async () => {
  await seed('alpha')
  const { s, convId } = await callFor('alpha')
  // Turn 1 starts a calendar lookup (holding line heard), the caller adds something before it finishes.
  script.push(tools([use('find_available_times', { date: '', part_of_day: 'any' })], { firstMs: 5, stallMs: 1500 }))
  script.push((body) => {
    const words = body.messages.filter((m) => m.role === 'user' && typeof m.content === 'string').map((m) => m.content)
    assert.deepEqual(words, ['can you come tuesday morning ideally before ten'])
    return said('Tuesday at 9 works.', { firstMs: 5 })
  })
  ask(s, 1, [{ role: 'agent', content: 'Hi' }, { role: 'user', content: 'can you come tuesday morning' }])
  assert.ok(await until(() => s.sent.some((m) => m.response_id === 1 && /One moment/.test(m.content || ''))))
  ask(s, 2, [{ role: 'agent', content: 'Hi' }, { role: 'user', content: 'can you come tuesday morning' }, { role: 'agent', content: 'One moment while I check the calendar.' }, { role: 'user', content: 'ideally before ten' }])
  assert.ok(await until(() => done(s, 2)))
  const log = JSON.parse(db.sql.prepare('SELECT state FROM receptionist_conversations WHERE id = ?').get(convId).state).log.map((l) => l.text)
  assert.deepEqual(log, ['can you come tuesday morning ideally before ten', 'Tuesday at 9 works.'])
})

test('interruption during a booking: the booking is kept (never aborted once it acted) and the next turn follows', async () => {
  await seed('alpha')
  const { s, convId } = await callFor('alpha')
  // Details + times first (one turn), then the booking turn.
  let slot
  script.push(tools([use('save_customer_details', { name: 'Jamie Rivera', phone: '843 555 0142', email: '', zip: '29403', street: '', city: '', state: '', need: 'Weekly pool care' }), use('find_available_times', { date: '', part_of_day: 'any' })], { firstMs: 5 }))
  script.push((body) => {
    const last = body.messages.at(-1).content.filter((b) => b.type === 'tool_result').map((b) => JSON.parse(b.content))
    slot = last[1].options[0]
    return said(`I can do ${slot.time}. Shall I book it?`, { firstMs: 5 })
  })
  const t1 = [{ role: 'agent', content: 'Hi' }, { role: 'user', content: 'Jamie Rivera, 843 555 0142, ZIP 29403, weekly pool care, when can you come' }]
  ask(s, 1, t1)
  assert.ok(await until(() => done(s, 1)))
  // Booking turn: Google is slow (300 ms); the caller says something during it.
  googleDelayMs = 300
  script.push(() => tools([use('book_appointment', { slot_id: slot.slot_id, confirmation_quote: 'yes book it' })], { firstMs: 5 }))
  script.push(said('You are booked.', { firstMs: 5 }))
  script.push(said('Yes, you are all set.', { firstMs: 5 }))
  const t2 = [...t1, { role: 'agent', content: `I can do ${slot.time}. Shall I book it?` }, { role: 'user', content: 'yes book it' }]
  ask(s, 2, t2)
  await sleep(120)
  ask(s, 3, [...t2, { role: 'user', content: 'is that done' }])
  assert.ok(await until(() => done(s, 3), 5000))
  assert.equal(db.sql.prepare("SELECT count(*) AS n FROM appointments WHERE status = 'booked'").get().n, 1, 'exactly one booking')
  const conv = db.sql.prepare('SELECT status, appointment_id FROM receptionist_conversations WHERE id = ?').get(convId)
  assert.equal(conv.status, 'booked')
  assert.ok(conv.appointment_id)
  assert.equal(modelRequests.filter((r) => r.signal?.aborted).length, 0, 'nothing aborted after the booking acted')
})

test('model refuses the request (4xx): the caller hears a spoken fallback without a web address', async () => {
  await seed('alpha')
  const { s, convId } = await callFor('alpha')
  script.push({ status: 400 })
  ask(s, 1, [{ role: 'user', content: 'hello' }])
  assert.ok(await until(() => done(s, 1)))
  const spoken = s.sent.filter((m) => m.response_id === 1 && m.content).map((m) => m.content).join(' ')
  assert.match(spoken, /having trouble on my side/)
  assert.ok(!/https?:\/\//.test(spoken), 'no URL read aloud')
  assert.ok(db.sql.prepare("SELECT 1 FROM receptionist_events WHERE conversation_id = ? AND kind = 'model' AND detail = 'model_http_400'").get(convId))
})
