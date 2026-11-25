// POST (Authorization: Bearer): a one-hour test session for an approved grant (server/acceptance.js). 404 while switched off.
import { startSession } from '../../../server/acceptance.js'
export const onRequestPost = ({ request, env }) => startSession(request, env)
