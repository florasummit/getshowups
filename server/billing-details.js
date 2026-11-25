// What the owner sees and does about their plan: next charge, card on file (brand and last four only), invoices and
// receipts, cancel at the end of the paid period, and keep the plan. Read from Stripe when the owner opens it; nothing of
// it is stored. Nothing is called done until Stripe's own answer says so, and the stored subscription is then refreshed
// from Stripe (server/reconcile.js), never guessed. Cancelling only ever reduces what will be charged.
import { billingSubscription, fetchStripeSubscription, getSubscription, liveBlocked, stripeConfigured, stripeLiveEnabled, stripeModeMismatch, stripePost } from './stripe.js'
import { resyncFromStripe } from './reconcile.js'
import { recordEvent } from './auditlog.js'

const RUNNING = ['active', 'trialing', 'past_due', 'unpaid', 'paused', 'incomplete']
const httpsUrl = (u) => (typeof u === 'string' && /^https:\/\/([a-z0-9-]+\.)*stripe\.com\//.test(u) ? u : null)
const ending = (s) => Boolean(s.cancel_at_period_end || s.cancel_at)
const paidUntil = (s) => {
  const ends = (s.items?.data || []).map((i) => i.current_period_end).filter(Number.isFinite)
  return s.current_period_end ?? (ends.length ? Math.max(...ends) : null)
}
const endsThisPeriod = (s) => Boolean(s.cancel_at_period_end || (s.cancel_at && paidUntil(s) && s.cancel_at <= paidUntil(s) + 60))
const periodEnd = (s) => {
  const ends = (s.items?.data || []).map((i) => i.current_period_end).filter(Number.isFinite)
  const t = s.cancel_at ?? s.current_period_end ?? (ends.length ? Math.max(...ends) : null)
  return t ? t * 1000 : null
}

// → { ok, nextCharge, card, invoices }: each part null when Stripe couldn't be read (shown as unavailable, never guessed).
export async function billingDetails(env, customerId) {
  const sub = await billingSubscription(env, customerId)
  if (!stripeConfigured(env) || !sub?.stripeCustomerId || sub.sandbox) return { ok: false, error: 'no_billing_account' }
  if (await liveBlocked(env, customerId)) return { ok: false, error: 'test_business' }
  const running = sub.stripeSubscriptionId && sub.status !== 'canceled'
  const get = (path, params) => stripePost(env, path, params, { method: 'GET' })
  const [s, inv, cus] = await Promise.all([
    running ? get(`/subscriptions/${encodeURIComponent(sub.stripeSubscriptionId)}`, { expand: { 0: 'default_payment_method' } }) : null,
    get('/invoices', { customer: sub.stripeCustomerId, limit: 24 }),
    get(`/customers/${encodeURIComponent(sub.stripeCustomerId)}`, { expand: { 0: 'invoice_settings.default_payment_method' } }),
  ])
  let nextCharge = null
  if (s?.ok && RUNNING.includes(s.body.status)) {
    if (ending(s.body)) nextCharge = { none: true, endsAt: periodEnd(s.body) }
    else {
      // Stripe's own preview of the next invoice (nothing is created); the older endpoint name for older API versions.
      let p = await stripePost(env, '/invoices/create_preview', { subscription: sub.stripeSubscriptionId })
      if (!p.ok && [404, 400].includes(p.httpStatus)) p = await get('/invoices/upcoming', { subscription: sub.stripeSubscriptionId })
      nextCharge = p.ok && Number.isFinite(p.body.amount_due) ? { amountCents: p.body.amount_due, currency: p.body.currency || 'usd', at: (p.body.next_payment_attempt ?? p.body.period_end ?? null) ? (p.body.next_payment_attempt ?? p.body.period_end) * 1000 : periodEnd(s.body) } : { amountCents: null, at: periodEnd(s.body) }
    }
  }
  const pm = [s?.ok && s.body.default_payment_method, cus?.ok && cus.body.invoice_settings?.default_payment_method].find((x) => x && typeof x === 'object')
  return {
    ok: true,
    nextCharge,
    card: pm ? { type: pm.card ? 'card' : String(pm.type || 'other').slice(0, 20), brand: pm.card?.brand ? String(pm.card.brand).slice(0, 20) : null, last4: /^\d{4}$/.test(pm.card?.last4 || '') ? pm.card.last4 : null, expires: pm.card?.exp_month && pm.card?.exp_year ? `${pm.card.exp_month}/${pm.card.exp_year}` : null } : s?.ok && cus?.ok ? { type: 'unknown' } : null,
    invoices: inv.ok
      ? (inv.body.data || [])
          .filter((i) => i.status !== 'draft' && (!i.customer || i.customer === sub.stripeCustomerId))
          .map((i) => ({ number: i.number ? String(i.number).slice(0, 40) : null, at: i.created * 1000, status: String(i.status || '').slice(0, 20), amountCents: i.status === 'paid' ? (i.amount_paid ?? null) : (i.amount_due ?? null), currency: i.currency || 'usd', url: httpsUrl(i.hosted_invoice_url), pdf: httpsUrl(i.invoice_pdf) }))
      : null,
  }
}

async function runningSub(env, customerId, { access = true } = {}) {
  if (!stripeConfigured(env)) return { ok: false, error: 'billing_not_configured' }
  if (await liveBlocked(env, customerId)) return { ok: false, error: 'test_business' }
  const sub = access ? await billingSubscription(env, customerId) : await getSubscription(env.ONBOARDING_DB, customerId)
  if (!sub?.stripeSubscriptionId || sub.sandbox) return { ok: false, error: 'no_subscription' }
  const r = await fetchStripeSubscription(env, sub.stripeSubscriptionId)
  if (!r.ok) return { ok: false, error: r.error, unavailable: true }
  if (r.body.livemode === true && !stripeLiveEnabled(env)) return { ok: false, error: 'livemode_not_enabled' }
  return { ok: true, id: sub.stripeSubscriptionId, body: r.body }
}

async function settle(env, customerId, type, actor, body, now) {
  // Our record follows Stripe; a failure here is not a failed cancellation (the webhook and daily check also bring it).
  const synced = await resyncFromStripe(env, customerId, now).then((r) => r.ok === true, () => false)
  await recordEvent(env.ONBOARDING_DB, { type, actorType: actor.type, actor: actor.type === 'owner' ? `owner:${actor.id}` : actor.id, customer: customerId, capability: 'billing.stripe', resource: { type: 'subscription', id: body.id }, outcome: 'success', details: { endsAt: periodEnd(body), synced }, at: now })
  return { ok: true, endsAt: periodEnd(body), recorded: synced }
}

// Cancel at the end of the paid period. Idempotent: already ending or already ended is success.
export async function cancelPlan(env, customerId, actor, now = Date.now()) {
  const s = await runningSub(env, customerId)
  if (!s.ok) return s
  if (!RUNNING.includes(s.body.status)) return { ...(await settle(env, customerId, 'billing.cancel_requested', actor, s.body, now)), ended: true, endsAt: null }
  let body = s.body
  if (!ending(body)) {
    const r = await stripePost(env, `/subscriptions/${encodeURIComponent(s.id)}`, { cancel_at_period_end: true })
    if (!r.ok) return { ok: false, error: r.error, unavailable: true }
    if (!ending(r.body)) return { ok: false, error: 'not_confirmed', unavailable: true }
    body = r.body
  }
  return settle(env, customerId, 'billing.cancel_requested', actor, body, now)
}

// Keep the plan: charges continue, so the owner must have confirmed the amount they were shown.
export async function keepPlan(env, customerId, actor, now = Date.now()) {
  const s = await runningSub(env, customerId)
  if (!s.ok) return s
  if (!['active', 'trialing', 'past_due'].includes(s.body.status)) return { ok: false, error: 'subscription_ended' }
  let body = s.body
  if (ending(body)) {
    const r = await stripePost(env, `/subscriptions/${encodeURIComponent(s.id)}`, body.cancel_at_period_end ? { cancel_at_period_end: false } : { cancel_at: '' })
    if (!r.ok) return { ok: false, error: r.error, unavailable: true }
    if (ending(r.body)) return { ok: false, error: 'not_confirmed', unavailable: true }
    body = r.body
  }
  return settle(env, customerId, 'billing.cancel_withdrawn', actor, body, now)
}

// For an account in its closing window: make sure nothing renews. No subscription = nothing to end.
export async function scheduleCancel(env, customerId, now = Date.now()) {
  const sub = await getSubscription(env.ONBOARDING_DB, customerId)
  if (!sub?.stripeSubscriptionId || sub.status === 'canceled') return { ok: true, none: true }
  if (stripeModeMismatch(env, sub)) return { ok: false, error: 'stripe_mode_mismatch' }
  const s = await runningSub(env, customerId, { access: false })
  if (!s.ok) return s.error === 'resource_missing' && sub.livemode !== true ? { ok: true, none: true } : s
  // For a closing, only an end no later than the paid period counts: a far-off end date would still renew first.
  if (RUNNING.includes(s.body.status) && !endsThisPeriod(s.body)) return cancelPlanRaw(env, customerId, s, now)
  // Already ending at Stripe: make sure our record says so too.
  if (!sub.cancelAtPeriodEnd) await resyncFromStripe(env, customerId, now).catch(() => null)
  return { ok: true }
}
async function cancelPlanRaw(env, customerId, s, now) {
  const r = await stripePost(env, `/subscriptions/${encodeURIComponent(s.id)}`, { cancel_at_period_end: true })
  if (!r.ok) return { ok: false, error: r.error }
  if (!endsThisPeriod(r.body)) return { ok: false, error: 'not_confirmed' }
  return settle(env, customerId, 'billing.cancel_requested', { type: 'system', id: 'system:deletion' }, r.body, now)
}
