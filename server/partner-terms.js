// Versioned partner commission terms (migration 0048 partner_terms, append-only). Which version applies — decided
// 2026-11-27 with the founder-approved task:
//   A referred business earns under the version that was IN EFFECT WHEN IT WAS ATTRIBUTED to the partner (the deal the
//   partner referred it under), for its whole life. A later version applies to businesses attributed from its
//   effective date on; it never changes an existing referral. (A business an admin attached to the partner later, by an
//   audited correction, with no version in effect at its creation, uses the version in effect at the correction.)
//   Obligations already accrued are never recalculated: every ledger row keeps its rule snapshot and terms_version_id.
// A new version takes effect from a chosen date: default now; never before the previous version's effective date, and
// never before the partner's latest accrual (so no already-accrued business can fall under it).
const missing = (err) => String(err?.message || '').includes('no such table')

export async function termsVersions(db, partnerId) {
  try {
    const { results } = await db.prepare('SELECT id, version, terms, effective_from, created_by, created_at FROM partner_terms WHERE partner_id = ?1 ORDER BY version').bind(partnerId).all()
    return results.map((r) => ({ id: r.id, version: r.version, terms: JSON.parse(r.terms), effectiveFrom: r.effective_from, createdBy: r.created_by, createdAt: r.created_at }))
  } catch (err) {
    if (missing(err)) return []
    throw err
  }
}

// The version in effect at `at`: the highest version whose effective date has come (versions are in order).
export function versionAt(versions, at) {
  let hit = null
  for (const v of versions) if (v.effectiveFrom <= at) hit = v
  return hit
}

export async function termsAt(db, partnerId, at) {
  return versionAt(await termsVersions(db, partnerId), at)
}

// The version a referred business earns under (see the decision above).
export function versionForAttribution(versions, attribution) {
  return versionAt(versions, attribution.created_at) ?? (attribution.corrected_at ? versionAt(versions, attribution.corrected_at) : null)
}
