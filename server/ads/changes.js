// Owner-approved changes to the account's own (imported) campaigns: status (pause / start) and daily budget, the two
// fields Google lets anyone change on every campaign type (standalone Local Services campaigns included). Each
// change is a request: current value → proposed value → the expected effect in plain words → the owner's explicit
// approval → applied through the Google Ads API → read back → recorded (ad_change_requests + ad_actions + the audit
// log). Nothing changes on Google without the approval step; starting a campaign or raising a budget also needs the
// serving guard (ADS_LIVE_LAUNCH, or a verified Google Ads test account) and no ads hold, exactly like GetShowUps'
// own campaigns. Pausing and lowering are always allowed. Requests older than 7 days expire unapplied.
import { randomToken } from '../google-oauth.js'
import { setImportedBudget, setImportedStatus } from './google.js'
import { LIMITS } from './spec.js'
import { adsHold } from './holds.js'
import { importsReady } from './imports.js'
import { logAction } from './campaigns.js'

export const FIELDS = ['status', 'daily_budget']
export const REQUEST_TTL_MS = 7 * 86_400_000
const ID_RE = /^[A-Za-z0-9_-]{8,40}$/
const usd = (c) => `$${(c / 100).toLocaleString('en-US', { maximumFractionDigits: c % 100 ? 2 : 0 })}`

const changesReady = async (db) => {
  try {
    return Number((await db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'ad_change_requests'").first())?.n) === 1 && (await importsReady(db))
  } catch {
    return false
  }
}

// What the owner is told before approving: the effect as a mechanism, never a promise of results.
export function expectedEffect(field, current, proposed, { channelType = 'SEARCH' } = {}) {
  if (field === 'status') {
    if (proposed.status === 'PAUSED') return 'Delivery stops within minutes. Clicks already served can still be billed. Nothing else in the campaign changes; you can start it again later.'
    return channelType === 'LOCAL_SERVICES' ? 'Google starts offering your listing for these services again and charges per lead at its current rates, within the campaign’s budget.' : `Delivery resumes with the campaign’s current settings and budget${current.dailyBudgetCents != null ? ` (about ${usd(current.dailyBudgetCents)} a day on average, up to twice that on a busy day)` : ''}.`
  }
  const from = current.dailyBudgetCents
  const to = proposed.dailyBudgetCents
  const dir = from == null ? 'sets' : to > from ? 'raises' : to < from ? 'lowers' : 'keeps'
  const monthly = Math.round((to * 30.4) / 100)
  return `${dir === 'keeps' ? 'Keeps' : dir.charAt(0).toUpperCase() + dir.slice(1)} the average daily budget${from != null ? ` from ${usd(from)}` : ''} to ${usd(to)} (about $${monthly.toLocaleString('en-US')} a month at most). Google may spend up to twice the daily average on a busy day, never more than about 30 days’ worth in a month. ${dir === 'raises' ? 'More budget does not guarantee more leads; it lets the campaign show for more searches.' : dir === 'lowers' ? 'Fewer searches will show the ad; cost per lead may go up or down.' : ''}`.trim()
}

const parse = (s) => {
  try {
    return JSON.parse(s || '{}')
  } catch {
    return {}
  }
}

// Records a proposed change against the business's own imported campaign (never another business's).
export async function proposeChange(env, customer, { importedId, field, value }, actor, now = Date.now()) {
  const db = env.ONBOARDING_DB
  if (!(await changesReady(db))) return { ok: false, error: 'not_ready' }
  if (!ID_RE.test(String(importedId || '')) || !FIELDS.includes(field)) return { ok: false, error: 'invalid_request' }
  const row = await db.prepare("SELECT * FROM ad_imported_campaigns WHERE id = ?1 AND customer = ?2 AND platform = 'google'").bind(importedId, customer.id).first()
  if (!row) return { ok: false, error: 'not_found' }
  if (row.status === 'REMOVED') return { ok: false, error: 'campaign_removed' }
  const settings = parse(row.settings)
  let current
  let proposed
  if (field === 'status') {
    if (!['PAUSED', 'ENABLED'].includes(value)) return { ok: false, error: 'invalid_request' }
    if (value === row.status) return { ok: false, error: 'no_change' }
    current = { status: row.status, dailyBudgetCents: row.daily_budget_cents }
    proposed = { status: value }
  } else {
    if (!Number.isInteger(value) || value < LIMITS.minDailyBudgetCents || value > 1_000_000_00) return { ok: false, error: 'invalid_budget' }
    if (settings.sharedBudget) return { ok: false, error: 'shared_budget' }
    if (value === row.daily_budget_cents) return { ok: false, error: 'no_change' }
    current = { dailyBudgetCents: row.daily_budget_cents }
    proposed = { dailyBudgetCents: value }
  }
  // One open request per campaign and field: a newer proposal replaces the older one.
  await db.prepare("UPDATE ad_change_requests SET status = 'cancelled', result = '{\"replaced\":true}' WHERE customer = ?1 AND imported_id = ?2 AND field = ?3 AND status = 'proposed'").bind(customer.id, importedId, field).run()
  const id = randomToken(12)
  await db.prepare('INSERT INTO ad_change_requests (id, customer, imported_id, field, current, proposed, status, actor, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)').bind(id, customer.id, importedId, field, JSON.stringify(current), JSON.stringify(proposed), 'proposed', actor, now).run()
  return { ok: true, request: publicRequest({ id, imported_id: importedId, field, current: JSON.stringify(current), proposed: JSON.stringify(proposed), status: 'proposed', created_at: now, applied_at: null, result: '{}' }, row.channel_type) }
}

export const publicRequest = (r, channelType = 'SEARCH') => {
  const current = parse(r.current)
  const proposed = parse(r.proposed)
  return { id: r.id, importedId: r.imported_id, field: r.field, current, proposed, status: r.status, effect: expectedEffect(r.field, current, proposed, { channelType }), createdAt: r.created_at, appliedAt: r.applied_at, result: parse(r.result) }
}

// The owner's approval applies the change (confirm must be true at the route), then Google is read back.
export async function applyChange(env, customer, id, actor, now = Date.now()) {
  const db = env.ONBOARDING_DB
  if (!(await changesReady(db)) || !ID_RE.test(String(id || ''))) return { ok: false, error: 'not_found' }
  const req = await db.prepare("SELECT * FROM ad_change_requests WHERE id = ?1 AND customer = ?2 AND status = 'proposed'").bind(id, customer.id).first()
  if (!req) return { ok: false, error: 'not_found' }
  if (now - req.created_at > REQUEST_TTL_MS) {
    await db.prepare("UPDATE ad_change_requests SET status = 'cancelled', result = '{\"expired\":true}' WHERE id = ?1").bind(id).run()
    return { ok: false, error: 'request_expired' }
  }
  const row = await db.prepare("SELECT * FROM ad_imported_campaigns WHERE id = ?1 AND customer = ?2").bind(req.imported_id, customer.id).first()
  if (!row || row.status === 'REMOVED') return { ok: false, error: 'campaign_removed' }
  const proposed = parse(req.proposed)
  const current = parse(req.current)
  const increases = req.field === 'status' ? proposed.status === 'ENABLED' : current.dailyBudgetCents == null || proposed.dailyBudgetCents > current.dailyBudgetCents
  if (increases) {
    const hold = await adsHold(env, customer.id)
    if (hold) return { ok: false, error: 'ads_on_hold', hold: hold.reason }
  }
  await db.prepare("UPDATE ad_change_requests SET status = 'approved', applied_at = ?2 WHERE id = ?1").bind(id, now).run()
  const r = req.field === 'status' ? await setImportedStatus(env, customer.id, row.external_id, proposed.status) : await setImportedBudget(env, customer.id, row.external_id, proposed.dailyBudgetCents)
  const kind = req.field === 'status' ? (proposed.status === 'PAUSED' ? 'imported_pause' : 'imported_resume') : 'imported_budget'
  if (!r.ok) {
    await db.prepare("UPDATE ad_change_requests SET status = 'failed', applied_at = ?2, result = ?3 WHERE id = ?1").bind(id, now, JSON.stringify({ error: r.error })).run()
    await logAction(db, { customer: customer.id, campaignId: row.id, actor, kind, status: 'failed', reason: `Change to ${row.name.slice(0, 80)} failed: ${r.error}`, details: { imported: true, externalId: row.external_id, field: req.field, error: r.error } }, now)
    return { ok: false, error: r.error }
  }
  const google = r.google || null
  await db.prepare("UPDATE ad_change_requests SET status = 'applied', applied_at = ?2, result = ?3 WHERE id = ?1").bind(id, now, JSON.stringify({ google })).run()
  // Our copy follows what Google read back (or the applied value when the read-back failed).
  const status = google?.status || (req.field === 'status' ? proposed.status : row.status)
  const budget = google?.dailyBudgetCents ?? (req.field === 'daily_budget' ? proposed.dailyBudgetCents : row.daily_budget_cents)
  await db.prepare('UPDATE ad_imported_campaigns SET status = ?3, daily_budget_cents = ?4, synced_at = ?5 WHERE id = ?1 AND customer = ?2').bind(row.id, customer.id, status, budget, now).run()
  await logAction(db, { customer: customer.id, campaignId: row.id, actor, kind, reason: req.field === 'status' ? `${proposed.status === 'PAUSED' ? 'Paused' : 'Started'} ${row.name.slice(0, 80)} (your own Google Ads campaign)` : `Daily budget of ${row.name.slice(0, 80)} set to ${usd(proposed.dailyBudgetCents)}`, details: { imported: true, externalId: row.external_id, field: req.field, proposed, google } }, now)
  return { ok: true, request: publicRequest({ ...req, status: 'applied', applied_at: now, result: JSON.stringify({ google }) }, row.channel_type), google }
}

export async function cancelChange(env, customer, id, now = Date.now()) {
  const db = env.ONBOARDING_DB
  if (!(await changesReady(db)) || !ID_RE.test(String(id || ''))) return { ok: false, error: 'not_found' }
  const r = await db.prepare("UPDATE ad_change_requests SET status = 'cancelled', applied_at = ?3, result = '{\"cancelled\":true}' WHERE id = ?1 AND customer = ?2 AND status = 'proposed'").bind(id, customer.id, now).run()
  return r.meta.changes ? { ok: true } : { ok: false, error: 'not_found' }
}

// Open requests and the last outcomes, per imported campaign (for the Ads tab).
export async function listChanges(db, customerId, { now = Date.now() } = {}) {
  if (!(await changesReady(db))) return {}
  const { results } = await db.prepare("SELECT r.*, c.channel_type FROM ad_change_requests r JOIN ad_imported_campaigns c ON c.id = r.imported_id WHERE r.customer = ?1 AND (r.status = 'proposed' OR r.applied_at >= ?2) ORDER BY r.created_at DESC LIMIT 100").bind(customerId, now - REQUEST_TTL_MS).all()
  const out = {}
  for (const r of results) {
    const req = publicRequest(r, r.channel_type)
    if (req.status === 'proposed' && now - req.createdAt > REQUEST_TTL_MS) continue
    ;(out[r.imported_id] ||= { open: [], recent: [] })[req.status === 'proposed' ? 'open' : 'recent'].push(req)
  }
  return out
}
