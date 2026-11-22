// Business account types (server/business-accounts.js). Platform admins only; every write same-origin + audited.
//   GET  /api/platform/account?id=<business>  → { account, subscription, testMark, costs, history, classifications }
//   POST /api/platform/account { action: 'classify', customer, classification, providerSpend?, note?, confirm: true }
//   POST /api/platform/account { action: 'create', name, classification: 'sandbox'|'internal_live', ownerEmail?, note?, confirm: true }
import { json } from '../../../server/google-oauth.js'
import { audit, requirePlatformAdmin } from '../../../server/platform.js'
import { CUSTOMER_RE } from '../../../server/invites.js'
import { accountOf, accountsReady, classifyBusiness, createClassifiedBusiness, providerCosts, CLASSIFICATIONS } from '../../../server/business-accounts.js'
import { getSubscription } from '../../../server/stripe.js'
import { testStatus } from '../../../server/testbusiness.js'
import { listAudit } from '../../../server/auditlog.js'

export async function onRequestGet({ request, env }) {
  const { response } = await requirePlatformAdmin(request, env)
  if (response) return response
  const id = String(new URL(request.url).searchParams.get('id') || '').toLowerCase()
  if (!CUSTOMER_RE.test(id)) return json(400, { error: 'invalid_customer' })
  const db = env.ONBOARDING_DB
  if (!(await db.prepare('SELECT id FROM customers WHERE id = ?1').bind(id).first())) return json(404, { error: 'not_found' })
  const [account, sub, test, costs, ready] = await Promise.all([accountOf(env, id), getSubscription(db, id), testStatus(env, id), providerCosts(env, id), accountsReady(db)])
  // Classification history with the reason readable: the admin-only table (the permanent audit_log holds the same
  // events with free text reduced to refs; listAudit is the fallback when the admin table is unavailable).
  const history = await db
    .prepare("SELECT at, actor, details FROM admin_audit WHERE customer = ?1 AND action IN ('account.classify', 'account.create') ORDER BY at DESC LIMIT 20")
    .bind(id)
    .all()
    .then((r) => r.results.map((e) => ({ at: e.at, actor: e.actor, details: JSON.parse(e.details || '{}') })))
    .catch(async () => (await listAudit(db, { customer: id, limit: 200 }).catch(() => [])).filter((e) => e.action === 'account.classify' || e.action === 'account.create').slice(0, 20).map((e) => ({ at: e.at, actor: e.actor, details: e.details })))
  return json(200, {
    ready,
    account,
    classifications: Object.fromEntries(Object.entries(CLASSIFICATIONS).map(([k, v]) => [k, { label: v.label, what: v.what, billing: v.billing, environment: v.environment, providerSpend: v.providerSpend }])),
    subscription: sub ? { status: sub.status, planId: sub.planId, stripeSubscription: Boolean(sub.stripeSubscriptionId), stripeCustomer: Boolean(sub.stripeCustomerId), livemode: sub.livemode, currentPeriodEnd: sub.currentPeriodEnd, cancelAtPeriodEnd: sub.cancelAtPeriodEnd } : null,
    testMark: { test: test.test, unreadable: Boolean(test.unreadable) },
    costs,
    history,
  })
}

export async function onRequestPost({ request, env }) {
  const { admin, response } = await requirePlatformAdmin(request, env, { write: true })
  if (response) return response
  const body = await request.json().catch(() => ({}))
  if (body?.confirm !== true) return json(400, { error: 'confirm_required' })
  if (body.action === 'classify') {
    const customer = String(body.customer || '').toLowerCase()
    if (!CUSTOMER_RE.test(customer)) return json(400, { error: 'invalid_request' })
    const r = await classifyBusiness(env, admin, customer, String(body.classification || ''), { note: body.note, providerSpend: body.providerSpend ?? null })
    if (!r.ok) return json(r.httpStatus, { error: r.error })
    await audit(env, admin.email, 'account.classify', customer, { from: r.from, to: r.account.classification, billing: r.account.billing, environment: r.account.environment, providerSpend: r.account.providerSpend, testMark: r.testMark.test, note: r.note })
    return json(200, r)
  }
  if (body.action === 'create') {
    const r = await createClassifiedBusiness(env, admin, { name: body.name, classification: String(body.classification || ''), ownerEmail: body.ownerEmail, note: body.note })
    if (!r.ok) return json(r.httpStatus, { error: r.error })
    await audit(env, admin.email, 'account.create', r.id, { from: 'new', to: r.account.classification, billing: r.account.billing, environment: r.account.environment, providerSpend: r.account.providerSpend, owner: Boolean(body.ownerEmail), note: String(body.note || '').slice(0, 300) })
    return json(200, r)
  }
  return json(400, { error: 'invalid_action' })
}
