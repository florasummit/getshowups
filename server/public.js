// Shared guard for the public booking API (/api/book/:customer). Only businesses that finished
// setup (calendar connected + hours saved) are bookable; others look like they do not exist.
import { json, missingConfig } from './google-oauth.js'
import { CUSTOMER_RE } from './invites.js'
import { customerFromRow, isSameOrigin } from './auth.js'
import { getCustomer } from './customers.js'

export async function bookableCustomer(env, params, { write = false, request } = {}) {
  if (missingConfig(env).length) return { response: json(503, { error: 'not_configured' }) }
  if (write && !isSameOrigin(request, env)) return { response: json(403, { error: 'forbidden' }) }
  const id = String(params?.customer || '').toLowerCase()
  if (!CUSTOMER_RE.test(id)) return { response: json(404, { error: 'not_found' }) }
  const customer = customerFromRow(await getCustomer(env.ONBOARDING_DB, id))
  if (!customer || customer.status !== 'active' || !customer.hoursConfirmed || !(await env.GOOGLE_TOKENS.get(`google:${id}`))) {
    return { response: json(404, { error: 'not_found' }) }
  }
  return { customer }
}
