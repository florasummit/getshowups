// Shared guard for /api/platform/qa/* (QA Command Center): platform admins only (PLATFORM_ADMIN_EMAILS), POSTs
// same-origin + rate-limited per admin + audited by the route, 503 { available: false } until migration 0051 is applied,
// storage errors as codes only. The admin's identity in QA records is a ref (never the email).
import { json } from '../google-oauth.js'
import { emailRef } from '../auditlog.js'
import { requirePlatformAdmin } from '../platform.js'
import { hit, tooManyJson } from '../ratelimit.js'
import { qaCenterReady } from './qa-results.js'

export function qaGet(fn) {
  return async (ctx) => {
    const { admin, response } = await requirePlatformAdmin(ctx.request, ctx.env)
    if (response) return response
    try {
      if (!(await qaCenterReady(ctx.env.ONBOARDING_DB))) return json(503, { error: 'not_available', available: false })
      return await fn({ ...ctx, admin, actor: await emailRef(admin.email), url: new URL(ctx.request.url) })
    } catch (err) {
      console.error('qa center read failed:', err?.name)
      return json(503, { error: 'storage_error' })
    }
  }
}

export function qaPost(fn, { rule = 'qaCenterWrite', maxBytes = 64_000 } = {}) {
  return async (ctx) => {
    const { admin, response } = await requirePlatformAdmin(ctx.request, ctx.env, { write: true })
    if (response) return response
    try {
      if (!(await qaCenterReady(ctx.env.ONBOARDING_DB))) return json(503, { error: 'not_available', available: false })
      const rl = await hit(ctx.env, rule, admin.email)
      if (rl.limited) return tooManyJson(rl.retryAfter)
      if (Number(ctx.request.headers.get('Content-Length') || 0) > maxBytes) return json(413, { error: 'too_large' })
      const raw = await ctx.request.text().catch(() => '')
      if (raw.length > maxBytes) return json(413, { error: 'too_large' })
      let body
      try {
        body = raw ? JSON.parse(raw) : {}
      } catch {
        return json(400, { error: 'invalid_json' })
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return json(400, { error: 'invalid_request' })
      return await fn({ ...ctx, admin, actor: await emailRef(admin.email), body })
    } catch (err) {
      console.error('qa center write failed:', err?.name)
      return json(503, { error: 'storage_error' })
    }
  }
}

const STATUS = { not_found: 404, result_not_found: 404, unknown_execution: 404, conflict: 409, already_running: 409, duplicate_results: 409, plan_changed: 409, not_active: 409, not_runnable: 403, verified_by_results_only: 400 }
export const fail = (r) => json(STATUS[r.error] || 400, r)
