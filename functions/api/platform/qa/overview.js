// GET /api/platform/qa/overview — QA Command Center overview (platform admins): production version, latest execution,
// per-test status counts (with totals), blockers, manual progress, recommended next runs, release + QA history, QA
// spend and the setup checklist. Read-only.
import { json } from '../../../../server/google-oauth.js'
import { qaGet } from '../../../../server/ops/qa-route.js'
import { overview } from '../../../../server/ops/qa-overview.js'

export const onRequestGet = qaGet(async ({ env }) => json(200, await overview(env)))
