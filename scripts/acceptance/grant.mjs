// The runner's side of test sessions (server/acceptance.js). The secret is made here, stays in this Mac's Keychain, and is
// only ever sent as a header to our own site; its hash is what pairing shows the server. Never printed, never in argv.
import { execFileSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'

export const SITE = 'https://getshowups.com'
const ITEM = 'getshowups-acceptance-secret'
const keychain = (line) => execFileSync('security', ['-i'], { input: `${line}\n`, stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf8' })
export function readSecret() {
  try {
    return execFileSync('security', ['find-generic-password', '-a', 'acceptance', '-s', ITEM, '-w'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null
  } catch {
    return null
  }
}
export function newSecret() {
  const secret = randomBytes(32).toString('base64url')
  keychain(`add-generic-password -U -a acceptance -s ${ITEM} -w ${secret}`)
  if (readSecret() !== secret) throw new Error('The Keychain did not keep the secret.')
  return createHash('sha256').update(secret).digest('hex')
}
// Puts the test session cookie into a browser context. → { customer } | { pending } | { refused }
export async function openSession(ctx) {
  const secret = readSecret()
  if (!secret) return { refused: 'not paired' }
  const r = await ctx.request.post(`${SITE}/api/acceptance/session`, { headers: { Authorization: `Bearer ${secret}`, Origin: SITE } })
  if (r.status() === 202) return { pending: true }
  return r.ok() ? r.json() : { refused: r.status() }
}
