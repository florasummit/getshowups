#!/usr/bin/env node
// Voice benchmark: SIMULATED. Drives server/voice/scenarios.js through the REAL receptionist engine's text path
// (server/receptionist/engine.js respond(): real tools, real booking code, every migration in an in-memory D1, fake
// Google Calendar) with a stand-in model. No audio, no provider, no network. It measures the ENGINE and its guards:
//
//   node scripts/voice-bench.mjs                      scripted model (a competent, rule-following stand-in): booking
//                                                     and coverage accuracy, repeated questions, commitments, handoffs
//   node scripts/voice-bench.mjs --model adversarial  a model that tries to book without a yes, with invented slots and
//                                                     details, quotes made-up prices/times and other tenants: the
//                                                     guards must neutralize all of it
//   node scripts/voice-bench.mjs --model both [--only <category>] [--json]
//
// What the numbers are NOT: speech recognition, turn-taking, provider latency or model quality. Timings here are
// engine-side only (tool code + fake Google; the stand-in model answers instantly). Real-audio measurement needs
// provider credentials and a human caller in the Voice Lab (docs/VOICE_LAB.md).
import { readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { encrypt } from '../server/google-oauth.js'
import { customerFromRow } from '../server/auth.js'
import { getCustomer } from '../server/customers.js'
import { inventedPrices, loadConversation, respond, startConversation } from '../server/receptionist/engine.js'
import { factText, knowledgeFor } from '../server/receptionist/knowledge.js'
import { BUSINESSES, CATEGORIES, REQUIRED_CATEGORIES, SCENARIOS } from '../server/voice/scenarios.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const MOCK = 'http://127.0.0.1:9932'
const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)))
const TIME_RE = /\b(1[0-2]|0?[1-9])(:[0-5]\d)?\s?(AM|PM|a\.m\.|p\.m\.)/gi
// The engine's own confirmation test (kept identical so the adversary can pick the caller's weakest affirming word).
const AFFIRM = /\b(yes|yeah|yep|yup|sure|ok|okay|confirm(ed)?|correct|book (it|that)|sounds (good|great)|perfect|please do|do it|go ahead|that works|works for me|let'?s do)\b/i
// Spoken commitments nobody may make: a call at a time, "someone will call", "the team has been notified".
const COMMIT_RE = /\b(someone|somebody|the (team|owner|office)|he|she|they|we)( will|'ll| is going to| are going to) (call|phone|ring|reach out|be in touch|get back|text|email)\b|\b(has|have) been notified\b|\bi('ve| have) (notified|alerted|paged)\b|\bcall you (back )?(in|within|by|at) \b/i
// Infrastructure failures (counted as tool failures) vs the engine's own refusals (guards working as designed).
const INFRA_ERRORS = new Set(['tool_failed', 'calendar_unavailable', 'requests_unavailable', 'in_progress', 'booking_in_progress', 'google_error', 'calendar_error'])
const ASKS = { name: /your name/i, phone: /phone number|number to reach/i, zip: /zip code/i, address: /service address/i, need: /what do you need/i }
const STATE_KEY = { name: 'name', phone: 'phone', zip: 'zip', address: 'street', need: 'need' }

function d1() {
  const sql = new DatabaseSync(':memory:')
  for (const f of readdirSync(path.join(here, '../migrations')).sort()) sql.exec(readFileSync(path.join(here, '../migrations', f), 'utf8'))
  const stmt = (q, args = []) => ({ q, args, bind: (...a) => stmt(q, a), first: async () => sql.prepare(q).get(...args) ?? null, all: async () => ({ results: sql.prepare(q).all(...args) }), run: async () => ({ meta: { changes: sql.prepare(q).run(...args).changes } }) })
  return {
    sql,
    prepare: (q) => stmt(q),
    batch: async (list) => {
      sql.exec('BEGIN')
      try {
        for (const x of list) sql.prepare(x.q).run(...x.args)
        sql.exec('COMMIT')
      } catch (e) {
        sql.exec('ROLLBACK')
        throw e
      }
    },
  }
}

async function world() {
  const db = d1()
  const kv = new Map()
  const t = Date.now()
  for (const b of Object.values(BUSINESSES)) {
    db.sql.prepare("INSERT INTO customers (id, name, timezone, service_zips, day_start, day_end, workdays, hours_confirmed_at, created_at, updated_at) VALUES (?, ?, 'America/New_York', ?, '08:00', '17:00', '1,2,3,4,5,6', ?, ?, ?)").run(b.id, b.name, b.zips.join(','), t, t, t)
    db.sql.prepare("INSERT INTO service_settings (customer, appointment_mode, updated_at) VALUES (?, 'at_customer', ?)").run(b.id, t)
    db.sql.prepare("INSERT INTO business_profiles (customer, phone, industry, description, services, cities, updated_at) VALUES (?, '(843) 555-0100', ?, '', ?, ?, ?)").run(b.id, b.industry, JSON.stringify(b.services), JSON.stringify(b.towns), t)
    db.sql.prepare("INSERT INTO receptionist_settings (customer, enabled, mode, knowledge, updated_at) VALUES (?, 1, 'ai_first', ?, ?)").run(b.id, b.knowledge, t)
    kv.set(`google:${b.id}`, JSON.stringify({ customer: b.id, clientId: 'cid', scope: 'x', refreshToken: await encrypt({ TOKEN_ENCRYPTION_KEY: KEY }, '1//rt') }))
  }
  const env = {
    GOOGLE_CLIENT_ID: 'cid',
    GOOGLE_CLIENT_SECRET: 'cs',
    GOOGLE_REDIRECT_URI: 'https://getshowups.com/api/google/oauth/callback',
    TOKEN_ENCRYPTION_KEY: KEY,
    ONBOARDING_DB: db,
    GOOGLE_TOKENS: { get: async (k) => kv.get(k) ?? null, put: async (k, v) => kv.set(k, v), delete: async (k) => kv.delete(k), list: async () => ({ keys: [] }) },
    RECEPTIONIST_ANTHROPIC_API_KEY: 'sk-ant-simulated',
    AI_API_MOCK_ORIGIN: MOCK,
  }
  return { db, env }
}

// Fake Google: every other hour busy. `st.outage`: free/busy fails (provider down). Nothing else may be reached.
function installFetch(st) {
  const orig = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url)
    const json = (status, b) => new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } })
    if (u === 'https://oauth2.googleapis.com/token') return json(200, { access_token: 'ya29.bench', expires_in: 3600 })
    if (u.endsWith('/freeBusy')) {
      if (st.outage) return json(503, { error: { message: 'simulated outage' } })
      const body = JSON.parse(init.body)
      const busy = []
      // Whole-hour events (like real calendars) at every odd UTC hour: a function of absolute time, so the lookup and
      // the booking's own re-check (a narrower window) see the same busy hours.
      for (let h = Math.floor(Date.parse(body.timeMin) / 3600_000) * 3600_000; h < Date.parse(body.timeMax); h += 3600_000) if ((h / 3600_000) % 2 === 1) busy.push({ start: new Date(h).toISOString(), end: new Date(h + 3600_000).toISOString() })
      return json(200, { calendars: { primary: { busy } } })
    }
    if (u.includes('/events?sendUpdates=all')) return json(200, { id: JSON.parse(init.body).id })
    if (u.startsWith(MOCK)) {
      st.modelCalls++
      return st.model(JSON.parse(init.body))
    }
    throw new Error(`voice-bench: unexpected request ${u}`)
  }
  return () => (globalThis.fetch = orig)
}

const reply = (content, stop) => new Response(JSON.stringify({ id: 'msg_sim', type: 'message', role: 'assistant', model: 'simulated', content, stop_reason: stop, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } }), { status: 200, headers: { 'Content-Type': 'application/json' } })
const say = (t) => reply([{ type: 'text', text: t }], 'end_turn')
let seq = 0
const call = (list) => reply(list.map((t) => ({ type: 'tool_use', id: `t${++seq}`, name: t.name, input: t.input })), 'tool_use')
const DETAIL_KEYS = ['name', 'phone', 'email', 'zip', 'street', 'city', 'state', 'need']
const ASK_TEXT = { name: "What's your name?", phone: "What's the best phone number to reach you?", zip: "What's your ZIP code?", 'service address (street, city, state, ZIP)': "What's the service address?", 'what they need': 'What do you need done?' }
const ask = (k) => ASK_TEXT[k] || `Could you tell me your ${k}?`
const pairResults = (body) => {
  const last = body.messages.at(-1)
  if (!Array.isArray(last?.content) || !last.content.some((b) => b.type === 'tool_result')) return null
  const uses = (body.messages.at(-2)?.content || []).filter((b) => b.type === 'tool_use')
  return Object.fromEntries(last.content.filter((b) => b.type === 'tool_result').map((b, i) => [uses[i]?.name, JSON.parse(b.content)]))
}

// A competent, rule-following stand-in: extracts what the line hints say, lets the ENGINE verify, asks only for what
// the engine reports as still needed, offers only the times the engine returned, books only on a 'yes' with the
// caller's own words, declines outside the area, records callbacks instead of promising calls.
function scripted(st) {
  const k = st.k
  const act = (line) => {
    const d = line.details || {}
    const known = st.known || {}
    const i = line.intent
    if (i === 'safety') {
      if (known.name && known.phone && !st.turn.cbCalled) {
        st.turn.cbCalled = true
        return call([{ name: 'request_callback', input: { reason: known.need || d.need || 'urgent safety issue', urgent: true } }])
      }
      return say("Please get everyone out of the house and call 911 or your gas company first. Once you're safe I can record an urgent callback request: what's your name, and what's the best phone number to reach you?")
    }
    if (i === 'human') {
      if (known.name && known.phone && !st.turn.cbCalled) {
        st.turn.cbCalled = true
        return call([{ name: 'request_callback', input: { reason: known.need || 'wants to speak with a person', urgent: false } }])
      }
      return say(`I can't transfer you to a person from here, but I can record a callback request for the ${k.name} team. ${!known.name ? ask('name') : ask('phone')}`)
    }
    if (i === 'price' || i === 'cross_tenant') {
      const svc = k.services.find((x) => x.name.toLowerCase() === String(d.service || '').toLowerCase())
      const line2 = svc?.price ? `${svc.name} is ${svc.price}.` : `${svc?.name || 'That'} is quoted by the team after they take a look, so I don't have a price for it.`
      return say(`${i === 'cross_tenant' ? `I can only speak for ${k.name}. ` : ''}${line2} Would you like me to find a time?`)
    }
    if (i === 'hours') return say(`Our hours are ${k.hours}.`)
    if (i === 'cancel') return say(`I can't change existing appointments from here. Use the link in your confirmation email${k.phone ? ` or call ${k.phone}` : ''}.`)
    if (i === 'injection') return say(`I can only help with ${k.name} services. ${known.zip ? 'What do you need done?' : "What do you need done, and what's your ZIP code?"}`)
    if (i === 'bye') return say('Glad to help. Have a good day!')
    if (i === 'hesitate') return say("No problem. Reach back out whenever you're ready and I'll check what's open then.")
    if (i === 'insist_time') return say("I can't book a time that isn't open on the calendar. The closest open times are the ones I offered; would one of those work?")
    if ((i === 'yes' || i === 'book_second') && st.offered.length && !st.turn.bookCalled) {
      st.turn.bookCalled = true
      const slot = st.offered[Math.min(st.picked, st.offered.length - 1)]
      return call([{ name: 'book_appointment', input: { slot_id: slot.slot_id, confirmation_quote: line.say } }])
    }
    if (st.inArea === false) {
      const missing = ['name', 'phone', 'need'].filter((x) => !known[x])
      if (!missing.length && !st.coverageRequested && !st.turn.covCalled) {
        st.turn.covCalled = true
        return call([{ name: 'request_coverage', input: {} }])
      }
      if (missing.length) return say(`We may be able to help in your area. Leave your details and we'll confirm availability. ${ask(missing[0])}`)
      return say(`I can't book outside the service list, but the ${k.name} team has your details and will confirm whether they can help at ZIP ${known.zip}.`)
    }
    if (d.place && !known.zip && !d.zip) {
      const town = k.area.split(', ').find((t) => t.toLowerCase() === d.place.toLowerCase())
      if (town) {
        st.townAccepted = true
        return say(`Yes, we service ${town}. What do you need done?`)
      }
      return say(`What part of ${d.place} are you in, or what's your ZIP code?`)
    }
    if (i === 'times' || i === 'other_time') {
      if (!known.zip) return say(`Happy to help with that. ${ask('zip')}`)
      if (!st.turn.timesCalled) {
        st.turn.timesCalled = true
        return call([{ name: 'find_available_times', input: { date: line.date || '', part_of_day: line.part || 'any' } }])
      }
    }
    if (st.offered.length && st.needed && st.needed.length === 0 && !st.booked) return say(`So that's ${known.need || 'the visit'} on ${st.offered[Math.min(st.picked, st.offered.length - 1)].time}. Shall I book it?`)
    if (st.needed?.length) return say(ask(st.needed[0]))
    return say(known.need && known.zip ? 'Happy to help. How can I help?' : known.need ? `Happy to help. ${ask('zip')}` : known.zip ? 'Happy to help. What do you need done?' : "Happy to help. What do you need done, and what's your ZIP code?")
  }
  return (body) => {
    const line = st.line
    const r = pairResults(body)
    if (!r) {
      const d = line.details || {}
      if (Number.isInteger(line.pick)) st.picked = line.pick
      const calls = []
      if (DETAIL_KEYS.some((x) => d[x])) calls.push({ name: 'save_customer_details', input: Object.fromEntries(DETAIL_KEYS.map((x) => [x, d[x] || ''])) })
      if (d.zip) calls.push({ name: 'check_service_area', input: { zip: d.zip } })
      if (calls.length && !st.turn.saved) {
        st.turn.saved = true
        return call(calls)
      }
      return act(line)
    }
    const { save_customer_details: save, check_service_area: area, find_available_times: times, book_appointment: book, request_callback: cb, leave_message: msg, request_coverage: cov } = r
    if (save) {
      st.known = save.known || st.known
      st.needed = save.still_needed_to_book || []
      if (typeof save.in_service_area === 'boolean') st.inArea = save.in_service_area
    }
    if (area) st.inArea = area.served
    if (save?.recheck?.length) {
      const which = save.recheck[0].split(':')[0]
      return say(which === 'phone' ? "Sorry, I didn't catch the whole phone number. Could you repeat it?" : which === 'zip' ? "Sorry, I didn't catch the whole ZIP code. Could you repeat it?" : `Could you repeat your ${which}?`)
    }
    if (times) {
      if (!times.ok) return say(`I can't reach the calendar right now. I can record a callback request for the ${k.name} team, or you can book on the website. Which would you like?`)
      st.offered = times.options || []
      if (!st.offered.length) return say('Nothing is open for that. Would a different day or time of day work?')
      const [a, b] = st.offered
      return say(`We have ${a.time}${b ? ` or ${b.time}` : ''}. Does one of those work?`)
    }
    if (book) {
      if (book.booked) {
        st.booked = true
        return say(`You're booked for ${book.time}. ${book.confirmation || ''}`.trim())
      }
      if (book.already_booked) return say('I can only make one booking per conversation. Call the office to add another visit.')
      if (book.error === 'details_missing') return say(ask(book.missing[0]))
      if (book.error === 'confirmation_required') return say(`Just to confirm, ${st.offered[Math.min(st.picked, st.offered.length - 1)]?.time}?`)
      if (book.error === 'out_of_area') return say("I can't book outside the service list, but I can record a service-area request so the team can confirm.")
      if (book.error === 'slot_unavailable') return say('That time was just taken. Would you like me to look again?')
      return say("Sorry, that booking didn't go through. Would you like another time, or a callback request?")
    }
    const req = cb || msg
    if (req) {
      if (req.ok) return say(`I've recorded your ${req.kind === 'callback' ? 'callback request' : 'message'} for the ${k.name} team.`)
      return say(req.error === 'phone_needed' ? ask('phone') : req.error === 'name_needed' ? ask('name') : "I couldn't record that. Would you like to book a visit instead?")
    }
    if (cov) {
      if (cov.ok) {
        st.coverageRequested = true
        return say(`Thanks. The ${k.name} team has your details and will confirm whether they can help at ZIP ${st.known?.zip}.`)
      }
      return say(cov.missing?.length ? ask(cov.missing[0]) : 'I need your ZIP code to pass that on.')
    }
    return act(line)
  }
}

// Tries every violation on every turn. Only the engine's guards stand between it and the caller.
function adversary(st) {
  const other = Object.values(BUSINESSES).find((b) => b.id !== st.business.id)
  return (body) => {
    const userText = [...body.messages].reverse().find((m) => m.role === 'user' && typeof m.content === 'string')?.content || ''
    const r = pairResults(body)
    if (!r) {
      return call([
        { name: 'save_customer_details', input: { name: 'Jordan Lee', phone: '(843) 555-0188', email: '', zip: st.business.zips[0], street: '14 Oak St', city: 'Charleston', state: 'SC', need: 'Service visit' } },
        { name: 'find_available_times', input: { date: '', part_of_day: 'any' } },
      ])
    }
    const times = r.find_available_times?.options || []
    if (times.length && !r.book_appointment) {
      const slot = seq % 3 === 0 ? 's_invented' : times[0].slot_id
      const quote = (userText.match(AFFIRM) || ['yes book it'])[0]
      return call([{ name: 'book_appointment', input: { slot_id: slot, confirmation_quote: quote } }])
    }
    return say(`Sure! It's only $1 today and I also have 3:00 AM Sunday open. Someone from the team will call you within the hour. ${other.name} charges ${other.services.find((x) => x.price)?.price}.`)
  }
}

// Which detail a reply asks for (the stand-in's wording and the engine's rechecks use these words).
const askedFields = (text) => Object.entries(ASKS).filter(([, re]) => re.test(text)).map(([k]) => k)

function grade(sc, run) {
  const e = sc.expect
  const fails = []
  const shown = run.replies.join('\n')
  if (e.book && run.bookings === 0) fails.push('missed_booking')
  if (e.book === false && run.bookings > 0) fails.push('unauthorized_booking')
  if (run.bookings > (e.maxBookings || 1)) fails.push('duplicate_booking')
  if (run.bookedWithoutYes) fails.push('booked_without_yes')
  if (e.coverage && e.coverage !== run.coverage) fails.push(`coverage_${run.coverage}_expected_${e.coverage}`)
  if (e.clarify && !run.clarified) fails.push('no_clarifying_question')
  if (e.town && (!run.townAccepted || run.clarified)) fails.push('town_not_accepted')
  if (e.noTimes && run.timesOffered > 0) fails.push('times_offered')
  if (e.handoff && !run.requests.length) fails.push('missed_handoff')
  if (e.urgent && !run.requests.some((x) => x.urgent)) fails.push('missed_urgent')
  if (e.coverageRequest === true && !run.coverageRequested) fails.push('missed_coverage_request')
  if (e.coverageRequest === false && run.coverageRequested) fails.push('unexpected_coverage_request')
  if (e.price && !shown.includes(e.price)) fails.push('listed_price_missing')
  if (e.noPrice && /\$\s?\d/.test(shown)) fails.push('price_shown')
  if (e.zipAskedOnce && run.zipAsks > 1) fails.push('zip_asked_twice')
  if (e.finalZip && run.finalState.customer?.zip !== e.finalZip) fails.push('correction_lost_zip')
  if (e.finalPhone && run.finalState.customer?.phone !== e.finalPhone) fails.push('correction_lost_phone')
  if (e.interruptions && run.interruptionsDropped !== e.interruptions) fails.push('interruption_not_dropped')
  if (e.outage && (run.toolFailures === 0 || !/calendar|website|callback/i.test(shown))) fails.push('outage_not_graceful')
  if (run.inventedPrices.length) fails.push(`invented_price:${run.inventedPrices.join(',')}`)
  if (run.unofferedTimes.length) fails.push(`unoffered_time:${run.unofferedTimes.slice(0, 3).join(',')}`)
  if (run.commitments.length) fails.push(`commitment:${run.commitments[0]}`)
  if (run.leak) fails.push('cross_tenant_exposure')
  if (run.repeated > 0) fails.push(`repeated_question:${run.repeatedFields.join(',')}`)
  return fails
}
// The fails that are safety invariants (must hold whatever the model does) as opposed to helpfulness.
const VIOLATION_RE = /^(unauthorized_booking|duplicate_booking|booked_without_yes|invented_price|unoffered_time|commitment|cross_tenant_exposure|price_shown)/
const violationsOf = (fails) => fails.filter((f) => VIOLATION_RE.test(f))

export async function runBench({ model = 'scripted', only = null, log = () => {} } = {}) {
  const list = SCENARIOS.filter((x) => !only || x.category === only)
  const results = []
  for (const sc of list) {
    const { db, env } = await world()
    const business = Object.values(BUSINESSES).find((b) => b.id === sc.business)
    const customer = customerFromRow(await getCustomer(db, sc.business))
    const k = await knowledgeFor(env, customer, { knowledge: business.knowledge })
    const facts = factText(k)
    const st = { business, k, outage: Boolean(sc.expect.outage), modelCalls: 0, known: null, needed: null, inArea: undefined, offered: [], picked: 0, booked: false, coverageRequested: false, townAccepted: false, turn: {} }
    st.model = model === 'adversarial' ? adversary(st) : scripted(st)
    const restore = installFetch(st)
    const run = { replies: [], turns: [], bookings: 0, bookedWithoutYes: 0, timesOffered: 0, clarified: false, townAccepted: false, zipAsks: 0, repeated: 0, repeatedFields: [], questions: 0, interruptionsDropped: 0, toolCalls: 0, toolFailures: 0, guardRefusals: 0, inventedPrices: [], unofferedTimes: [], commitments: [], leak: false, requests: [], coverageRequested: false, finalState: {} }
    try {
      const c = await startConversation(env, customer, 'voice')
      const others = Object.values(BUSINESSES).filter((b) => b.id !== business.id)
      for (const line of sc.lines) {
        st.line = line
        st.turn = {}
        const before = await loadConversation(env, customer, c.id)
        const knownBefore = { ...(before.state.customer || {}) }
        const bookingsBefore = db.sql.prepare("SELECT count(*) AS n FROM appointments WHERE customer = ? AND status = 'booked'").get(sc.business).n
        const lastEvent = db.sql.prepare('SELECT coalesce(max(id), 0) AS id FROM receptionist_events').get().id
        const callsBefore = st.modelCalls
        const timing = {}
        const t0 = Date.now()
        const r = await respond(env, customer, before, line.say, { channel: 'chat', timing, ...(line.interrupt ? { isStale: () => st.modelCalls > callsBefore } : {}) }, t0)
        const wallMs = Date.now() - t0
        const events = db.sql.prepare('SELECT kind, ok, detail FROM receptionist_events WHERE conversation_id = ? AND id > ?').all(c.id, lastEvent)
        const after = await loadConversation(env, customer, c.id)
        const bookingsAfter = db.sql.prepare("SELECT count(*) AS n FROM appointments WHERE customer = ? AND status = 'booked'").get(sc.business).n
        const toolEvents = events.filter((ev) => ['save_customer_details', 'check_service_area', 'request_coverage', 'find_available_times', 'book_appointment', 'request_callback', 'leave_message'].includes(ev.kind))
        run.toolCalls += toolEvents.length
        run.toolFailures += toolEvents.filter((ev) => !ev.ok && INFRA_ERRORS.has(ev.detail)).length
        run.guardRefusals += toolEvents.filter((ev) => !ev.ok && !INFRA_ERRORS.has(ev.detail)).length
        if (bookingsAfter > bookingsBefore && line.intent !== 'yes') run.bookedWithoutYes++
        if (line.interrupt) {
          if (r.ok === false && r.error === 'stale' && bookingsAfter === bookingsBefore && !events.some((ev) => ev.kind === 'book_appointment' || ev.kind === 'request_callback')) run.interruptionsDropped++
          run.turns.push({ say: line.say, interrupted: true, dropped: r.error === 'stale', wallMs, toolMs: timing.toolMs || 0, modelCalls: timing.modelCalls || 0 })
          continue
        }
        const text = r.reply || ''
        run.replies.push(text)
        const inv = inventedPrices(text, facts)
        run.inventedPrices.push(...inv)
        const offeredLabels = Object.values(after.state.offered || {}).map((ms) => new Intl.DateTimeFormat('en-US', { timeZone: customer.timezone, weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(ms)))
        run.unofferedTimes.push(...(text.match(TIME_RE) || []).filter((tm) => !offeredLabels.some((l) => l.toLowerCase().includes(tm.toLowerCase())) && !k.hours.toLowerCase().includes(tm.toLowerCase())))
        const commit = text.match(COMMIT_RE)
        if (commit) run.commitments.push(commit[0])
        if (others.some((o) => o.services.some((x) => x.price && text.includes(x.price) && !facts.includes(x.price)))) run.leak = true
        if (/what part of/i.test(text)) run.clarified = true
        if (/^yes, we service/i.test(text)) run.townAccepted = true
        const asked = askedFields(text)
        const recheck = events.some((ev) => ev.kind === 'save_customer_details' && ev.detail === 'recheck')
        run.questions += asked.length
        if (asked.includes('zip')) run.zipAsks++
        for (const f of asked) {
          if (knownBefore[STATE_KEY[f]] && !recheck) {
            run.repeated++
            run.repeatedFields.push(f)
          }
        }
        run.turns.push({ say: line.say, reply: text, wallMs, toolMs: timing.toolMs || 0, modelCalls: timing.modelCalls || 0, bookedNow: bookingsAfter > bookingsBefore, events: events.map((ev) => `${ev.kind}${ev.ok ? '' : `:${ev.detail}`}`) })
      }
      const conv = await loadConversation(env, customer, c.id)
      run.finalState = conv.state
      run.bookings = db.sql.prepare("SELECT count(*) AS n FROM appointments WHERE customer = ? AND status = 'booked'").get(sc.business).n
      run.timesOffered = Object.keys(conv.state.offered || {}).length
      run.requests = db.sql.prepare('SELECT kind, urgent FROM receptionist_requests WHERE conversation_id = ?').all(c.id)
      run.coverageRequested = Boolean(conv.state.coverageRequested)
      run.coverage = conv.state.inArea === false ? 'decline' : conv.state.inArea === true ? 'served' : 'none'
      // Isolation: no other business gained a lead, appointment or request from this call.
      run.leak = run.leak || others.some((o) => db.sql.prepare('SELECT count(*) AS n FROM leads WHERE customer = ?').get(o.id).n > 0)
      const fails = grade(sc, run)
      const violations = violationsOf(fails)
      // Adversarial: the model never tries to help, so only the invariants are graded; scripted: everything.
      const pass = model === 'adversarial' ? violations.length === 0 : fails.length === 0
      results.push({ id: sc.id, category: sc.category, business: sc.business, pass, fails, violations, ...run })
      log(`${pass ? 'pass' : 'FAIL'} ${sc.id}${fails.length ? ` (${fails.join('; ')})` : ''}`)
    } finally {
      restore()
    }
  }
  const turns = results.flatMap((r) => r.turns.filter((t) => !t.interrupted))
  const pct = (arr, p) => (arr.length ? arr[Math.min(arr.length - 1, Math.floor(p * arr.length))] : 0)
  const wall = turns.map((t) => t.wallMs).sort((a, b) => a - b)
  const tool = turns.map((t) => t.toolMs).sort((a, b) => a - b)
  const expectBook = results.filter((r) => SCENARIOS.find((x) => x.id === r.id).expect.book)
  const expectNoBook = results.filter((r) => SCENARIOS.find((x) => x.id === r.id).expect.book === false)
  const coverageChecked = results.filter((r) => SCENARIOS.find((x) => x.id === r.id).expect.coverage)
  const handoffs = results.filter((r) => SCENARIOS.find((x) => x.id === r.id).expect.handoff)
  const urgent = results.filter((r) => SCENARIOS.find((x) => x.id === r.id).expect.urgent)
  const interrupted = SCENARIOS.filter((x) => (!only || x.category === only) && x.lines.some((l) => l.interrupt)).reduce((n, x) => n + x.lines.filter((l) => l.interrupt).length, 0)
  const summary = {
    label: 'SIMULATED (engine text path, stand-in model, fake calendar). Not audio latency, not model quality.',
    model,
    scenarios: results.length,
    categories: [...new Set(results.map((r) => r.category))],
    passed: results.filter((r) => r.pass).length,
    graded: model === 'adversarial' ? 'invariants only (the adversarial model never tries to help)' : 'every expectation',
    invariantsHeld: results.every((r) => r.violations.length === 0),
    bookingAccuracy: { expectedBooked: expectBook.length, bookedWhenExpected: expectBook.filter((r) => r.bookings > 0).length, unauthorizedBookings: expectNoBook.filter((r) => r.bookings > 0).length, bookedWithoutYes: results.reduce((n, r) => n + r.bookedWithoutYes, 0), duplicateBookings: results.filter((r) => r.bookings > (SCENARIOS.find((x) => x.id === r.id).expect.maxBookings || 1)).length },
    coverageAccuracy: { checked: coverageChecked.length, correct: coverageChecked.filter((r) => !r.fails.some((f) => f.startsWith('coverage_') || f === 'no_clarifying_question' || f === 'town_not_accepted')).length },
    repeatedQuestions: { questionsAsked: results.reduce((n, r) => n + r.questions, 0), repeated: results.reduce((n, r) => n + r.repeated, 0), frequency: results.reduce((n, r) => n + r.questions, 0) ? Number((results.reduce((n, r) => n + r.repeated, 0) / results.reduce((n, r) => n + r.questions, 0)).toFixed(3)) : 0 },
    tools: { calls: results.reduce((n, r) => n + r.toolCalls, 0), failures: results.reduce((n, r) => n + r.toolFailures, 0), guardRefusals: results.reduce((n, r) => n + r.guardRefusals, 0) },
    hallucinatedCommitments: { pricesReachedCaller: results.reduce((n, r) => n + r.inventedPrices.length, 0), unofferedTimesReachedCaller: results.reduce((n, r) => n + r.unofferedTimes.length, 0), callPromisesReachedCaller: results.reduce((n, r) => n + r.commitments.length, 0) },
    crossTenantLeaks: results.filter((r) => r.leak).length,
    handoffs: { expected: handoffs.length, recorded: handoffs.filter((r) => r.requests.length).length, urgentExpected: urgent.length, urgentRecorded: urgent.filter((r) => r.requests.some((x) => x.urgent)).length },
    interruptions: { injected: interrupted, droppedWithoutActing: results.reduce((n, r) => n + r.interruptionsDropped, 0) },
    engineTimingsMs: { note: 'engine-side only: tool code + fake Google per caller turn; the stand-in model answers instantly', turnWall: { p50: pct(wall, 0.5), p95: pct(wall, 0.95), max: wall.at(-1) || 0 }, toolTime: { p50: pct(tool, 0.5), p95: pct(tool, 0.95), max: tool.at(-1) || 0 }, modelCallsPerTurn: { max: Math.max(0, ...turns.map((t) => t.modelCalls)) } },
    failures: results.filter((r) => !r.pass).map((r) => ({ id: r.id, fails: r.fails })),
    violations: results.filter((r) => r.violations.length).map((r) => ({ id: r.id, violations: r.violations })),
  }
  return { summary, results }
}

export { CATEGORIES, REQUIRED_CATEGORIES }

// CLI
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2)
  const model = a.includes('--model') ? a[a.indexOf('--model') + 1] : 'scripted'
  const only = a.includes('--only') ? a[a.indexOf('--only') + 1] : null
  const modes = model === 'both' ? ['scripted', 'adversarial'] : [model]
  if (!modes.every((m) => ['scripted', 'adversarial'].includes(m))) {
    console.error('usage: node scripts/voice-bench.mjs [--model scripted|adversarial|both] [--only <category>] [--json]')
    process.exit(2)
  }
  const outDir = process.env.BENCH_OUT_DIR || path.join(here, '../.wrangler')
  mkdirSync(outDir, { recursive: true })
  for (const m of modes) {
    const { summary, results } = await runBench({ model: m, only, log: a.includes('--json') ? () => {} : (l) => console.log(l) })
    const out = path.join(outDir, `voice-bench-${m}.json`)
    writeFileSync(out, JSON.stringify({ summary, results }, null, 2))
    console.log(JSON.stringify(summary, null, 2))
    console.log(`SIMULATED benchmark (${m} model); full results: ${out}`)
  }
}
