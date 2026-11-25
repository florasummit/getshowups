// The only API a test session can reach: exact method + path. Anything else is refused (server/acceptance.js). Left out on
// purpose: every route that calls an outside service even when only read (calendar, Ads page, onboarding, website, voices),
// and everything about billing, connections, publishing, settings, messages, deletion, accounts and the platform.
import { json } from './google-oauth.js'
import { stillAllowed } from './acceptance-env.js'
import { resetFixture } from './acceptance-fixture.js'
import * as me from '../functions/api/dashboard/me.js'
import * as overview from '../functions/api/dashboard/overview.js'
import * as insights from '../functions/api/dashboard/insights.js'
import * as results from '../functions/api/dashboard/results.js'
import * as assist from '../functions/api/dashboard/assist.js'
import * as feedback from '../functions/api/dashboard/assist-feedback.js'
import * as proposal from '../functions/api/dashboard/proposal.js'

const get = (m) => ({ handler: m.onRequestGet })
// Writes are checked again at the moment they run, not only when the request arrived.
const post = (m) => ({ handler: async (ctx) => ((await stillAllowed(ctx.env)) ? m.onRequestPost(ctx) : json(403, { error: 'not_allowed' })) })
export const ROUTES = {
  'GET /api/dashboard/me': get(me),
  'GET /api/dashboard/overview': get(overview),
  'GET /api/dashboard/insights': get(insights),
  'GET /api/dashboard/results': get(results),
  'GET /api/dashboard/assist': get(assist),
  'POST /api/dashboard/assist': post(assist),
  'POST /api/dashboard/assist-feedback': post(feedback),
  'POST /api/dashboard/proposal': post(proposal),
  'POST /api/acceptance/fixture': { handler: resetFixture, fixture: true },
}
