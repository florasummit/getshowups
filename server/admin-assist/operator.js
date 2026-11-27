// The platform-admin assistant's conversation: the same bounded loop as the owner assistant (server/operator.js), with its
// own tools (tools.js), its own instructions and its own checks. Model: operatorModel(env) exactly as the owner assistant
// (Workers AI in production). The model sees references ([B1], [E1], [P1]), never names or contact details; names are
// filled in here for the admin's page. The answer is checked (figures must come from lookups, nothing claimed as done,
// no test-mode money called revenue, only references that were looked up); a failed check goes back at most twice with
// the reason, then the caller shows the records without prose.
import { fit } from '../fit.js'
import { inventedNumbers } from '../fact-numbers.js'
import { chat, costOf, operatorModel, providerReason } from '../operator-model.js'
import { ADMIN_INSTRUCTIONS, PAGES } from './instructions.js'
import { adminContext, namesFor, runAdminTool, TOOLS } from './tools.js'
import { SALES_BUSINESS } from './data.js'

export const BOUNDS = { rounds: 4, calls: 7, callMs: 25_000, totalMs: 45_000, tokens: 1200, answer: 1800, resultChars: 6000 }
const SPECS = TOOLS.map(({ name, description, parameters }) => ({ name, description, parameters }))
const REF_IN = /\[([BEP]\d{1,3})\]/g
// The founder asked for a change (only then may one be prepared).
export const ASKS_CHANGE = /\b(re-?send|send|mark|unmark|run|record|log|take (it |the \w+ )?off|remove (the )?test|prepare|abandon\w*|reconcile)\b/i

// The brief as short lines (half the tokens of its JSON): the included model's daily allowance is shared with owners.
const briefLines = (b) => (b?.items ? [`${b.counts.urgent} urgent, ${b.counts.important} important, ${b.counts.fyi} FYI (${b.total_items} in all).`, ...b.items.slice(0, 16).map((i) => `- ${i.level}: ${i.what}.${i.detail ? ` ${i.detail}` : ''} Next: ${i.next} (${i.page})`)].join('\n') : 'could not be read')
export function systemPrompt(c, brief) {
  const now = new Date(c.now)
  return [
    ADMIN_INSTRUCTIONS,
    `NOW
It is ${new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(now)} UTC.
Billing mode: ${c.L.live ? 'LIVE (real payments count)' : 'Stripe TEST mode: nobody has paid real money yet; no revenue exists'}.
Admin pages: ${Object.values(PAGES).map(([n, w]) => `${n} (${w})`).join('; ')}.

THIS WEEK (weekly_brief, read just now)
${briefLines(brief)}`,
  ]
}

// ---------- checks ----------
const DONE = /\b(i|we)(['’]ve| have| just)? ?(just |already |now )?(resent|re-sent|sent|emailed|marked|unmarked|ran|run|reconciled|recorded|updated|changed|saved|suspended|deleted|refunded|cancell?ed|paused|started|approved)\b|\b(has|have) been (resent|sent|marked|recorded|updated|changed|saved|run|reconciled) (as|to|for|successfully|now)?\b|\b(is|are) now (marked|recorded|saved|abandoned)\b|\b(done|completed)[.!]?$/i
const NOT_DONE = /\b(not|never|no|nothing|none|once|if|until|when|after you|ready to approve|approve)\b/i
const INSIDE = /\b(the|a|my) (\w+ )?(tool|lookup|tools|lookups|function)\b|\b(weekly_brief|business_health|platform_numbers|system_health|ai_spending|growth_activity|prepare_\w+|no_lookup_needed)\b|\bTHIS WEEK\b/
const PROMISE = /\b(guaranteed?|will (definitely |certainly )?(churn|leave|cancel|pay|grow|increase|double))\b/i
const MONEY_WORD = /\b(revenue|mrr|arr|earned|made|income|paid us|money (in|received|came)|collected)\b/i
const MONEYISH = /\b(pa(y|id|ying|yment)s?|revenue|mrr|arr|churn\w*|subscri\w+|commissions?|owe[ds]?|money|income|billing)\b/i
export const TEST_NOTE = 'Billing is in Stripe test mode: nobody pays real money yet, and test-mode amounts are not revenue.'
const NAMEISH = (text, names) => names.filter((n) => n && n.length > 3 && text.toLowerCase().includes(n.toLowerCase()))

export function adminProblem(text, { facts, shown, live, names = [], prepared = 0, typed = '' }) {
  if (!text || text.length < 2) return 'The answer was empty.'
  if (text.length > BOUNDS.answer) return 'The answer was too long. Under 150 words.'
  if (/https?:|www\.|[<>{}]|\/admin\b/i.test(text)) return 'Remove links, paths, code and braces. Name the page instead (Overview, Control Center, Sales, Growth).'
  if (/\b\d{4}-\d{2}-\d{2}\b|\b[A-Z]{3,}_[A-Z_]{3,}\b/.test(text)) return 'Write dates like "Nov 24" and never a switch or field name.'
  const unknown = [...text.matchAll(REF_IN)].map((m) => m[1]).filter((r) => !shown.has(r))
  if (unknown.length) return `These references were not looked up: ${unknown.join(', ')}. Use only references from tool results.`
  if (/[[\]]/.test(text.replace(REF_IN, ''))) return 'Square brackets are only for one reference, like [B1]. Remove the others.'
  // A name the founder typed may be repeated; any other name must be a reference (the model never sees names).
  const own = NAMEISH(text.replace(REF_IN, ' '), names).filter((n) => !String(typed).toLowerCase().includes(n.toLowerCase()))
  if (own.length) return 'It types a name. Write businesses, enrollments and partners only as their reference, like [B1].'
  const sentences = text.split(/(?<=[.!?])\s+|\n/)
  if (sentences.some((x) => DONE.test(x) && !NOT_DONE.test(x))) return 'It says something was done. You cannot do anything: say what is prepared and ready to approve, or what the records show happened.'
  if (!prepared && /\b(ready to approve|ready for (your )?approval|approve it|i('ve| have) prepared|is prepared)\b/i.test(text)) return 'Nothing was prepared in this answer, so nothing is ready to approve. Call the prepare tool first, or say where the founder can do it.'
  if ((text.match(/^\s*[-•]\s/gm) || []).length > 6) return 'Too many lines. Give the 5 that matter most, most urgent first, and say how many more are on the This week list on Overview.'
  if (INSIDE.test(text)) return 'It talks about tools, lookups or your instructions. Say only what the records show.'
  if (PROMISE.test(text)) return 'It predicts a result. Say what the records show and what to check instead.'
  if (!live && /\bpaying\b/i.test(text) && !/\btest\b/i.test(text)) return 'Billing is in Stripe test mode: say that these subscriptions are in test mode (nobody pays real money yet).'
  if (!live && sentences.some((x) => /\$\s?\d/.test(x) && MONEY_WORD.test(x) && !/\btest\b/i.test(x))) return 'Billing is in Stripe test mode: no amount is revenue or money received. Say it is test mode, or leave the amount out.'
  const bare = text.replace(REF_IN, ' ').replace(/^\s*\d+[.)]\s/gm, ' ')
  const bad = inventedNumbers(bare, facts).filter((n) => !(/^[1-9]$/.test(n) && countable(n, facts)))
  if (bad.length) return `These numbers are not in what you looked up: ${[...new Set(bad)].slice(0, 6).join(', ')}. Remove them or look them up.`
  return null
}
// A small count ("two of them") is fine when that many records were listed.
const countable = (n, facts) => (facts.match(/"(ref|level|severity|what)":/g) || []).length >= Number(n)

// One turn. → { ok, answer (names filled), raw, proposals, refs, sources, evidence, tools, usage, costMicros, ms } | { ok: false, reason, … }
// context: an adminContext the caller already made (its loaders are reused by the caller's fallback).
export async function operateAdmin(env, req, { now = Date.now(), model = operatorModel(env), trace = null, context = null } = {}) {
  const started = Date.now()
  const c = context || adminContext(env, req.refs, now)
  c.question = req.question
  const b = await runAdminTool(c, 'weekly_brief', {})
  const system = systemPrompt(c, b)
  const messages = []
  for (const h of req.history || []) if (h.q && h.a) messages.push({ role: 'user', text: h.q }, { role: 'assistant', text: h.a })
  messages.push({ role: 'user', text: req.question })
  const results = []
  const tools = []
  const evidence = []
  const refusals = []
  const usage = { in: 0, out: 0, read: 0, write: 0, calls: 0 }
  let cost = 0
  let calls = 0
  let retries = 0
  let again = false
  const lookups = [] // which tools ran with which arguments (admin-only; for "why?" and review)
  const base = () => ({ refs: c.book(), proposals: c.proposals, sources: c.sources, evidence: evidence.slice(0, 6), lookups, tools, usage, refusals, costMicros: Math.round(cost), ms: Date.now() - started })
  for (let round = 0; round <= BOUNDS.rounds; round++) {
    const left = BOUNDS.totalMs - (Date.now() - started)
    if (left < 1500) break
    const last = round >= BOUNDS.rounds - 1 || calls >= BOUNDS.calls
    // On Claude every call reserves budget first (server/ai-budget.js): its own entry, booked on the GetShowUps business.
    const req1 = { system, messages, tools: last ? null : SPECS, allTools: SPECS, mustLook: round === 0, maxTokens: BOUNDS.tokens, entry: 'admin_assistant', customerId: SALES_BUSINESS }
    let reply
    try {
      reply = await chat(env, model, req1, Math.min(BOUNDS.callMs, left)).catch(async (err) => {
        if (again || model.provider !== 'workers' || !['busy', 'unavailable'].includes(providerReason(err))) throw err
        again = true
        await new Promise((r) => setTimeout(r, 300))
        return chat(env, model, req1, Math.min(BOUNDS.callMs, Math.max(1500, BOUNDS.totalMs - (Date.now() - started))))
      })
    } catch (err) {
      trace?.push({ error: String(err?.message).slice(0, 200) })
      return { ok: false, reason: providerReason(err), ...base() }
    }
    cost += costOf(model, reply.usage)
    usage.calls++
    for (const k of ['in', 'out', 'read', 'write']) usage[k] += reply.usage[k] || 0
    trace?.push({ round, calls: reply.calls, text: reply.text, usage: reply.usage })
    if (reply.calls.length && !last) {
      // A change nobody asked for is never prepared: the call is answered with the reason instead of running.
      const unasked = reply.calls.filter((x) => x.name.startsWith('prepare_') && !ASKS_CHANGE.test(req.question))
      const batch = reply.calls.slice(0, Math.max(1, BOUNDS.calls - calls))
      messages.push({ role: 'assistant', text: reply.text, calls: batch, native: reply.native && batch.length === reply.calls.length ? reply.native : undefined })
      const out = []
      for (const x of batch) {
        calls++
        const r = unasked.includes(x) ? { prepared: false, reason: 'The founder did not ask for this change. Prepare nothing; answer the question and mention it can be prepared if they want.' } : await runAdminTool(c, x.name, x.args)
        results.push({ tool: x.name, result: r })
        lookups.push({ tool: x.name, args: x.args || {} })
        tools.push(r?.error ? `${x.name}:${r.error}` : x.name)
        if (x.name !== 'no_lookup_needed' && !x.name.startsWith('prepare_')) evidence.push({ tool: x.name, args: x.args || {}, source: r?.source || null, period: r?.period || null, result: JSON.parse(fit(r, BOUNDS.resultChars)) })
        trace?.push({ tool: x.name, args: x.args, result: r })
        out.push({ id: x.id, name: x.name, text: fit(r, BOUNDS.resultChars) })
      }
      messages.push({ role: 'tool', results: out })
      continue
    }
    const text = String(reply.text || '').replace(/\*\*/g, '').replace(/^#+\s*/gm, '').replace(/(?<![[\w])([BEP]\d{1,3})\b(?![\]\w])/g, (m, r) => (c.shown.has(r) ? `[${r}]` : m)).trim()
    const facts = `${JSON.stringify(b)} ${results.map((r) => JSON.stringify(r.result)).join(' ')} ${JSON.stringify(c.proposals.map(({ effects, title, before, after }) => ({ effects, title, before, after })))} ${req.question} ${(req.history || []).map((h) => h.q).join(' ')} ${new Date(now).toISOString().slice(0, 10)} ${new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', dateStyle: 'full' }).format(now)}`
    const names = [...c.refs.values()].map((r) => r.name).filter(Boolean)
    const why = reply.cut ? 'It was cut off. Shorter, and finish the sentence.' : adminProblem(text, { facts, shown: c.shown, live: c.L.live, names, prepared: c.proposals.length, typed: [req.question, ...(req.history || []).map((h) => h.q)].join(' ') })
    if (!why) {
      const used = [...new Set([...text.matchAll(REF_IN)].map((m) => m[1]))]
      const filled = await namesFor(c, used)
      // Test mode is said whenever money or paying customers come up, by the application, not left to the model.
      const note = !c.L.live && MONEYISH.test(`${req.question} ${text}`) && !/\btest\b/i.test(text) ? ` ${TEST_NOTE}` : ''
      const answer = text.replace(REF_IN, (m, r) => filled[r] || 'that business') + note
      return { ok: true, answer, raw: text + note, ...base() }
    }
    trace?.push({ refused: why, text })
    refusals.push(why.replace(/\[[BEP]\d+\]|\d+/g, '').slice(0, 40))
    if (++retries > 2) break
    messages.push({ role: 'assistant', text: reply.text || '(empty)' }, { role: 'user', text: `[check by the application] Your draft was not shown. ${why} Now write the whole answer again for the founder, who asked: "${req.question}". Complete, on its own, without mentioning a draft or a check.` })
  }
  return { ok: false, reason: 'unchecked', ...base() }
}
