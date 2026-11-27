// POST /api/platform/qa/plan { preset? | tests? | journeys? | areas? | features?, environment?, includePaid? } — what a
// run would do: scope, environment, estimate, prerequisites, approvals, duplicate notice. No side effects (POST only
// because the selection can be long).
import { json } from '../../../../server/google-oauth.js'
import { qaPost } from '../../../../server/ops/qa-route.js'
import { makePlan, publicPlan } from '../../../../server/ops/qa-plan.js'

export const onRequestPost = qaPost(async ({ env, body }) => json(200, publicPlan(await makePlan(env, body))), { maxBytes: 200_000 })
