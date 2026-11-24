// The life of prepared changes (nothing here saves anything): each has its own id; a newer one for the same thing replaces
// the older; withdrawing names ids. Approving, refusing stale and repeated approvals: server/proposals.js.
import { randomToken } from './google-oauth.js'

export const PROPOSAL_ID = /^p_[A-Za-z0-9_-]{8,24}$/
export const newProposalId = () => `p_${randomToken(9)}`
const subject = (p) => `${p.type}:${p.ref || ''}`

// Adds a prepared change. pending: what the owner still sees waiting. → the proposal with its id.
export function addProposal(c, p) {
  const id = newProposalId()
  for (const x of [...c.pending, ...c.proposals.map((y) => ({ id: y.pid, type: y.type, ref: y.ref }))]) if (subject(x) === subject(p)) c.withdrawn.add(x.id)
  c.proposals = c.proposals.filter((x) => subject(x) !== subject(p))
  c.proposals.push({ ...p, pid: id })
  return id
}

// → { ids } | { error, … }. One waiting change needs no name; several need one, so nothing unrelated is ever withdrawn.
export function withdrawProposals(c, { which, all }) {
  const open = [...c.pending.filter((x) => !c.withdrawn.has(x.id)), ...c.proposals.map((x) => ({ id: x.pid, type: x.type, ref: x.ref }))]
  if (!open.length) return { error: 'nothing_waiting', note: 'Nothing prepared is waiting, so nothing was withdrawn.' }
  let hit = []
  if (all === true) hit = open
  else if (which) {
    const ref = String(which).replace(/[[\]]/g, '').toUpperCase()
    const n = /^P(\d{1,2})$/.exec(ref)
    hit = n ? [c.pending[Number(n[1]) - 1]].filter((x) => x && open.includes(x)) : open.filter((x) => x.ref === ref)
  } else if (open.length === 1) hit = open
  else return { error: 'which_one', waiting: open.length, note: 'Several are waiting. Use which (P1, P2… as listed; the last one listed is the newest, which is what "that" means right after preparing it), or all only if they said everything.' }
  if (!hit.length) return { error: 'not_waiting', note: 'That one is not waiting. Nothing was withdrawn.' }
  for (const x of hit) c.withdrawn.add(x.id)
  c.proposals = c.proposals.filter((x) => !c.withdrawn.has(x.pid))
  return { withdrawn: hit.length, still_waiting: open.length - hit.length, note: 'Nothing was changed.' }
}
