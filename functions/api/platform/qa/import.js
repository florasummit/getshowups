// POST /api/platform/qa/import { report, confirm: true } — a platform admin uploads a report produced off-CI (e.g.
// scripts/admin-assistant-eval.mjs --qa-json, or a local Playwright/unit report from scripts/qa-report.mjs --out): the
// same validation, redaction and bounds as the CI ingest, stored as environment 'local' with its recorded costs.
// Audited.
import { json, sha256Hex } from '../../../../server/google-oauth.js'
import { audit } from '../../../../server/platform.js'
import { fail, qaPost } from '../../../../server/ops/qa-route.js'
import { ingestReport } from '../../../../server/ops/qa-ingest.js'
import { qaReady } from '../../../../server/ops/qa.js'

export const onRequestPost = qaPost(
  async ({ env, body, admin, actor }) => {
    if (body.confirm !== true) return json(400, { error: 'confirmation_required' })
    if (!body.report || typeof body.report !== 'object') return json(400, { error: 'invalid_request' })
    if (!(await qaReady(env.ONBOARDING_DB))) return json(503, { error: 'not_available' })
    const report = { ...body.report }
    delete report.executionId // an upload never completes a dispatched execution
    delete report.event
    const r = await ingestReport(env, report, Date.now(), { bodyHash: await sha256Hex(JSON.stringify(report)), forceSource: 'local', actor })
    if (r.error) return fail(r)
    await audit(env, admin.email, 'qa.report_imported', null, { run: r.id, execution: r.executionId ?? null, duplicate: Boolean(r.duplicate), stored: r.qa?.stored ?? 0, costMicros: r.qa?.costMicros ?? 0 })
    return json(r.duplicate ? 200 : 201, { executionId: r.executionId ?? null, run: { id: r.id, status: r.status, counts: r.counts, duplicate: Boolean(r.duplicate), stored: r.qa?.stored ?? 0, unmatched: r.qa?.unmatched ?? 0, costMicros: r.qa?.costMicros ?? 0 } })
  },
  { maxBytes: 2_000_000 },
)
