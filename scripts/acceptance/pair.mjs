// Pairs this Mac with one test business: prints a code a platform admin enters in Admin → Acceptance testing (10 minutes, one
// use). Renewing is the same thing again. No Google sign-in, no password.
import { newSecret, readSecret, SITE } from './grant.mjs'

const secretHash = newSecret()
const r = await fetch(`${SITE}/api/acceptance/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: SITE }, body: JSON.stringify({ secretHash }) })
if (!r.ok) {
  console.log(r.status === 404 ? 'Test sessions are switched off.' : `Pairing refused (${r.status}).`)
  process.exit(1)
}
const { code, expiresAt } = await r.json()
console.log(`Code: ${code}  (until ${new Date(expiresAt).toLocaleTimeString()}; works once)`)
console.log(`Enter it at ${SITE}/admin under Acceptance testing.`)
while (Date.now() < expiresAt) {
  await new Promise((ok) => setTimeout(ok, 10_000))
  const s = await fetch(`${SITE}/api/acceptance/session`, { method: 'POST', headers: { Authorization: `Bearer ${readSecret()}`, Origin: SITE } })
  if (s.ok && s.status === 200) {
    console.log(`Paired with ${(await s.json()).customer}.`)
    process.exit(0)
  }
}
console.log('The code ran out without approval.')
process.exit(1)
