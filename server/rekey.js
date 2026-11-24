// Re-encrypts every stored secret with the current TOKEN_ENCRYPTION_KEY (docs/KEY_ROTATION.md). Run while
// TOKEN_ENCRYPTION_KEY_PREVIOUS is set. Idempotent: a record the current key already opens is left alone. A record neither
// key opens is counted and left untouched. Returns counts only; never a value.
import { decrypt, encrypt } from './google-oauth.js'
import { openKey, sealKey } from './ai-credentials.js'
import { openToken, sealToken } from './followups/twilio.js'

export async function rekey(env) {
  const out = { rewritten: 0, current: 0, unreadable: 0 }
  const now = { ...env, TOKEN_ENCRYPTION_KEY_PREVIOUS: undefined }
  // open(env) → plaintext; write(plaintext) stores it again under the current key.
  const one = async (open, write) => {
    try {
      await open(now)
      out.current++
      return
    } catch {
      // not the current key's
    }
    try {
      const plain = await open(env)
      await write(plain)
      out.rewritten++
    } catch {
      out.unreadable++
    }
  }
  const kv = env.GOOGLE_TOKENS
  const keys = async (prefix) => {
    const names = []
    let cursor
    do {
      const r = await kv.list({ prefix, cursor })
      names.push(...r.keys.map((k) => k.name))
      cursor = r.list_complete ? null : r.cursor
    } while (cursor)
    return names
  }
  for (const prefix of ['google:', 'google-archive:'])
    for (const name of await keys(prefix)) {
      const raw = await kv.get(name)
      let rec = null
      try {
        rec = JSON.parse(raw)
      } catch {
        // counted below
      }
      if (!rec?.refreshToken) {
        out.unreadable++
        continue
      }
      await one((e) => decrypt(e, rec.refreshToken), async (p) => kv.put(name, JSON.stringify({ ...rec, refreshToken: await encrypt(now, p) })))
    }
  for (const prefix of ['ads:', 'ghl:'])
    for (const name of await keys(prefix)) {
      const raw = await kv.get(name)
      if (raw) await one((e) => decrypt(e, raw), async (p) => kv.put(name, await encrypt(now, p)))
    }
  const db = env.ONBOARDING_DB
  const rows = async (sql) => (await db.prepare(sql).all().catch(() => ({ results: [] }))).results
  for (const r of await rows('SELECT customer, provider, sealed FROM ai_credentials'))
    await one((e) => openKey(e, r.customer, r.provider, r.sealed), async (p) => db.prepare('UPDATE ai_credentials SET sealed = ?2 WHERE customer = ?1 AND sealed = ?3').bind(r.customer, await sealKey(now, r.customer, r.provider, p), r.sealed).run())
  for (const r of await rows("SELECT customer, account_sid, auth_token_enc FROM sms_accounts"))
    await one((e) => openToken(e, r.customer, r.account_sid, r.auth_token_enc), async (p) => db.prepare('UPDATE sms_accounts SET auth_token_enc = ?2 WHERE customer = ?1 AND auth_token_enc = ?3').bind(r.customer, await sealToken(now, r.customer, r.account_sid, p), r.auth_token_enc).run())
  for (const r of await rows("SELECT lead_id, json_extract(details, '$.gclidEnc') AS g FROM lead_attribution WHERE json_extract(details, '$.gclidEnc') IS NOT NULL"))
    await one((e) => decrypt(e, r.g), async (p) => db.prepare("UPDATE lead_attribution SET details = json_set(details, '$.gclidEnc', ?2) WHERE lead_id = ?1").bind(r.lead_id, await encrypt(now, p)).run())
  return out
}
