// POST { secretHash }: the acceptance runner asks for a pairing code (server/acceptance.js). 404 while switched off.
import { startPairing } from '../../../server/acceptance.js'
export const onRequestPost = ({ request, env }) => startPairing(request, env)
