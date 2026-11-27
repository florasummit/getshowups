// Admin → Growth → Pipeline: one row per real business (from the same customerRows() the admin overview uses, so no
// second metrics system) joined with its commercial attribution (0048), assisted enrollment (stream B, read fail-soft)
// and billing facts, plus totals by channel and by closing rep. Rules:
//   - test businesses, the GetShowUps sales business and deleted accounts are never rows or counts (excluded count shown);
//   - payment 'confirmed' only for a subscription Stripe reports active/trialing/past due AND recorded live
//     (subscription_modes) while live billing is on; a test-mode subscription is 'test', never a customer;
//   - collected revenue = live 'revenue' events (paid invoices) only; null outside live billing;
//   - commission liability = the live ledger sum (accruals − reversals), only while live billing is on; test-mode ledger
//     rows are reported apart as test, never owed;
//   - partner acquisition cost = live commission liability ÷ live active customers of that channel (null without both);
//     GetShowUps' own ad cost per customer stays on Measure (server/sales-attribution.js), never repeated here;
//   - retention (live only) = still active ÷ ever on a live subscription, per channel; null when none yet.
// Counts, ids and business names only. Owner contact details never leave this function; rep addresses are staff.
import { customerRows, SALES_BUSINESS } from './metrics.js'
import { stripeLiveEnabled } from './stripe.js'
import { referralsEnabled } from './commissions.js'
import { CHANNELS } from './commercial-attribution.js'

const PAID = ['active', 'trialing', 'past_due']
const missing = (err) => String(err?.message || '').includes('no such table')
const soft = async (fn, fallback) => {
  try {
    return await fn()
  } catch (err) {
    if (!missing(err)) console.error('commercial report part unavailable:', 'storage_error')
    return fallback
  }
}

// Assisted enrollments (stream B, migration 0047), if present: business id → { stage, repEmail }. Columns are read
// defensively so a different shape degrades to "not available", never an error.
async function enrollments(db) {
  return soft(async () => {
    const { results } = await db.prepare('SELECT * FROM assisted_enrollments').all()
    const out = new Map()
    for (const r of results) {
      const id = r.customer ?? r.customer_id ?? r.business ?? null
      if (id) out.set(id, { stage: r.stage ?? r.status ?? null, repEmail: r.rep_email ?? r.assigned_rep ?? r.created_by ?? null })
    }
    return out
  }, new Map())
}

export function paymentState(sub, livemode, live, selfServe) {
  if (!sub) return selfServe ? 'pending' : 'not_billed'
  if (sub.status === 'canceled') return 'ended'
  if (!PAID.includes(sub.status)) return 'pending'
  return live && livemode === 1 ? 'confirmed' : 'test'
}

export async function commercialPipeline(env, now = Date.now()) {
  const db = env.ONBOARDING_DB
  const live = stripeLiveEnabled(env)
  const all = await customerRows(env, now)
  const real = all.filter((r) => !r.deleted && r.id !== SALES_BUSINESS)
  const rows = real.filter((r) => !r.testBusiness)
  const attribution = await soft(async () => new Map((await db.prepare('SELECT a.*, p.name AS partner_name FROM commercial_attribution a LEFT JOIN referral_partners p ON p.id = a.partner_id').all()).results.map((a) => [a.customer, a])), new Map())
  const modes = await soft(async () => new Map((await db.prepare('SELECT customer, livemode FROM subscription_modes').all()).results.map((m) => [m.customer, m.livemode])), new Map())
  const selfServe = await soft(async () => new Set((await db.prepare('SELECT customer FROM self_signups').all()).results.map((r) => r.customer)), new Set())
  const revenue = live
    ? await soft(async () => new Map((await db.prepare("SELECT customer, sum(json_extract(props, '$.amountCents')) AS cents FROM events WHERE type = 'revenue' AND json_extract(props, '$.livemode') = 1 GROUP BY customer").all()).results.map((r) => [r.customer, Number(r.cents || 0)])), new Map())
    : null
  const ledger = await soft(async () => (await db.prepare('SELECT customer, livemode, sum(amount_cents) AS cents FROM commission_ledger GROUP BY customer, livemode').all()).results, [])
  const liability = new Map(ledger.filter((l) => l.livemode === 1).map((l) => [l.customer, Number(l.cents || 0)]))
  const testLedger = ledger.filter((l) => l.livemode === 0).reduce((n, l) => n + Number(l.cents || 0), 0)
  const assisted = await enrollments(db)

  const out = rows.slice(0, 500).map((r) => {
    const a = attribution.get(r.id)
    const e = assisted.get(r.id)
    // Without a recorded attribution (businesses from before 0048): derived only where a record says so, else 'unrecorded'
    // (created_via defaults to self_serve on older rows, so it alone never proves a self-serve signup).
    const channel = a?.channel ?? (e ? 'sales_rep' : selfServe.has(r.id) ? 'self_serve' : r.createdVia === 'admin_invite' || r.createdVia === 'admin_link' ? 'founder' : 'unrecorded')
    const payment = paymentState(r.subscription, modes.get(r.id), live, selfServe.has(r.id))
    return {
      id: r.id,
      name: r.name,
      createdAt: r.createdAt,
      channel,
      attributed: Boolean(a),
      source: a?.marketing_source ?? r.source ?? 'direct',
      partner: a?.partner_id ? { id: a.partner_id, name: a.partner_name ?? null } : null,
      partnerRefusal: a?.partner_refusal ?? null,
      rep: a?.closing_rep_email ?? e?.repEmail ?? null,
      enrollmentStage: e?.stage ?? null,
      payment,
      setup: r.onboarding,
      invitation: r.owners ? 'claimed' : r.pendingInvites > 0 ? 'pending' : 'none',
      activeSubscription: payment === 'confirmed' && r.subscription?.status !== 'past_due',
      collectedRevenueCents: revenue ? (revenue.get(r.id) ?? 0) : null,
      commissionCents: live && a?.partner_id ? (liability.get(r.id) ?? 0) : null,
    }
  })
  const blank = (k) => ({ key: k, businesses: 0, paymentPending: 0, paymentConfirmed: 0, invitationPending: 0, claimed: 0, setupComplete: 0, activeSubscriptions: 0, everLive: 0, revenueCents: live ? 0 : null, commissionCents: live ? 0 : null })
  const group = (key) => {
    const g = new Map()
    for (const r of out) {
      const k = key(r)
      if (k == null) continue
      const t = g.get(k) || blank(k)
      t.businesses++
      if (r.payment === 'pending') t.paymentPending++
      if (r.payment === 'confirmed') t.paymentConfirmed++
      if (r.invitation === 'pending') t.invitationPending++
      if (r.invitation === 'claimed') t.claimed++
      if (r.setup === 'live') t.setupComplete++
      if (r.activeSubscription) t.activeSubscriptions++
      if (live && modes.get(r.id) === 1 && (r.payment === 'confirmed' || r.payment === 'ended')) t.everLive++
      if (live) t.revenueCents += r.collectedRevenueCents || 0
      if (live) t.commissionCents += r.commissionCents || 0
      g.set(k, t)
    }
    return [...g.values()].map((t) => ({
      ...t,
      retention: live && t.everLive > 0 ? Math.round((t.activeSubscriptions / t.everLive) * 1000) / 1000 : null,
      acquisitionCostCents: live && t.commissionCents > 0 && t.activeSubscriptions > 0 ? Math.round(t.commissionCents / t.activeSubscriptions) : null,
    }))
  }
  const byChannel = group((r) => r.channel)
  for (const c of CHANNELS) if (!byChannel.some((g) => g.key === c)) byChannel.push({ ...blank(c), retention: null, acquisitionCostCents: null })
  const order = [...CHANNELS, 'unrecorded']
  byChannel.sort((x, y) => order.indexOf(x.key) - order.indexOf(y.key))
  return {
    generatedAt: now,
    billingMode: live ? 'live' : 'test',
    referralsEnabled: referralsEnabled(env),
    attributionReady: await soft(async () => Boolean(await db.prepare('SELECT 1 FROM commercial_attribution LIMIT 1').all()), false),
    enrollmentsReady: assisted.size > 0 || (await soft(async () => Boolean(await db.prepare('SELECT 1 FROM assisted_enrollments LIMIT 1').all()), false)),
    excludedTest: real.length - rows.length,
    rows: out,
    byChannel,
    byRep: group((r) => r.rep).sort((x, y) => y.businesses - x.businesses),
    testCommissionCents: testLedger,
  }
}
