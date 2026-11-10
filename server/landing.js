// Owner-approved claims for customer-facing text (websites, ads). The old single-template landing
// page now lives on as the website engine (server/website.js); a business's published landing page
// (landing_pages) is shown as its website until the owner first saves the new editor.
async function adProfile(db, customerId) {
  const r = await db.prepare('SELECT approved_claims FROM ad_profiles WHERE customer = ?1').bind(customerId).first()
  return r ? { claims: JSON.parse(r.approved_claims || '[]') } : null
}

export async function approvedClaimsFor(db, customerId) {
  return (await adProfile(db, customerId))?.claims || []
}
