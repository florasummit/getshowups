// Platform-admin assistant: entry points for functions/api/platform/assist.js (see the files beside this one).
//   data.js       one loader over the existing admin records (no contact details past it)
//   brief.js      "This week": deterministic prioritized list, no model
//   tools.js      read-only lookups + prepare_* (nothing saved)
//   guard.js      consequential actions and owner data: answered without the model
//   operator.js   the model loop (operatorModel(env), the owner assistant's provider) with its checks
//   proposals.js  Approve → the existing audited server functions
// Off switch: ADMIN_ASSIST_ENABLED === 'false' (the brief keeps working; it needs no model). Platform admins only.
import { operatorConfigured } from '../operator-model.js'
import { ADMIN_ANSWERS_PER_DAY, ADMIN_DAILY_MICROS, DAY } from './data.js'
import { REF_RE } from './tools.js'

export const adminAssistOn = (env) => env.ADMIN_ASSIST_ENABLED !== 'false'
export const adminAssistEnabled = (env) => adminAssistOn(env) && operatorConfigured(env)
export const LIMITS = { question: 500, history: 6, answer: 1900 }

const clean = (s) => String(s ?? '').replace(/[^\P{Cc}\n]/gu, ' ').replace(/\s+/g, ' ').trim()

// → [error] | [null, { question, history, refs }]
export function validateAdminQuestion(b) {
  const question = clean(b?.question)
  if (question.length < 2) return ['empty_question']
  if (question.length > LIMITS.question) return ['too_long']
  const h = b.history === undefined ? [] : b.history
  if (!Array.isArray(h) || h.length > 20) return ['invalid_request']
  const history = h.slice(-LIMITS.history).map((x) => ({ q: clean(x?.q).slice(0, LIMITS.question), a: String(x?.a ?? '').replace(/[^\P{Cc}\n]/gu, ' ').trim().slice(0, LIMITS.answer) }))
  const refs = b.refs && typeof b.refs === 'object' && !Array.isArray(b.refs) ? Object.fromEntries(Object.entries(b.refs).filter(([k, v]) => REF_RE.test(k) && typeof v === 'string').slice(0, 120)) : {}
  return [null, { question, history, refs }]
}

// Today's (UTC) recorded admin-assistant use. Unreadable → treated as over (no unbounded spending).
// → null (fine) | 'spending' | 'answers'
export async function adminLimitReached(env, now = Date.now()) {
  try {
    const r = await env.ONBOARDING_DB.prepare("SELECT coalesce(sum(json_extract(props, '$.costMicros')), 0) AS c, coalesce(sum(json_extract(props, '$.ok') = 1), 0) AS ok FROM events WHERE type = 'admin_ai_ask' AND at >= ?1").bind(now - (now % DAY)).first()
    if (Number(r.c) >= ADMIN_DAILY_MICROS) return 'spending'
    if (Number(r.ok) >= ADMIN_ANSWERS_PER_DAY) return 'answers'
    return null
  } catch {
    return 'spending'
  }
}
