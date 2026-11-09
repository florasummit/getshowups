// POST /api/platform/invites — invite an owner by email.
//   { email, customer }                        → invite to an existing business
//   { email, businessName, timezone, serviceZips? } → admin-assisted: create the business, then invite
// The invitee signs in with that Google account, accepts, and authorizes their own calendar.
import { json } from '../../../server/google-oauth.js'
import { EMAIL_RE } from '../../../server/auth.js'
import { audit, requirePlatformAdmin } from '../../../server/platform.js'
import { CUSTOMER_RE } from '../../../server/invites.js'
import { createCustomer, getCustomer, validateBusiness } from '../../../server/customers.js'
import { issueInvite } from '../../../server/accounts.js'
import { emailConfigured, flushOutbox } from '../../../server/email.js'

export async function onRequestPost({ request, env }) {
  const { admin, response } = await requirePlatformAdmin(request, env, { write: true })
  if (response) return response
  const body = await request.json().catch(() => ({}))
  const email = String(body?.email || '').trim().toLowerCase()
  if (!EMAIL_RE.test(email)) return json(400, { error: 'invalid_email' })
  const db = env.ONBOARDING_DB
  const member = await db.prepare('SELECT customer FROM customer_users WHERE email = ?1').bind(email).first()
  if (member) return json(409, { error: 'email_already_in_business', customer: member.customer })

  let customer = String(body?.customer || '').toLowerCase()
  let businessName
  if (customer) {
    if (!CUSTOMER_RE.test(customer)) return json(400, { error: 'invalid_customer' })
    const row = await getCustomer(db, customer)
    if (!row) return json(404, { error: 'not_found' })
    businessName = row.name
  } else {
    const [error, business] = validateBusiness({ name: body?.businessName, timezone: body?.timezone, serviceZips: body?.serviceZips })
    if (error) return json(400, { error })
    customer = await createCustomer(env, null, business, { source: 'assisted', via: 'admin_invite' })
    businessName = business.name
    await audit(env, admin.email, 'customer.create', customer, { name: business.name })
  }
  const invite = await issueInvite(env, { email, customer, businessName, actor: admin.email })
  await audit(env, admin.email, 'invite.create', customer, { email, inviteId: invite.id })
  const delivery = await flushOutbox(env)
  return json(201, {
    customer,
    inviteId: invite.id,
    url: invite.url,
    expiresAt: new Date(invite.expiresAt).toISOString(),
    email: emailConfigured(env) ? (delivery.sent > 0 ? 'sent' : 'queued') : 'not_configured',
  })
}
