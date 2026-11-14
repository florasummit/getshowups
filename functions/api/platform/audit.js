// GET /api/platform/audit[?customer=…&before=<seq>] — the permanent audit log (newest first) with a live chain check.
// GET /api/platform/audit?format=export — the whole log as a JSON download, for offline archiving (each entry keeps
// its hash, so the copy can be verified independently). Platform admins only; read-only; no personal data in it.
import { json } from '../../../server/google-oauth.js'
import { requirePlatformAdmin } from '../../../server/platform.js'
import { CUSTOMER_RE } from '../../../server/invites.js'
import { listAudit, verifyAuditChain } from '../../../server/auditlog.js'

export async function onRequestGet({ request, env }) {
  const { response } = await requirePlatformAdmin(request, env)
  if (response) return response
  const url = new URL(request.url)
  const customer = url.searchParams.get('customer') ? String(url.searchParams.get('customer')).toLowerCase() : null
  if (customer && !CUSTOMER_RE.test(customer)) return json(400, { error: 'invalid_customer' })
  const before = url.searchParams.get('before') ? Number(url.searchParams.get('before')) : null
  if (before !== null && !(Number.isInteger(before) && before > 0)) return json(400, { error: 'invalid_request' })
  const db = env.ONBOARDING_DB
  try {
    if (url.searchParams.get('format') === 'export') {
      const entries = []
      let cursor = null
      for (;;) {
        const page = await listAudit(db, { beforeSeq: cursor, limit: 500 })
        if (!page.length) break
        entries.push(...page)
        cursor = page.at(-1).seq
        if (entries.length >= 100000) break
      }
      entries.reverse()
      const chain = await verifyAuditChain(db)
      const body = JSON.stringify({ exportedAt: new Date().toISOString(), chain, entries })
      return new Response(body, {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Content-Disposition': `attachment; filename="getshowups-audit-${new Date().toISOString().slice(0, 10)}.json"`, 'Cache-Control': 'no-store' },
      })
    }
    const [entries, chain] = await Promise.all([listAudit(db, { customer, beforeSeq: before, limit: 50 }), verifyAuditChain(db)])
    return json(200, { chain, entries })
  } catch (err) {
    console.error('audit read failed:', err?.message?.includes('no such table') ? 'table_missing' : 'storage_error')
    return json(503, { error: err?.message?.includes('no such table') ? 'not_ready' : 'storage_error' })
  }
}
