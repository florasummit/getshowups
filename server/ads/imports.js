// Existing campaigns in a business's connected Google Ads account (Journey A: the customer already advertises).
// Read from Google (server/ads/google.js readAccountCampaigns / fetchAccountMetrics), kept in ad_imported_campaigns +
// ad_imported_metrics_daily (migration 0037) and shown read-only in the Ads tab. GetShowUps never changes an imported
// campaign here: edits come later through ad_change_requests with the owner's approval. Campaigns GetShowUps created
// itself (ad_campaigns, name tag [gsu:<id>]) are never imported. Fail-soft: before 0037 is applied everything reports
// { ready: false } and the cron step does nothing.
import { randomToken } from '../google-oauth.js'
import { fetchAccountMetrics, readAccountCampaigns } from './google.js'

const DAY = 86_400_000
export const IMPORT_TABLES = ['ad_imported_campaigns', 'ad_imported_metrics_daily', 'ad_import_state']
const ready = new WeakSet()
export async function importsReady(db) {
  if (!db) return false
  if (ready.has(db)) return true
  try {
    const r = await db.prepare(`SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN ('ad_imported_campaigns', 'ad_imported_metrics_daily', 'ad_import_state')`).first()
    const ok = Number(r?.n) === IMPORT_TABLES.length
    if (ok) ready.add(db)
    return ok
  } catch {
    return false
  }
}

export const CHANNEL_LABEL = {
  SEARCH: 'Search',
  LOCAL_SERVICES: 'Local Services',
  PERFORMANCE_MAX: 'Performance Max',
  DISPLAY: 'Display',
  VIDEO: 'Video',
  SHOPPING: 'Shopping',
  DEMAND_GEN: 'Demand Gen',
  MULTI_CHANNEL: 'App',
  OTHER: 'Other',
}
// Google's status + serving status in the owner's words.
export function statusLabel(status, servingStatus) {
  if (status === 'REMOVED') return 'removed'
  if (status === 'PAUSED') return 'paused'
  if (status === 'ENABLED') return servingStatus === 'ENDED' ? 'ended' : servingStatus === 'PENDING' ? 'scheduled' : servingStatus && servingStatus !== 'SERVING' ? 'not serving' : 'running'
  return 'other'
}

const day = (ms) => new Date(ms).toISOString().slice(0, 10)
export const FULL_WINDOW_DAYS = 90 // first read: three months of history
export const SYNC_WINDOW_DAYS = 3 // later reads: Google restates recent days
export const MIN_SYNC_GAP_MS = 20 * 3600_000
export const RETRY_GAP_MS = 3600_000 // a failed read (Google unavailable, access expired) is tried again sooner

async function recordState(db, customerId, result, now) {
  await db
    .prepare('INSERT INTO ad_import_state (customer, platform, synced_at, result) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(customer) DO UPDATE SET synced_at = ?3, result = ?4')
    .bind(customerId, 'google', now, JSON.stringify(result))
    .run()
}

// Reads the connected account and brings our copy up to date. Idempotent: rows are keyed by (customer, platform,
// Google campaign id); a campaign Google no longer lists is marked REMOVED (never deleted); GetShowUps' own
// campaigns are skipped. Metrics: 90 days the first time a campaign is seen, otherwise the last 3 days (restated).
export async function syncImportedCampaigns(env, customerId, { now = Date.now(), full = false } = {}) {
  const db = env.ONBOARDING_DB
  if (!(await importsReady(db))) return { ok: false, error: 'not_ready' }
  const read = await readAccountCampaigns(env, customerId)
  if (!read.ok) {
    await recordState(db, customerId, { ok: false, error: read.error }, now).catch(() => {})
    return { ok: false, error: read.error }
  }
  const ours = new Set((await db.prepare("SELECT platform_campaign_id AS id FROM ad_campaigns WHERE customer = ?1 AND platform = 'google' AND platform_campaign_id IS NOT NULL").bind(customerId).all()).results.map((r) => String(r.id)))
  const existing = new Map((await db.prepare("SELECT id, external_id, status, synced_at, first_seen_at FROM ad_imported_campaigns WHERE customer = ?1 AND platform = 'google'").bind(customerId).all()).results.map((r) => [String(r.external_id), r]))
  const seen = new Set()
  const fresh = []
  let imported = 0
  let updated = 0
  for (const c of read.campaigns) {
    if (c.gsuId || ours.has(c.externalId)) continue // GetShowUps' own campaigns live in ad_campaigns
    seen.add(c.externalId)
    const { externalId, gsuId, name, status, servingStatus, channelType, dailyBudgetCents, ...settings } = c
    void gsuId
    const row = existing.get(externalId)
    const id = row?.id || randomToken(12)
    if (!row) fresh.push(id)
    await db
      .prepare(
        `INSERT INTO ad_imported_campaigns (id, customer, platform, external_id, name, channel_type, status, serving_status, daily_budget_cents, settings, first_seen_at, synced_at)
         VALUES (?1, ?2, 'google', ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)
         ON CONFLICT(customer, platform, external_id) DO UPDATE SET name = ?4, channel_type = ?5, status = ?6, serving_status = ?7, daily_budget_cents = ?8, settings = ?9, synced_at = ?10`,
      )
      .bind(id, customerId, externalId, name, channelType, status, servingStatus, dailyBudgetCents, JSON.stringify(settings), now)
      .run()
    if (row) updated++
    else imported++
  }
  // Gone from Google (removed there, or moved out of reach): keep the row, mark it, stop syncing its metrics.
  let removed = 0
  for (const [externalId, row] of existing) {
    if (seen.has(externalId) || row.status === 'REMOVED') continue
    await db.prepare("UPDATE ad_imported_campaigns SET status = 'REMOVED', synced_at = ?3 WHERE id = ?1 AND customer = ?2").bind(row.id, customerId, now).run()
    removed++
  }
  // Metrics: by Google campaign id, mapped back to our rows.
  const rows = (await db.prepare("SELECT id, external_id FROM ad_imported_campaigns WHERE customer = ?1 AND platform = 'google' AND status <> 'REMOVED'").bind(customerId).all()).results
  const byExternal = new Map(rows.map((r) => [String(r.external_id), r.id]))
  let metricsRows = 0
  let metricsError = null
  const windows = [
    { ids: rows.filter((r) => fresh.includes(r.id) || full).map((r) => r.external_id), days: FULL_WINDOW_DAYS },
    { ids: rows.filter((r) => !fresh.includes(r.id) && !full).map((r) => r.external_id), days: SYNC_WINDOW_DAYS },
  ].filter((w) => w.ids.length)
  for (const w of windows) {
    const m = await fetchAccountMetrics(env, customerId, w.ids, day(now - w.days * DAY), day(now))
    if (!m.ok) {
      metricsError = m.error
      continue
    }
    for (const r of m.rows) {
      const importedId = byExternal.get(r.externalId)
      if (!importedId) continue
      await db
        .prepare(
          `INSERT INTO ad_imported_metrics_daily (imported_id, customer, date, spend_cents, impressions, clicks, conversions, fetched_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
           ON CONFLICT(imported_id, date) DO UPDATE SET spend_cents = ?4, impressions = ?5, clicks = ?6, conversions = ?7, fetched_at = ?8`,
        )
        .bind(importedId, customerId, r.date, r.spendCents, r.impressions, r.clicks, r.conversions, now)
        .run()
      metricsRows++
    }
  }
  const result = { ok: true, campaigns: seen.size, imported, updated, removed, metricsRows, partial: read.partial === true, ...(metricsError ? { metricsError } : {}), testAccount: read.testAccount === true }
  await recordState(db, customerId, result, now)
  return result
}

// Cron: businesses with a chosen Google Ads account whose copy is older than MIN_SYNC_GAP_MS (never-read first; a
// failed read again after RETRY_GAP_MS). Bounded per run; one failing business never stops the others. Read-only.
export async function syncAllImported(env, { now = Date.now(), limit = 5 } = {}) {
  const db = env.ONBOARDING_DB
  if (!(await importsReady(db))) return { skipped: 'not_ready' }
  const due = await db
    .prepare(
      `SELECT c.customer FROM ad_connections c LEFT JOIN ad_import_state s ON s.customer = c.customer
        WHERE c.platform = 'google' AND c.status = 'connected' AND c.account_id IS NOT NULL
          AND (s.synced_at IS NULL OR s.synced_at < ?1 OR (json_extract(s.result, '$.ok') = 0 AND s.synced_at < ?2))
        ORDER BY s.synced_at IS NOT NULL, s.synced_at LIMIT ?3`,
    )
    .bind(now - MIN_SYNC_GAP_MS, now - RETRY_GAP_MS, limit)
    .all()
  const summary = { businesses: due.results.length, synced: 0, failed: 0 }
  for (const r of due.results) {
    const out = await syncImportedCampaigns(env, r.customer, { now }).catch(() => ({ ok: false, error: 'storage_error' }))
    if (out.ok) summary.synced++
    else summary.failed++
  }
  return summary
}

const parse = (s) => {
  try {
    return JSON.parse(s || '{}')
  } catch {
    return {}
  }
}

// What the Ads tab shows: each imported campaign with Google's settings snapshot and its totals for the period, the
// period totals, and when the copy was last read. Numbers are Google's own (spend, clicks, Google conversions);
// nothing here is a GetShowUps lead or booking.
export async function listImported(db, customerId, { days = 30, now = Date.now() } = {}) {
  if (!(await importsReady(db))) return { ready: false }
  const since = day(now - days * DAY)
  const [{ results: rows }, { results: totals }, state] = await Promise.all([
    db.prepare("SELECT * FROM ad_imported_campaigns WHERE customer = ?1 AND platform = 'google' ORDER BY (status = 'ENABLED') DESC, (status = 'PAUSED') DESC, name").bind(customerId).all(),
    db.prepare('SELECT imported_id, coalesce(sum(spend_cents),0) AS spend, coalesce(sum(clicks),0) AS clicks, coalesce(sum(impressions),0) AS impressions, coalesce(sum(conversions),0) AS conversions, count(*) AS days FROM ad_imported_metrics_daily WHERE customer = ?1 AND date >= ?2 GROUP BY imported_id').bind(customerId, since).all(),
    db.prepare('SELECT synced_at, result FROM ad_import_state WHERE customer = ?1').bind(customerId).first(),
  ])
  const byId = new Map(totals.map((t) => [t.imported_id, t]))
  const campaigns = rows.map((r) => {
    const t = byId.get(r.id)
    const settings = parse(r.settings)
    return {
      id: r.id,
      externalId: r.external_id,
      name: r.name,
      channelType: r.channel_type,
      channelLabel: CHANNEL_LABEL[r.channel_type] || CHANNEL_LABEL.OTHER,
      status: r.status,
      servingStatus: r.serving_status,
      state: statusLabel(r.status, r.serving_status),
      dailyBudgetCents: r.daily_budget_cents,
      sharedBudget: settings.sharedBudget === true,
      settings,
      metrics: t ? { spendCents: t.spend, clicks: t.clicks, impressions: t.impressions, conversions: Math.round(t.conversions * 100) / 100, days: t.days } : null,
      syncedAt: r.synced_at,
      firstSeenAt: r.first_seen_at,
    }
  })
  const live = campaigns.filter((c) => c.status !== 'REMOVED')
  const sum = (k) => live.reduce((n, c) => n + (c.metrics?.[k] ?? 0), 0)
  const measured = live.some((c) => c.metrics)
  const result = parse(state?.result)
  return {
    ready: true,
    days,
    syncedAt: state?.synced_at ?? null,
    lastResult: state ? { ok: result.ok !== false, error: result.error || null, partial: result.partial === true, metricsError: result.metricsError || null } : null,
    campaigns,
    totals: { campaigns: live.length, running: live.filter((c) => c.state === 'running').length, spendCents: measured ? sum('spendCents') : null, clicks: measured ? sum('clicks') : null, conversions: measured ? Math.round(sum('conversions') * 100) / 100 : null },
  }
}
