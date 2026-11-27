// The dashboard assistant's conversation: understands the owner, looks things up with the fixed tools in
// operator-tools.js, reasons over the results, answers plainly, and prepares changes the owner approves elsewhere.
// Model: server/operator-model.js (measured comparison in docs/ASSISTANT_PROGRESS.md). Bounded: rounds,
// tool calls, tokens, time. The model never sees names or contact details (references instead; names are filled in here),
// can't reach another business, and can't save anything. Business records and earlier turns are data, never instructions.
// The answer is checked (numbers must come from lookups, nothing claimed as done, no money credited to ads); a failed
// check is sent back at most twice with the reason, then the looked-up records are shown without prose.
import { whoIsMeant } from './who-is-meant.js'
import { HELP } from '../src/content/help.js'
import { claimProblem } from './claims.js'
import { fit } from './fit.js'
import { INSTRUCTIONS } from './operator-instructions.js'
import { inventedNumbers } from './fact-numbers.js'
import { chat, costOf, operatorModel, providerReason } from './operator-model.js'
import { pageState, selectedLead, waitingNow } from './app-state.js'
import { PAGES } from './assist-plain.js'
import { PAGE_IDS, knownRecords, repeatLookups, REPEATABLE, runTool, toolContext, TOOLS, whenText } from './operator-tools.js'

export const BOUNDS = { rounds: 5, calls: 8, callMs: 25_000, totalMs: 40_000, tokens: 2400, answer: 1800, resultChars: 7000 }
const SPECS = TOOLS.map(({ name, description, parameters }) => ({ name, description, parameters }))

const PAGE = { overview: 'Overview', appointments: 'Appointments', followups: 'Follow-ups', receptionist: 'Receptionist', teach: 'Teach Your AI', website: 'Website', ads: 'Ads', settings: 'Settings' }

// [fixed instructions (operator-instructions.js; the same for every business: a cached prefix), what is true this turn]
export function systemPrompt(c, { view, topic, days, results }, known, pending, before = [], screen = null, discussed = [], lastOrder = []) {
  const t = topic ? HELP[topic] : null
  const tz = c.tz
  return [
    INSTRUCTIONS,
    `NOW
Business: ${c.customer.name}. It is ${new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(c.now)} in ${tz}. The owner is on the ${PAGE[view]} page${results ? `, looking at ad results for the last ${days} days: use that period unless they name another` : ''}${t ? `, with "${t.title}" selected (${t.what})` : ''}.
Pages: ${Object.values(PAGES).map(([n, w]) => `${n} (${w})`).join('; ')}. Help is at the top of every page.${screen ? `

WAITING NOW (whole business; card.items are the lines of the Needs your attention card on Overview)
${fit(screen.waiting, 6000)}

ON SCREEN (${PAGE[view]} page)
${fit(screen.page, 5000)}${screen.selected ? `\nSELECTED ${JSON.stringify(screen.selected)}` : ''}` : ''}${lastOrder.length ? `

IN YOUR LAST ANSWER, IN ORDER
${lastOrder.map((r, i) => `${i + 1}: [${r}]`).join(', ')} (the first is its main subject; "and after?" continues from the LAST one here: begin "After [that person], …")` : ''}${discussed.length ? `

PEOPLE DISCUSSED (latest first)
${discussed.map((d) => `[${d.ref}]`).join(', ')}` : ''}${known.length ? `

RECORDS ALREADY DISCUSSED (current)
${fit(known, 6000)}` : ''}${before.length ? `

LOOKUPS BEHIND YOUR EARLIER ANSWER (read again just now; current)
${before.map((x) => `${x.tool} ${JSON.stringify(x.args)}: ${fit(x.result, 4000)}`).join('\n')}` : ''}${pending.length ? `

WAITING FOR THE OWNER'S APPROVAL (not saved)
${pending.map((p, i) => `P${i + 1} ${JSON.stringify(p)}`).join('\n')}` : ''}`,
  ]
}

// ---------- checks ----------
const DONE = /\b(i|we)(['’]ve| have| just)? ?(just |already |now )?(marked|recorded|updated|changed|set|sent|emailed|texted|messaged|booked|rescheduled|cancell?ed|saved|charged|refunded|paused|started|launched|published|deleted|opened)\b|\b(has|have) been (marked|updated|changed|sent|saved|cancell?ed|refunded) (as|to|for|successfully|now)\b|\b(is|are) now (marked|saved|updated)\b/i
// "no-show" is a kind of outcome, not a negation: "I marked Pat as a no-show" claims an action like any other.
const NOT_DONE = /\b(not|never|no(?![-‐ ]?shows?\b)|hasn['’]?t|haven['’]?t|isn['’]?t|aren['’]?t|wasn['’]?t|nothing|none|once|if|until|when)\b/i
const NOBODY = /\b(nobody|no one|no customers?|no-one) (else )?(is|are|seems?|appears?)( \w+)? (waiting|needing|in need)( (on|for) you)?\s*(right now|at the moment|today|currently)?[.!]?$|\b(all caught up|nothing needs (you|your attention))\b/i
const PROMISE = /\b(guaranteed|we guarantee|i guarantee|will (increase|double|grow|get you|bring)|you(['’]ll| will) (get|see|earn) more|will (keep|continue to) grow\w*)\b/i
// How it works is never part of an answer, nor is doubting an answer nobody questioned.
const INSIDE = /\b(the|a|my) (\w+ )?(tool|lookup|tools|lookups)\b( (says?|shows?|returned|found|reports?))|\b(funnel tool|lookup)\b|\b(found|is the) (one|a|only|the only) match\b|\bonly match\b|\bmatch(es|ing) only\b|\b(only|one) record match|\bonly record (matching|under)\b|\bhaven['’]?t looked (up|for)\b|\bfind (her|his|their) record\b|\bmy (earlier|last|previous) (reply|answer|message) was (wrong|incorrect|mistaken)\b|\bI (shouldn['’]t|should not) have (said|linked|told)\b|\b(yes,? )?I['’]m (here|on|working)\b(?=[ ,.!])|\bI (also |just )?(overstated|misstated|misspoke)\b/i
const CREDITED = /\b(ads?|advertising|campaigns?) (have |has )?(generated|earned|produced|brought in|made|drove|caused|returned)\b[^.]*\$|\$[\d,.]+[^.]*\b(generated|earned|produced|caused|driven) (by|from|through) (your |the )?(ads?|advertising|campaigns?)\b|\b(ROI|ROAS|return on (ad spend|investment))\b[^.]*\d/i

// → null | what is wrong, in words the model can act on
// quoted: what customers wrote. Their numbers (a pool's size, a time to call) may be repeated, but never as money or results.
const MONEY = /[$%]|\b(percent|revenue|paid|payments?|earn\w*|income|profit\w*|spent|spend|cost\w*|dollars?|bookings?|inquir\w+|leads?|clicks?)\b/i
const MONEY_Q = /\b(make|made|earn\w*|revenue|paid|profit\w*|money|spend|spent|sales?|income|worth)\b/i
export function problemWith(text, { facts, looked, refs, waiting = null, quoted = '' }) {
  if (!text || text.length < 2) return 'The answer was empty.'
  if (text.length > BOUNDS.answer) return 'The answer was too long. Under 160 words.'
  if (/https?:|www\.|[<>{}]/i.test(text)) return 'Remove links, code and braces.'
  const twice = (x) => {
    const people = [...new Set([...x.matchAll(/\[([ALR]\d{1,3})\]/g)].map((m) => m[1]))].map((r) => refs.get(r)?.leadId).filter(Boolean)
    return new Set(people).size < people.length
  }
  if (text.split(/(?<=[.!?])\s+|\n/).some(twice)) return 'One sentence uses two references for the same person, so it would say their name twice. Use one of them, once.'
  const unknown = [...text.matchAll(/\[([ALR]\d{1,3})\]/g)].map((m) => m[1]).filter((r) => !refs.has(r))
  if (unknown.length) return `These references were not looked up: ${unknown.join(', ')}. Use only references from tool results.`
  const sentences = text.split(/(?<=[.!?])\s+|\n/)
  // The card on screen says someone is waiting: no answer may say the opposite.
  if (waiting?.some((n) => n > 0) && sentences.some((x) => NOBODY.test(x))) return 'WAITING NOW shows people waiting, so do not say that nobody is waiting or all is caught up. Say which kind of waiting is meant.'
  if (sentences.some((x) => DONE.test(x) && !NOT_DONE.test(x))) return 'It says something was done. You cannot save or send anything: say what is prepared, or what the records show happened, without "I" having done it.'
  if (/[[\]]/.test(text.replace(/\[[ALR]\d{1,3}\]/g, ''))) return 'Square brackets are only for one reference, like [A1]. Remove the others.'
  if (INSIDE.test(text)) return 'It talks about you or how you work, or calls an earlier answer wrong. "This" is what the page is about, not you. Say only what the records show now. An owner may have approved something since: that does not make an earlier answer wrong.'
  if (PROMISE.test(text)) return 'It promises or predicts a result. Remove that.'
  if (sentences.some((x) => CREDITED.test(x) && !NOT_DONE.test(x))) return 'It credits money to ads or gives a return. Write it like this: “$X in payments is recorded for jobs traced to these ads; that isn’t proof the ads caused them.” Never “the ads made, earned, brought in or returned $X”, and no ROI or ROAS figure.'
  const bare = text.replace(/\[[ALR]\d{1,3}\]/g, ' ').replace(/^\s*\d+[.)]\s/gm, ' ')
  const check = looked ? bare : sentences.filter((x) => /\byou(r|['’]ve|['’]re)?\b/i.test(x)).join(' ').replace(/\[[ALR]\d{1,3}\]/g, ' ').replace(/^\s*\d+[.)]\s/gm, ' ')
  const strict = check.split(/(?<=[.!?])\s+|\n/)
  const unbacked = strict.flatMap((x) => inventedNumbers(x, MONEY.test(x) ? facts : `${facts} ${quoted}`))
  // A figure only a customer's text contains is never a result, looked up or not.
  const theirs = new Set(String(quoted).match(/\d[\d,.]*/g)?.map((n) => n.replace(/[.,]+$/, '').replace(/,/g, '')) || [])
  const fed = sentences.filter((x) => MONEY.test(x)).flatMap((x) => inventedNumbers(x.replace(/\[[ALR]\d{1,3}\]/g, ' '), facts)).filter((n) => theirs.has(n.replace(/,/g, '')))
  if (fed.length) return `These figures appear only in a customer’s text, not in the records: ${fed.slice(0, 4).join(', ')}. Leave them out.`
  const bad = unbacked.filter((n) => !/^[1-9]$/.test(n) || !looked || !countable(n, facts))
  if (bad.length) return `These numbers are not in what you looked up: ${bad.slice(0, 6).join(', ')}. Remove them or look them up.`
  if (!looked && inventedNumbers(sentences.filter((x) => /[$%]|\bpercent\b/i.test(x)).join(' '), facts).length) return 'Without a lookup, leave out amounts and percentages.'
  return null
}
// A small count ("three of them") is fine when that many records were listed.
const countable = (n, facts) => (facts.match(/"ref":"[ALR]\d+"/g) || []).length >= Number(n)

// One card per person: their appointment rather than the inquiry behind it.
const onePer = (list) => list.filter((r) => r.kind !== 'inquiry' || !list.some((x) => x !== r && x.leadId && x.leadId === r.leadId))
const squash = (v) => String(v ?? '').replace(/\p{Cc}/gu, ' ').replace(/\s+/g, ' ').trim()
// What customers typed must not become a source of "facts" for the number check (only quotable: problemWith).
const wordsOf = (v, out = []) => (JSON.stringify(v, (k, x) => (k === 'asked_for' && typeof x === 'string' && out.push(x), x)), out)
const factsOnly = (v) => JSON.stringify(v, (k, x) => (k === 'asked_for' ? undefined : x))

// One turn. → { ok, answer (names filled in), raw (references), records, proposals, withdraw, go, refs, tools, costMicros, ms } | { ok: false, reason, … }
export async function operate(env, customer, req, { now = Date.now(), model = operatorModel(env), trace = null } = {}) {
  const started = Date.now()
  const c = toolContext(env, customer, req.refs, now, req.days)
  const before = await repeatLookups(c, req.looked || [])
  const known = await knownRecords(c, (req.history || []).map((h) => h.a).join(' '))
  c.pending = req.pending || []
  const pending = c.pending.map((p) => ({ type: p.type, ...(p.ref ? { ref: p.ref } : {}), change: p.change }))
  const refsIn = (t) => [...new Set([...t.matchAll(/\[([ALR]\d{1,3})\]/g)].map((m) => m[1]))]
  const turns = [...(req.history || [])].reverse().map((h) => ({ words: h.q, refs: refsIn(h.a) }))
  const discussed = [...new Set(turns.flatMap((t) => [...t.refs].reverse()))].slice(0, 12)
  const meant = req.selected ? null : whoIsMeant(req.question, turns.map((t) => ({ words: t.words, people: t.refs.map((ref) => ({ ref, person: c.shown.get(ref)?.leadId || ref })) })))
  const lastOrder = [...new Set([...((req.history || []).at(-1)?.a || '').matchAll(/\[([ALR]\d{1,3})\]/g)].map((m) => m[1]))]
  const unread = (e) => (console.error('assistant screen failed:', e?.name), 'could not be read')
  const [waiting, shownPage, selected] = await Promise.all([waitingNow(c).catch(unread), PAGE_IDS.includes(req.view) ? pageState(c, req.view).catch(unread) : null, req.selected ? selectedLead(c, req.selected).catch(() => null) : null])
  const screen = { waiting, page: shownPage, selected }
  const onScreen = JSON.stringify(screen) // already in front of the model: not repeated as "discussed"
  const system = systemPrompt(c, req, known.filter((k) => !onScreen.includes(`"ref":"${k.ref}"`)), pending, before, screen, discussed, lastOrder)
  const messages = []
  for (const h of req.history || []) if (h.q && h.a) messages.push({ role: 'user', text: h.q }, { role: 'assistant', text: h.a })
  messages.push({ role: 'user', text: meant ? `${req.question}\n(From the application: unless the owner names someone here, “he” or “she” is ${meant.sure ? `[${meant.ref}]. Answer about them` : `[${meant.ref}], not [${meant.not}] (whom they called otherwise). Answer about [${meant.ref}] and where they are; if that can’t be right, ask who they mean`}.)` : req.question })
  const results = []
  const tools = []
  let cost = 0
  const refusals = [] // which checks an answer failed (no content)
  const usage = { in: 0, out: 0, read: 0, write: 0, calls: 0 }
  let calls = 0
  let retries = 0
  let beside = '' // an answer written next to a lookup or button, when nothing follows it
  let page = '' // the same, next to a page button only
  let again = false
  const looked = [] // repeated next turn, so "why?" reasons over the same evidence
  const base = () => ({ refs: c.refs.book, lookups: looked.length ? looked.slice(-5) : req.looked || [], records: [...c.shown.values()].slice(0, 12), proposals: c.proposals, withdraw: c.withdrawn.size ? [...c.withdrawn] : false, go: c.go, tools, usage, refusals, costMicros: Math.round(cost), ms: Date.now() - started })
  // "Vera [R1]" (the owner's word, then the reference) must not become "Vera Vera Stone".
  const fillNames = (t) =>
    t.replace(/(?:([\p{L}'’-]+) )?\[([ALR]\d{1,3})\]/gu, (m, word, r) => {
      const name = squash(c.shown.get(r)?.name) || 'that person'
      return word && !name.toLowerCase().split(' ').includes(word.toLowerCase()) ? `${word} ${name}` : name
    })
  for (let round = 0; round <= BOUNDS.rounds; round++) {
    const left = BOUNDS.totalMs - (Date.now() - started)
    if (left < 1500) break
    const last = round >= BOUNDS.rounds - 1 || calls >= BOUNDS.calls
    let reply
    const req1 = { system, messages, tools: last ? null : SPECS, allTools: SPECS, mustLook: round === 0, maxTokens: BOUNDS.tokens, customerId: customer.id }
    try {
      // One short retry, once per question, only for a refusal that can pass (Anthropic's client retries by itself). Never
      // for a used-up allowance, a refused account or a timeout.
      reply = await chat(env, model, req1, Math.min(BOUNDS.callMs, left)).catch(async (err) => {
        if (again || model.provider !== 'workers' || !['busy', 'unavailable'].includes(providerReason(err))) throw err
        again = true
        await new Promise((r) => setTimeout(r, 300))
        return chat(env, model, req1, Math.min(BOUNDS.callMs, Math.max(1500, BOUNDS.totalMs - (Date.now() - started))))
      })
    } catch (err) {
      trace?.push({ error: String(err?.message).slice(0, 200) })
      return { ok: false, reason: providerReason(err), looked: results.length > 0, ...base() }
    }
    cost += costOf(model, reply.usage)
    usage.calls++
    for (const k of ['in', 'out', 'read', 'write']) usage[k] += reply.usage[k] || 0
    trace?.push({ round, calls: reply.calls, text: reply.text, usage: reply.usage })
    if (reply.calls.length && !last) {
      if (reply.calls.some((x) => x.name === 'show_page') && reply.text) page = reply.text
      beside = reply.calls.every((x) => x.name === 'show_page' || x.name.startsWith('prepare_')) ? reply.text : ''
      const batch = reply.calls.slice(0, Math.max(1, BOUNDS.calls - calls))
      messages.push({ role: 'assistant', text: reply.text, calls: batch, native: reply.native && batch.length === reply.calls.length ? reply.native : undefined })
      if (reply.native && batch.length !== reply.calls.length) messages[messages.length - 1].native = reply.native.filter((b) => b.type !== 'tool_use' || batch.some((x) => x.id === b.id))
      const out = []
      for (const x of batch) {
        calls++
        const r = await runTool(c, x.name, x.args)
        results.push(r)
        if (!r?.error && REPEATABLE.includes(x.name)) looked.push({ name: x.name, args: x.args })
        tools.push(r?.error ? `${x.name}:${r.error}` : x.name)
        trace?.push({ tool: x.name, args: x.args, result: r })
        out.push({ id: x.id, name: x.name, text: fit(r, BOUNDS.resultChars) })
      }
      messages.push({ role: 'tool', results: out })
      continue
    }
    // The answer may have been written next to a page button; what follows is then only a closing line.
    const whole = !retries && page && page.length > (reply.text || '').length ? page : reply.text || (retries ? '' : beside)
    const text = whole.replace(/\*\*/g, '').replace(/[【】]/g, '').replace(/(?<![[\w])([ALR]\d{1,3})\b(?![\]\w])/g, (m, r) => (c.shown.has(r) ? `[${r}]` : m)).trim()
    const facts = `${factsOnly(screen)} ${factsOnly(known)} ${factsOnly(before)} ${factsOnly(results)} ${factsOnly(pending)} ${req.question} ${whenText(now, c.tz)} ${new Intl.DateTimeFormat('en-US', { timeZone: c.tz, dateStyle: 'full' }).format(now)}`
    const read = results.some((r) => !r?.ok) || known.length > 0 || before.length > 0
    const wrong = reply.cut ? 'It was cut off. Shorter, and finish the sentence.' : problemWith(text, { facts, quoted: wordsOf([screen, known, before, results]).join(' '), looked: read || /\[[ALR]\d{1,3}\]/.test(text), refs: c.shown, waiting: waiting === 'could not be read' ? null : [waiting.call_backs_waiting, waiting.receptionist_messages_waiting, waiting.conversations_needing_the_owner].filter(Number.isInteger) })
    // Asked about money of a name this business doesn't have: its own figures must not stand in for the other's.
    const stranger = !wrong && results.some((r) => r?.matches === 0) && !results.some((r) => r?.matches > 0) && MONEY_Q.test(req.question) && /\$|\d|\b(recorded|payments?|bookings?|revenue|spend)\b/i.test(text) ? 'The name asked about is not in this business. Say in one sentence that you only have this business, without figures and without saying what this business has recorded.' : null
    const why = wrong || stranger || claimProblem(text, c.claims, { now, tz: c.tz })
    if (!why) {
      const used = new Set([...text.matchAll(/\[([ALR]\d{1,3})\]/g)].map((m) => m[1]))
      return { ok: true, answer: fillNames(text), raw: text, looked: results.some((r) => !r?.ok), ...base(), records: onePer([...c.shown.values()].filter((r) => used.has(r.ref))).slice(0, 8) }
    }
    trace?.push({ refused: why, text })
    refusals.push(why.replace(/\[[ALR]\d+\]|\d+/g, '').slice(0, 40))
    if (++retries > 2) break
    messages.push({ role: 'assistant', text: reply.text || '(empty)', native: reply.native?.length ? reply.native : undefined }, { role: 'user', text: `[check by the application] Your draft was not shown to the owner. ${why} Look things up again if you need them. Now write the whole answer again for the owner, who asked: "${req.question}". Same subject, complete, on its own, without mentioning a draft, a check or a correction.` })
  }
  return { ok: false, reason: 'unchecked', looked: results.length > 0, ...base() }
}
