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

// tokens: output per call; "what needs me" and "is anything broken" answers get briefTokens (reserved in full before each
// call on Claude). A retry after a held draft always gets its full callMs (see the loop).
export const BOUNDS = { rounds: 4, calls: 7, callMs: 25_000, totalMs: 45_000, tokens: 1200, briefTokens: 1600, answer: 1800, resultChars: 6000 }
const SPECS = TOOLS.map(({ name, description, parameters }) => ({ name, description, parameters }))
const REF_IN = /\[([BEPQ]\d{1,3})\]/g
// The founder asked for a change (only then may one be prepared).
export const ASKS_CHANGE = /\b(re-?send|send|mark|unmark|run|record|log|take (it |the \w+ )?off|remove (the )?test|prepare|abandon\w*|reconcile|add|create|capture|put|move|defer|set|change|start|verify|retest|plan)\b/i

// The brief as short lines (half the tokens of its JSON): the included model's daily allowance is shared with owners.
const briefLines = (b) => (b?.items ? [`${b.counts.urgent} urgent, ${b.counts.important} important, ${b.counts.fyi} FYI (${b.total_items} in all).`, ...b.items.slice(0, 16).map((i) => `- ${i.level}: ${i.about ? `${i.about} — ` : ''}${i.issue}.${i.detail ? ` ${i.detail}` : ''} Next: ${i.next} (${i.page})`)].join('\n') : 'could not be read')
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
// "What needs me": every listed item carries its tier, one brief item per line, and a stated urgent count matches.
export const BRIEF_Q = /\b(what needs (me|my attention|attention)|this week|anything urgent|what('s| is) urgent|what should i (do|work on|look at)|my to-?do)\b/i
// "Is anything broken / what's wrong / any problems": a list too, with the same room and the same shorter-list retry
// (tiers stay a "what needs me" rule only).
export const BROKEN_Q = /\b(anything (broken|wrong|failing|down|off)|what('s| is) (broken|wrong|failing|down)|any (problems?|issues?|incidents?|errors?|failures?)|(is )?(everything|it all) (ok|okay|working|fine|running))\b/i
export const CUT_BROKEN = 'It was cut off: list fewer items. Give every critical or high item and at most 3 others, one line each under 30 words, then one closing line: "N more in the Control Center."'
export const listQuestion = (q) => BRIEF_Q.test(q) || BROKEN_Q.test(q)
export const CUT_BRIEF = 'It was cut off: list fewer items. Give every urgent item and at most the 3 most important others, one line each under 30 words, then one closing line: "N more on Overview\'s This week list."'
const TIER = /^\s*[-•]\s*(urgent|important|fyi)\s*[:—–-]/i
const COUNT_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 }
export function tierProblem(text, question) {
  const bullets = text.split('\n').filter((l) => /^\s*[-•]\s/.test(l))
  // Only "what needs me" questions: a summary or list that happens to say "urgent" keeps its own bullets.
  if (!bullets.length || !BRIEF_Q.test(question)) return null
  if (bullets.some((l) => !TIER.test(l))) return 'Label every listed item with its tier: start each line with "- Urgent: ", "- Important: " or "- FYI: ", one item of the list per line, urgent first.'
  const stated = /\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten) urgent\b/i.exec(text)
  const urgent = bullets.filter((l) => /^\s*[-•]\s*urgent/i.test(l)).length
  if (stated && (COUNT_WORDS[stated[1].toLowerCase()] ?? Number(stated[1])) !== urgent) return `The answer says ${stated[1]} urgent but lists ${urgent} line${urgent === 1 ? '' : 's'} labelled "Urgent:". List each urgent item on its own "- Urgent: " line.`
  return null
}

// "Is it ready for customers?": verified facts, missing information and inferred risks, labelled and apart; never a
// verdict (the records support none: the founder decides).
export const READY_Q = /\b(ready for (customers|launch|real customers|production|go[- ]live)|readiness|can we (launch|go live)|ok to launch|safe to (launch|release|ship|go live))\b/i
const VERDICT = /\b(it['’]?s|it is|production is|we['’]?re|we are|(the )?(current )?(production )?version is|you['’]?re|you are|everything is)( not| now)? (ready|good to go|safe to (launch|go live))\b|\b(isn['’]t|is not|not yet) ready\b|^\s*(yes|no)\b/im
export function readinessProblem(text, question) {
  if (!READY_Q.test(question)) return null
  const has = (label) => new RegExp(`^\\s*(?:[-•]\\s*)?\\**${label}\\**\\s*:`, 'im').test(text)
  if (!has('Verified') || !has('Missing') || !has('Risks?')) return 'Answer in three parts on their own lines, starting "Verified:", "Missing:" and "Risks:", from the readiness facts. Keep them apart.'
  if (VERDICT.test(text)) return 'No verdict: don’t say it is or isn’t ready, and no yes or no. Give the three parts; the founder decides.'
  return null
}

// References → names for the page, never the same name twice in one sentence. A QA item [Q] is filled as its title in
// typographic quotes (“…”), so a title never runs into the sentence; the sentence's own punctuation is kept as written.
// When the model also spelled the name out: written BEFORE the reference, the reference disappears; written AFTER it in
// quotes or brackets (exactly “title” or (title)), that copy alone is removed: never other words, never punctuation.
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
function fillSentence(sentence, filled) {
  let out = ''
  let rest = sentence
  const done = new Set() // references filled in this sentence: the model repeating one is not a written-out title
  for (let m = REF_IN.exec(rest); m; m = REF_IN.exec(rest)) {
    REF_IN.lastIndex = 0
    const name = filled[m[1]]
    const before = out + rest.slice(0, m.index)
    let after = rest.slice(m.index + m[0].length)
    if (!name) {
      out = `${before}${m[0].startsWith('[B') ? 'that business' : 'that item'}`
    } else if (!done.has(m[1]) && before.toLowerCase().includes(name.toLowerCase())) {
      out = before.replace(/[ \t]+$/, after.match(/^[,.;:!?)]/) ? '' : ' ')
    } else {
      out = `${before}${m[1][0] === 'Q' ? `“${name}”` : name}`
      done.add(m[1])
      const n = esc(name)
      after = after.replace(new RegExp(`\\s*(?:[“"]${n}[”"]|\\(\\s*[“"]?${n}[”"]?\\s*\\)|\\[\\s*[“"]?${n}[”"]?\\s*\\])`), '')
    }
    rest = after
  }
  REF_IN.lastIndex = 0
  return (out + rest).replace(/\(\s*\)|\[\s*\]/g, '').replace(/[ \t]+([,.;:!?])/g, '$1').replace(/,\s*,/g, ',').replace(/[ \t]{2,}/g, ' ')
}
export function fillRefs(text, filled) {
  return text
    .split('\n')
    .map((line) => line.split(/(?<=[.!?]) +/).map((s) => fillSentence(s, filled)).join(' '))
    .join('\n')
    .trim()
}

// After a [Qn] reference the page shows the item's title, so the answer must not restate it in its own words: a sentence
// whose text right after the reference repeats 5 or more consecutive words of that title is sent back. titles: ref → title.
const wordList = (s) => String(s).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean)
export function restatedTitle(text, titles) {
  for (const m of text.matchAll(/\[(Q\d{1,3})\]/g)) {
    const title = titles[m[1]]
    if (!title) continue
    const t = wordList(title)
    if (t.length < 5) continue
    const tail = text.slice(m.index + m[0].length).split(/[.!?\n]/)[0]
    const w = ` ${wordList(tail).join(' ')} `
    for (let i = 0; i + 5 <= t.length; i++) if (w.includes(` ${t.slice(i, i + 5).join(' ')} `)) return `After [${m[1]}] the page already shows the item's title: don't restate what it is. Write [${m[1]}] and add only its severity, kind, area, status or age. Keep every other line as it is.`
  }
  return null
}

// An answer never retracts or doubts an earlier one by itself (the records behind it were read; see the history note).
export const SELF_DOUBT = /\b(correct|retract|walk back|take back|fix) (my|the|that) (last|earlier|previous|prior) (message|answer|reply|list)|\bwithout looking (them|it|those|this) up\b|\bI (shouldn['’]t|should not) have (listed|said|named|included)\b|\bmy (last|earlier|previous) (message|answer|reply) (was|is) (wrong|incorrect|mistaken|unchecked|not checked)\b|\bI (made|invented|guessed) (that|those|them)\b/i
const PROMISE = /\b(guaranteed?|will (definitely |certainly )?(churn|leave|cancel|pay|grow|increase|double))\b/i
const MONEY_WORD = /\b(revenue|mrr|arr|earned|made|income|paid us|money (in|received|came)|collected)\b/i
const MONEYISH = /\b(pa(y|id|ying|yment)s?|revenue|mrr|arr|churn\w*|subscri\w+|commissions?|owe[ds]?|money|income|billing)\b/i
export const TEST_NOTE = 'Billing is in Stripe test mode: nobody pays real money yet, and test-mode amounts are not revenue.'
const NAMEISH = (text, names) => names.filter((n) => n && n.length > 3 && text.toLowerCase().includes(n.toLowerCase()))

// How many listed lines an answer may have: 6, or for a full list the founder asked for ("summarize the backlog", "list …")
// one per item the lookups returned (at most 12) + 3.
export const FULL_LIST_Q = /\b(summari[sz]e|summary of|list|all (the |my )?|every|each|go through|overview of)\b/i
export const lineLimit = (question, items) => (FULL_LIST_Q.test(String(question || '')) ? Math.max(6, Math.min(12, items) + 3) : 6)
export function adminProblem(text, { facts, shown, live, names = [], prepared = 0, typed = '', question = typed, items = 0 }) {
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
  const tiers = tierProblem(text, question)
  if (tiers) return tiers
  const ready = readinessProblem(text, question)
  if (ready) return ready
  const most = lineLimit(question, items)
  if ((text.match(/^\s*[-•]\s/gm) || []).length > most) return most > 6 ? `Too many lines: at most ${most}, one per item. Keep every other part as it is.` : 'Too many lines. Give the 5 that matter most, most urgent first, and say how many more are on the This week list on Overview.'
  if (SELF_DOUBT.test(text)) return 'It doubts or corrects an earlier answer. Earlier answers were written from lookups of the records. Answer only the question; if a lookup now shows something different, say what the records show now.'
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
  // Earlier answers are replayed with the lookups they rested on (tool names only), so the model never takes its own
  // earlier answer for an unchecked one.
  for (const h of req.history || []) if (h.q && h.a) messages.push({ role: 'user', text: h.q }, { role: 'assistant', text: `${h.a}${h.looked?.length ? `\n\n(This answer was written from these lookups, read from the records at the time: ${h.looked.join(', ')}.)` : ''}` })
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
  const base = () => ({ refs: c.book(), proposals: c.proposals, attachments: c.attachments || [], sources: c.sources, evidence: evidence.slice(0, 6), lookups, tools, usage, refusals, costMicros: Math.round(cost), ms: Date.now() - started })
  for (let round = 0; round <= BOUNDS.rounds; round++) {
    const left = BOUNDS.totalMs - (Date.now() - started)
    // A rewrite asked for by a check (cut off, too many lines, …) always gets its full callMs, past totalMs if need be:
    // never a retry squeezed into the last seconds and then shown as records.
    if (left < 1500 && !retries) break
    const last = round >= BOUNDS.rounds - 1 || calls >= BOUNDS.calls
    // On Claude every call reserves budget first (server/ai-budget.js): its own entry, booked on the GetShowUps business.
    const req1 = { system, messages, tools: last ? null : SPECS, allTools: SPECS, mustLook: round === 0, maxTokens: listQuestion(req.question) ? BOUNDS.briefTokens : BOUNDS.tokens, entry: 'admin_assistant', customerId: SALES_BUSINESS }
    let reply
    try {
      reply = await chat(env, model, req1, retries ? BOUNDS.callMs : Math.min(BOUNDS.callMs, left)).catch(async (err) => {
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
    const text = String(reply.text || '').replace(/\*\*/g, '').replace(/^#+\s*/gm, '').replace(/(?<![[\w])([BEPQ]\d{1,3})\b(?![\]\w])/g, (m, r) => (c.shown.has(r) ? `[${r}]` : m)).trim()
    // Asked who might churn: every business listed must have a churn signal in the lookup.
    // Restating a QA item right after its reference (titles read for the page anyway).
    const qUsed = [...new Set([...text.matchAll(/\[(Q\d{1,3})\]/g)].map((x) => x[1]))]
    const restated = qUsed.length ? restatedTitle(text, await namesFor(c, qUsed)) : null
    const calm = /\b(churn\w*|at risk|might (leave|cancel|quit)|likely to (leave|cancel))\b/i.test(req.question) ? [...text.split('\n').filter((l) => /^\s*[-•]/.test(l)).join(' ').matchAll(REF_IN)].map((m) => m[1]).filter((r) => c.signals?.get(r) === 0) : []
    const facts = `${JSON.stringify(b)} ${results.map((r) => JSON.stringify(r.result)).join(' ')} ${JSON.stringify(c.proposals.map(({ effects, title, before, after }) => ({ effects, title, before, after })))} ${req.question} ${(req.history || []).map((h) => h.q).join(' ')} ${new Date(now).toISOString().slice(0, 10)} ${new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', dateStyle: 'full' }).format(now)}`
    const names = [...c.refs.values()].map((r) => r.name).filter(Boolean)
    const why = reply.cut ? (BRIEF_Q.test(req.question) ? CUT_BRIEF : BROKEN_Q.test(req.question) ? CUT_BROKEN : 'It was cut off. Shorter, and finish the sentence.') : restated ? restated : calm.length ? `${calm.map((r) => `[${r}]`).join(', ')} has no churn signal in the records. List only businesses with a signal; say how many others have none.` : adminProblem(text, { facts, shown: c.shown, live: c.L.live, names, prepared: c.proposals.length, question: req.question, items: new Set(results.flatMap((x) => [...JSON.stringify(x.result ?? null).matchAll(/"ref":"([BEPQ]\d{1,3})"/g)].map((m) => m[1]))).size, typed: [req.question, ...(req.history || []).map((h) => h.q)].join(' ') })
    if (!why) {
      const used = [...new Set([...text.matchAll(REF_IN)].map((m) => m[1]))]
      const filled = await namesFor(c, used)
      // Test mode is said whenever money or paying customers come up, by the application, not left to the model.
      const note = !c.L.live && MONEYISH.test(`${req.question} ${text}`) && !/\btest\b/i.test(text) ? ` ${TEST_NOTE}` : ''
      const answer = fillRefs(text, filled) + note
      return { ok: true, answer, raw: text + note, ...base() }
    }
    trace?.push({ refused: why, text })
    refusals.push(why.replace(/\[[BEPQ]\d+\]|\d+/g, '').slice(0, 40))
    if (++retries > 2) break
    messages.push({ role: 'assistant', text: reply.text || '(empty)' }, { role: 'user', text: `[check by the application] Your draft was not shown. ${why} Now write the whole answer again for the founder, who asked: "${req.question}". Complete, on its own, without mentioning a draft or a check.` })
  }
  return { ok: false, reason: 'unchecked', ...base() }
}
