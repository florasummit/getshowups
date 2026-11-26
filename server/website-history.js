// Draft checkpoints (Website Studio): recoverable copies of the owner's DRAFT on the server, so a bad edit, a lost tab or
// a regretted change can be undone across sessions (session undo/redo is in the browser; published versions are in
// website_versions). Stored in website_generations as { kind: 'checkpoint', reason, draft } (no new table: no
// migration), never served publicly, never counted as AI use (source 'template', cost 0).
//   - taken automatically: on a save when the newest checkpoint is older than EVERY_MS (a copy of the draft as it was
//     BEFORE that save, so every entry is a point the owner can go back to and the newest one never just repeats the
//     current draft), before a restore, on publish;
//   - bounded: the newest KEEP checkpoints per business are kept, older checkpoints are removed (copies only; the draft
//     and published versions are never touched). 2 minutes × 30 = the last hour of continuous editing (it was one copy
//     per 10 minutes: ten edits in five minutes left a single restore point, finding WEB-03);
//   - restore = the checkpoint becomes the draft (validated like a save; the current draft is checkpointed first).
import { validateContent, withoutMissingAssets } from './website.js'

export const KEEP = 30
export const EVERY_MS = 2 * 60 * 1000
const ID_RE = /^[a-f0-9]{32}$/
const newId = () => [...crypto.getRandomValues(new Uint8Array(16))].map((x) => x.toString(16).padStart(2, '0')).join('')

export async function saveCheckpoint(db, customerId, draft, reason, now = Date.now()) {
  if (!draft || typeof draft !== 'object') return null
  const id = newId()
  await db.batch([
    db.prepare("INSERT INTO website_generations (id, customer, content, source, model, cost_micros, created_at) VALUES (?1, ?2, ?3, 'template', NULL, 0, ?4)").bind(id, customerId, JSON.stringify({ kind: 'checkpoint', reason, draft }), now),
    db
      .prepare(
        `DELETE FROM website_generations WHERE customer = ?1 AND json_extract(content, '$.kind') = 'checkpoint' AND id NOT IN (
           SELECT id FROM website_generations WHERE customer = ?1 AND json_extract(content, '$.kind') = 'checkpoint' ORDER BY created_at DESC, id LIMIT ?2)`,
      )
      .bind(customerId, KEEP),
  ])
  return id
}

// On a save: a checkpoint of the draft as it was before this save (`previous`), at most every EVERY_MS, so an editing
// session leaves a trail of points to go back to. Nothing when the save changed nothing.
// Same content whatever the key order; keys that are null (a default the loader adds) don't count as a difference.
const canon = (v) => (Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().filter((k) => v[k] != null).map((k) => [k, canon(v[k])])) : v)
const same = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b))
export async function maybeCheckpoint(db, customerId, previous, saved = null, now = Date.now()) {
  if (!previous || (saved && same(previous, saved))) return null
  const last = await db.prepare("SELECT max(created_at) AS at FROM website_generations WHERE customer = ?1 AND json_extract(content, '$.kind') = 'checkpoint'").bind(customerId).first()
  if (last?.at && now - last.at < EVERY_MS) return null
  return saveCheckpoint(db, customerId, previous, 'autosave', now)
}

// One checkpoint's stored draft, for the owner's private "View" before restoring (never served publicly).
export async function checkpointDraft(db, customerId, id) {
  if (!ID_RE.test(String(id))) return null
  const row = await db.prepare("SELECT content FROM website_generations WHERE id = ?1 AND customer = ?2 AND json_extract(content, '$.kind') = 'checkpoint'").bind(id, customerId).first()
  return row ? JSON.parse(row.content).draft || null : null
}

export async function listCheckpoints(db, customerId) {
  const { results } = await db
    .prepare("SELECT id, created_at, json_extract(content, '$.reason') AS reason, json_array_length(content, '$.draft.site.pages') AS pages FROM website_generations WHERE customer = ?1 AND json_extract(content, '$.kind') = 'checkpoint' ORDER BY created_at DESC LIMIT ?2")
    .bind(customerId, KEEP)
    .all()
  return results.map((r) => ({ id: r.id, createdAt: r.created_at, reason: r.reason, pages: r.pages ?? 1 }))
}

// Returns { ok, content } (the restored draft, validated) or { ok: false, error }.
export async function restoreCheckpoint(db, customerId, id, { claims = [], assetIds = null, current = null, now = Date.now() } = {}) {
  if (!ID_RE.test(String(id))) return { ok: false, httpStatus: 400, error: 'invalid_request' }
  const row = await db.prepare("SELECT content FROM website_generations WHERE id = ?1 AND customer = ?2 AND json_extract(content, '$.kind') = 'checkpoint'").bind(id, customerId).first()
  if (!row) return { ok: false, httpStatus: 404, error: 'not_found' }
  const { draft: stored } = JSON.parse(row.content)
  // Images permanently deleted since the checkpoint was taken are left out (a restore brings back a logo or photo only
  // while its file still exists); everything else comes back as it was.
  const draft = assetIds ? withoutMissingAssets(stored, assetIds).content : stored
  const [errors, content] = validateContent(draft, claims, assetIds, { prior: current?.services || null })
  if (errors.length) return { ok: false, httpStatus: 409, error: 'checkpoint_invalid', fields: errors }
  if (current) await saveCheckpoint(db, customerId, current, 'before_restore', now)
  return { ok: true, content }
}
