// What an answer says about a person, checked against that person's record (software, not instructions). Each rule is
// deliberately narrow: it speaks only when one sentence names exactly one person and states something the record decides.
// facts: Map ref → { kind: 'appointment'|'inquiry'|'callback'|'message', at, urgent?, confirmed?, sender?, sentAt?, lead?, waiting? }
const REF = /\[([ALR]\d{1,3})\]/g
const NEG = /\b(not|never|no|isn['’]?t|aren['’]?t|wasn['’]?t|hasn['’]?t|haven['’]?t|doesn['’]?t|didn['’]?t|nobody|none|without|yet to|un\w+)\b/i
const DAY = 86_400_000
const dayOf = (t, tz) => Math.round(Date.parse(`${new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(t)}T12:00:00Z`) / DAY)
const mondayOf = (d) => d - ((new Date(d * DAY).getUTCDay() + 6) % 7)

// → null | what is wrong, in words the model can act on
export function claimProblem(text, facts, { now, tz }) {
  for (const x of text.split(/(?<=[.!?])\s+|\n/)) {
    const refs = [...new Set([...x.matchAll(REF)].map((m) => m[1]))].filter((r) => facts.has(r))
    // About one or several people alike.
    const person = refs.find((r) => ['inquiry', 'callback', 'message'].includes(facts.get(r).kind))
    if (person && /\b(not|isn['’]?t|never) (a )?(real|genuine|serious)\b|\b(fake|spam|a hoax)\b|\bI['’]d (leave|ignore|skip) (it|them)\b/i.test(x)) return `About [${person}]: do not decide that a customer or request isn't real or should be ignored. Say what they asked for and that part of the text looks odd.`
    const sent = refs.find((r) => facts.get(r).sentAt)
    if (sent && /\b(nothing|no (message|reply|follow-up)s?)( \w+){0,3} (been sent|gone out|went out|sent)\b|\bnot been (messaged|contacted)\b/i.test(x) && !/\b(since|after|else|from you|by you|other than|except|draft\w*|prepared|note)\b/i.test(x)) return `About [${sent}]: a message is recorded as sent. Say what the record shows.`
    const auto = refs.find((r) => facts.get(r).sentAt && !['auto', 'ai', 'system'].includes(facts.get(r).sender))
    if (auto && /\bautomatic(ally)?\b/i.test(x) && /\b(messages?|sent|went|got|received)\b/i.test(x) && !/\b(not|whether|or an automatic)\b/i.test(x)) return `About [${auto}]: ${facts.get(auto).sender === 'owner' ? 'the owner sent the last message' : 'who sent the last message is not recorded'}, so it was not shown to be automatic. Say what the record shows.`
    const note = refs.find((r) => facts.get(r).kind === 'message' && !facts.get(r).lead)
    const other = note && refs.find((r) => facts.get(r).kind === 'appointment')
    if (other && /\b(affects?|matters? (for|to)|before|applies|about|for)\b/i.test(x)) return `About [${note}]: the note names no visit or person, so do not connect it with [${other}], not even as a guess.`
    if (refs.length !== 1) continue
    const ref = refs[0]
    const f = facts.get(ref)
    const neg = NEG.test(x)
    const bad = (why) => `About [${ref}]: ${why} Say what the record shows.`
    if (/\burgent(ly)?\b/i.test(x) && f.urgent === false && !neg && !/\b(less|more|than|if|whether|most urgent)\b/i.test(x) && ['callback', 'message'].includes(f.kind)) return bad('it is not marked urgent.')
    if (f.kind === 'message' && !neg && /\b(asked for|wants|waiting for|expects|requested) (a |your )?(phone )?call/i.test(x)) return bad('they left a message; they did not ask for a call back.')
    if (f.kind === 'callback' && !neg && /\b(waiting for|expects|wants) (a |your )?(written )?reply\b/i.test(x)) return bad('they asked for a phone call, not a written reply.')
    if (f.kind === 'appointment' && f.confirmed === false && !neg && /\b(customer|they|has|have|is)( \w+)? confirmed\b/i.test(x) && !/\b(once|until|whether|if|ask)\b/i.test(x)) return bad('the customer has not confirmed.')
    if (f.at && /\byesterday\b/i.test(x) && !/\b(since|until)\b/i.test(x) && dayOf(f.at, tz) !== dayOf(now, tz) - 1) return bad('its date is not yesterday.')
    if (f.at && /\blast week\b/i.test(x) && mondayOf(dayOf(f.at, tz)) !== mondayOf(dayOf(now, tz)) - 7) return bad('its date is not in last week.')
    if (f.waiting && !neg && /\b(longest|oldest)\b/i.test(x) && !/\bsecond|next\b/i.test(x)) {
      const all = /\b(of all|anyone|everyone|overall|any item|oldest item)\b/i.test(x)
      const rival = [...facts].find(([r, o]) => r !== ref && o.waiting && o.at < f.at && (all || o.kind === f.kind || ['callback', 'message'].includes(o.kind) === ['callback', 'message'].includes(f.kind)))
      if (rival) return bad(`[${rival[0]}] has waited longer.`)
    }
  }
  return null
}
