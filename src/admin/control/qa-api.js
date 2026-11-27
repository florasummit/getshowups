// QA Command Center: every request the QA screens make, in ONE place, so a change in the server's shapes is adjusted
// here only. Contract: scratchpad/qa/API_SAMPLES.json v1 (stream A). Routes /api/platform/qa/*, platform admins only;
// POSTs are same-origin and audited server-side. Money arrives in micro-dollars, times in UTC ms (or ISO).
// Each call resolves to { ok, status, data, error } and never throws; `error` is a plain sentence for the screen.
import { api } from '../../lib/api.js'

const BASE = '/api/platform/qa'
const q = (params = {}) => {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v != null && v !== '') p.set(k, String(v))
  const s = p.toString()
  return s ? `?${s}` : ''
}
const seg = (id) => encodeURIComponent(String(id))

// Refusal codes → what the admin reads. The server's own `text` wins when it sends one.
const REASONS = {
  ci_not_configured: 'Automated runs aren’t connected yet. The setup steps are listed on the QA overview.',
  not_runnable: 'This can’t run yet.',
  budget_entry: 'Paid checks have no QA budget yet. Set one in QA settings first.',
  already_running: 'The same selection is already running.',
  duplicate_results: 'Some of these tests already have a result on this release. Tick “Run them again anyway” to continue.',
  plan_changed: 'The plan changed since it was shown (a new release or new results). Review it again.',
  confirmation_required: 'Confirm to continue.',
  empty_scope: 'Nothing selected to run.',
  not_found: 'Not found. It may have been removed by retention.',
  not_available: 'The QA records aren’t set up in this environment yet.',
  invalid_status: 'That status isn’t allowed here.',
  purged: 'This evidence was removed by the retention policy.',
  forbidden: 'You aren’t allowed to do this.',
  storage_error: 'The QA records couldn’t be read or saved. Try again.',
  network_error: 'Couldn’t reach the server. Check your connection and try again.',
}
export const reasonText = (code, fallback = 'Something went wrong. Nothing was changed; try again.') => REASONS[code] || fallback

async function call(path, opts) {
  const { status, data } = await api(path, opts)
  const ok = status >= 200 && status < 300
  if (ok) return { ok, status, data, error: '' }
  if (status === 429) return { ok, status, data, error: 'Too many QA actions just now. Try again in a minute.' }
  if (status === 401) return { ok, status, data, error: 'Your session ended. Sign in again.' }
  return { ok, status, data, error: data?.text || REASONS[data?.reason] || reasonText(data?.error) }
}
const post = (path, body) => call(path, { method: 'POST', body })

// ---------- reads ----------
export const getOverview = () => call(`${BASE}/overview`)
// No filter → the tree stops at features (counts + testCount); area/q/status/class/detail → tests included.
export const getInventory = ({ area, q: text, status, cls, detail } = {}) => call(`${BASE}/inventory${q({ area, q: text, status, class: cls, detail: detail ? 'tests' : undefined })}`)
export const getTest = (id) => call(`${BASE}/tests/${seg(id)}`)
export const listExecutions = ({ environment, status, preset, from, to, commit, before } = {}) => call(`${BASE}/executions${q({ environment, status, preset, from, to, commit, before, limit: 50 })}`)
export const getExecution = (id) => call(`${BASE}/executions/${seg(id)}`)
export const listItems = ({ group, kind, status, area, severity, q: text } = {}) => call(`${BASE}/items${q({ group, kind, status, area, severity, q: text, limit: 100 })}`)
export const getItem = (id) => call(`${BASE}/items/${seg(id)}`)
export const getPrompt = (id) => call(`${BASE}/items/${seg(id)}/prompt`)
export const getSettings = () => call(`${BASE}/settings`)
// The existing Testing records (guided sessions + earlier CI runs): kept readable, never duplicated.
export const getLegacy = () => call('/api/platform/qa')

// ---------- writes ----------
// scope = { preset?, tests?, journeys?, areas?, features?, environment? } (combinations allowed). /plan has no side effects.
export const plan = (scope) => post(`${BASE}/plan`, scope)
export const startRun = (scope, { planId, rerun = false } = {}) => post(`${BASE}/run`, { ...scope, planId, ...(rerun ? { rerun: true } : {}), confirm: true })
export const cancelRun = (id) => post(`${BASE}/cancel`, { id, confirm: true })
export const recordResult = (body) => post(`${BASE}/result`, { ...body, confirm: true })
export const createItem = (fields) => post(`${BASE}/items`, { action: 'create', ...fields })
export const updateItem = (id, action, fields = {}) => post(`${BASE}/items`, { action, id, ...fields })
export const saveSetting = (key, value, reason) => post(`${BASE}/settings`, { key, value, reason, confirm: true })

// Evidence: a small screenshot (PNG/JPEG/WebP ≤ 1 MB, byte-sniffed again on the server) or text / an https link.
export const MAX_EVIDENCE_BYTES = 1024 * 1024
export const EVIDENCE_TYPES = ['image/png', 'image/jpeg', 'image/webp']
const readBase64 = (file) =>
  new Promise((resolve) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''))
    r.onerror = () => resolve(null)
    r.readAsDataURL(file)
  })
export async function uploadEvidence({ ownerKind, ownerId, file, text, url, kind }) {
  if (file) {
    if (!EVIDENCE_TYPES.includes(file.type)) return { ok: false, error: 'Use a PNG, JPEG or WebP screenshot.' }
    if (file.size > MAX_EVIDENCE_BYTES) return { ok: false, error: 'The file is too large (1 MB at most).' }
    const dataBase64 = await readBase64(file)
    if (!dataBase64) return { ok: false, error: 'Couldn’t read that file.' }
    return post(`${BASE}/evidence`, { ownerKind, ownerId, kind: 'screenshot', mime: file.type, dataBase64 })
  }
  return post(`${BASE}/evidence`, { ownerKind, ownerId, kind: kind || (url ? 'link' : 'log'), text: text || undefined, url: url || undefined })
}
export const evidenceSrc = (e) => e?.url || `${BASE}/evidence/${seg(e?.id)}`

// ---------- shape guards (tolerate missing fields; never invent values) ----------
export const arr = (v) => (Array.isArray(v) ? v : [])
const dollars = (micros) => (micros == null || !Number.isFinite(Number(micros)) ? null : Number(micros) / 1e6)
export const usdOf = (o, key = 'usdMicros') => dollars(o?.[key])
export const setupText = (m) => (typeof m === 'string' ? m : m?.text || m?.step || '')

export function normalizeOverview(d) {
  if (!d || typeof d !== 'object') return null
  const s = d.spend || null
  return {
    available: d.available !== false,
    production: d.production || null,
    latest: d.latest || null,
    counts: d.counts || {},
    byClass: d.byClass || null,
    blockers: arr(d.blockers),
    manual: d.manual || null,
    recommended: arr(d.recommended),
    history: arr(d.history),
    freshness: d.freshness || null,
    spend: s && { month: s.month, spent: dollars(s.spentMicros), reserved: dollars(s.reservedMicros), budget: dollars(s.budgetMicros), daily: dollars(s.dailyMicros), available: dollars(s.availableMicros), paidEnabled: !!s.paidEnabled },
    setup: { ciDispatch: false, ingest: false, paidEvals: false, productionChecks: false, ...(d.setup || {}), missing: arr(d.setup?.missing) },
    settings: d.settings || null,
  }
}

// Inventory (areas → journeys → features → tests) → generic nodes { id, key, kind, title, counts, children }.
// A feature whose tests weren't sent has children: null and testCount (load its area to see them).
export function normalizeInventory(d) {
  if (!d || typeof d !== 'object') return null
  const test = (t) => ({ ...t, kind: 'test', key: `t:${t.id}`, last: t.last || null })
  const feature = (f, a, j) => ({ id: f.id, key: `f:${a.id}/${j.id}/${f.id}`, kind: 'feature', title: f.name || f.title || f.id, counts: f.counts, testCount: f.testCount ?? (Array.isArray(f.tests) ? f.tests.length : null), children: Array.isArray(f.tests) ? f.tests.map(test) : null })
  const journey = (j, a) => ({
    id: j.id,
    key: `j:${a.id}/${j.id}`,
    kind: 'journey',
    title: j.title || j.id,
    // "Other …" groups are not real journeys (no id to run them by).
    runnable: !j.synthetic && j.id !== 'other',
    counts: j.counts,
    children: [...arr(j.features).map((f) => feature(f, a, j)), ...arr(j.tests).map(test)],
  })
  const areas = arr(d.areas).map((a) => ({ id: a.id, key: `a:${a.id}`, kind: 'area', title: a.title || a.id, counts: a.counts, children: [...arr(a.journeys).map((j) => journey(j, a)), ...arr(a.tests).map(test)] }))
  return {
    generatedAt: d.generatedAt || null,
    platform: d.platform || null,
    areas,
    unassigned: d.unassigned || null,
    gaps: arr(d.gaps),
    areaList: arr(d.areaList).length ? d.areaList : areas.map((a) => ({ id: a.id, title: a.title })),
  }
}

// Upload a report produced off-CI (an evaluation or a local run). Recorded as a local run with its costs; audited.
export const importReport = (report) => post(`${BASE}/import`, { report, confirm: true })
