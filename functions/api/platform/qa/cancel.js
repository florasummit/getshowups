// POST /api/platform/qa/cancel { id, confirm: true } — cancel an active execution (a running GitHub run is cancelled
// there too when its run id is known). Results already recorded are kept. Audited.
import { json } from '../../../../server/google-oauth.js'
import { audit } from '../../../../server/platform.js'
import { fail, qaPost } from '../../../../server/ops/qa-route.js'
import { cancelExecution } from '../../../../server/ops/qa-executions.js'

export const onRequestPost = qaPost(
  async ({ env, body, admin, actor }) => {
    if (body.confirm !== true) return json(400, { error: 'confirmation_required' })
    const r = await cancelExecution(env, String(body.id || ''), actor)
    if (r.error) return fail(r)
    await audit(env, admin.email, 'qa.execution_cancelled', null, { execution: r.execution.id, githubCancelled: r.githubCancelled })
    return json(200, { ok: true, execution: r.execution, githubCancelled: r.githubCancelled })
  },
  { rule: 'qaCenterRun' },
)
