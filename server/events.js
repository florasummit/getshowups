// Analytics events. Deduplicated by id (INSERT OR IGNORE) so retries never double count.
// Never throws: analytics must not break a customer request. Props must not contain personal data.
import { randomToken } from './google-oauth.js'

export async function track(env, type, { id, customer = null, props = {}, at = Date.now(), replace = false } = {}) {
  try {
    await env.ONBOARDING_DB.prepare(
      `INSERT ${replace ? 'OR REPLACE' : 'OR IGNORE'} INTO events (id, type, customer, at, props) VALUES (?1, ?2, ?3, ?4, ?5)`,
    )
      .bind(id || `${type}:${randomToken(9)}`, type, customer, at, JSON.stringify(props))
      .run()
  } catch (err) {
    console.error('event not recorded:', type, err?.message)
  }
}
