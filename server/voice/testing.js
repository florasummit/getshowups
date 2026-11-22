// Provider tests on the customer path (docs/RECEPTIONIST.md "Voice management"): a platform admin runs a candidate
// provider through the REAL customer-facing voice integration on an admin-marked TEST business, in dry run (tools
// answer but book nothing and message nobody). The session is recorded like any other (receptionist_conversations
// state.voice with test: true) and is the evidence providerVerification / providerEvidence read; nothing here marks a
// test as passed.
//
// The test page is /chat/<test business>?test=<provider>. A test business normally has its receptionist OFF for
// customers (nobody should chat with a sandbox), which also hides the chat page; adminTestAccess is the one rule that
// lets the page render for the admin's test anyway: signed-in platform admin + test business + a configured,
// not-switched-off provider. Customers never get through it (anonymous or owner sessions are refused by
// testOverrideAllowed), and the receptionist stays off for them.
import { getSession } from '../auth.js'
import { bookableCustomer } from '../public.js'
import { isTestBusinessSql } from '../testbusiness.js'
import { providerDisabled, testOverrideAllowed } from './customer.js'
import { providerStatus, PROVIDERS } from './providers.js'
import { PROVIDER_CAPABILITIES } from './style.js'

const MAX_CANDIDATES = 20

// Is this request an authorized admin test of `provider` on `customer` (already bookable)?
//   → { ok: true, provider, name, admin } | { ok: false, error: invalid_provider | test_not_allowed | not_test_business
//                                                                 | voice_not_configured | voice_unavailable }
export async function adminTestAccess(env, request, customer, provider) {
  if (!PROVIDERS.includes(provider)) return { ok: false, error: 'invalid_provider' }
  let session = null
  try {
    session = await getSession(request, env)
  } catch {
    session = null
  }
  const allowed = session ? await testOverrideAllowed(env, customer, session.email) : { ok: false, error: 'test_not_allowed' }
  if (!allowed.ok) return { ok: false, error: allowed.error }
  if (!providerStatus(env)[provider]?.configured) return { ok: false, error: 'voice_not_configured' }
  if (providerDisabled(env, provider)) return { ok: false, error: 'voice_unavailable' }
  return { ok: true, provider, name: PROVIDER_CAPABILITIES[provider]?.name || provider, admin: allowed.admin }
}

// The admin-marked test businesses a production-path test can run on: bookable like any customer (active, hours
// confirmed, calendar connected, hosted), not deleted. Businesses WITHOUT a service-area list first (a ZIP outside the
// list sends the receptionist down the coverage-request path, never to the booking tools the verification needs; see
// the 2026-11-22 ElevenLabs test), then receptionist-on ones, then by name. Names, ids and the first service ZIP only
// (the ZIP an admin should say when asked where they are).
export async function eligibleTestBusinesses(env) {
  const db = env.ONBOARDING_DB
  let rows = []
  try {
    const r = await db
      .prepare(
        `SELECT c.id, c.name, (SELECT enabled FROM receptionist_settings rs WHERE rs.customer = c.id) AS receptionist
           FROM customers c
          WHERE ${isTestBusinessSql('c.id')}
            AND c.status = 'active'
            AND NOT EXISTS (SELECT 1 FROM account_deletions d WHERE d.customer = c.id)
          ORDER BY c.name COLLATE NOCASE
          LIMIT ?1`,
      )
      .bind(MAX_CANDIDATES)
      .all()
    rows = r.results || []
  } catch {
    rows = [] // a table missing (0016 / 0026 / test_businesses) → no candidate is claimed
  }
  const out = []
  for (const r of rows) {
    const { customer } = await bookableCustomer(env, { customer: r.id }).catch(() => ({}))
    if (customer) out.push({ id: r.id, name: r.name, receptionist: Number(r.receptionist) === 1, zips: customer.serviceZips.length, zip: customer.serviceZips[0] || null })
  }
  return out.sort((a, b) => Number(a.zips > 0) - Number(b.zips > 0) || Number(b.receptionist) - Number(a.receptionist) || a.name.localeCompare(b.name))
}

// The test page for `provider`: the first eligible test business, or null (with why) when there is none.
//   → { url, business: { id, name, receptionist }, provider } | { url: null, reason: 'no_test_business' | 'not_configured' | 'disabled' | 'no_customer_path' }
export async function testPageFor(env, provider) {
  const cap = PROVIDER_CAPABILITIES[provider]
  if (!cap?.customers) return { url: null, reason: 'no_customer_path' }
  if (!providerStatus(env)[provider]?.configured) return { url: null, reason: 'not_configured' }
  if (providerDisabled(env, provider)) return { url: null, reason: 'disabled' }
  const [business] = await eligibleTestBusinesses(env)
  if (!business) return { url: null, reason: 'no_test_business' }
  return { url: `/chat/${business.id}?test=${provider}&from=admin`, business, provider }
}
