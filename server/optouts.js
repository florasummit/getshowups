// Opt-outs from a business's automatic follow-ups (migration 0014). Follow-ups are the acquisition messages:
// unbooked-lead follow-ups and the no-show rebook invitation. Booking confirmations and reminders are about an
// appointment the person made, so they still go out. Addresses are stored only as SHA-256 hashes.
import { sha256Hex } from './google-oauth.js'
import { siteOrigin } from './auth.js'
import { linkToken } from './links.js'
import { toE164 } from './sms.js'

export const FOLLOW_UP_KINDS = ['lead_followup_1', 'lead_followup_2', 'no_show_rebook']

const normalized = (channel, address) => (channel === 'email' ? String(address || '').trim().toLowerCase() : toE164(address))

export async function addressHash(channel, address) {
  const n = normalized(channel, address)
  return n ? sha256Hex(`${channel}:${n}`) : null
}

export async function isOptedOut(env, customer, channel, address) {
  const hash = await addressHash(channel, address)
  if (!hash) return false
  try {
    return Boolean(
      await env.ONBOARDING_DB.prepare('SELECT 1 FROM message_optouts WHERE customer = ?1 AND channel = ?2 AND address_hash = ?3').bind(customer, channel, hash).first(),
    )
  } catch (err) {
    // Before migration 0014 no opt-out can have been recorded, so nothing is suppressed wrongly.
    console.error('optouts: lookup failed:', err?.message?.includes('no such table') ? 'table_missing' : 'storage_error')
    return false
  }
}

// Idempotent: returns true when this call recorded a new opt-out.
export async function recordOptOut(env, customer, channel, address, source, now = Date.now()) {
  const hash = await addressHash(channel, address)
  if (!hash) return false
  const res = await env.ONBOARDING_DB.prepare('INSERT OR IGNORE INTO message_optouts (customer, channel, address_hash, source, created_at) VALUES (?1, ?2, ?3, ?4, ?5)')
    .bind(customer, channel, hash, source, now)
    .run()
  return (res?.meta?.changes ?? 0) > 0
}

export const unsubscribeUrl = async (env, leadId) =>
  `${siteOrigin(env)}/api/messages/unsubscribe?l=${encodeURIComponent(leadId)}&k=${await linkToken(env, 'unsubscribe', leadId)}`
