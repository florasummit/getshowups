// Who "she" or "him" is, from how the owner themselves referred to the people discussed ("that guy", "the lady", "she"). The
// records hold no gender and a name never decides it. → { ref, sure } or null. Not sure = the only other person discussed.
const PRONOUN = [/\b(he|hes|he['’]s|him|his)\b/i, /\b(she|shes|she['’]s|her|hers)\b/i]
const CALLED = [/\b(?:he|hes|he['’]s|him|his)\b|\b(?:that|the|this)\s+(?:other\s+)?(?:guy|man|gentleman|dude)\b/i, /\b(?:she|shes|she['’]s|her|hers)\b|\b(?:that|the|this)\s+(?:other\s+)?(?:lady|woman|gal|girl)\b/i]
const NAMED = [/\b(?:that|the|this)\s+(?:other\s+)?(?:guy|man|gentleman|dude)\b/i, /\b(?:that|the|this)\s+(?:other\s+)?(?:lady|woman|gal|girl)\b/i]
// "the one after him": the pronoun is about someone other than the answer's person.
const ASIDE = /\b(after|before|behind|ahead of|below|above|under|over|besides|beside|than|except|instead of|not|near|next to|like|with|without)\s+(him|her|that guy|that lady|the guy|the lady)\b/i
const which = (res, t) => {
  const hits = res.map((re) => re.test(t))
  return hits[0] === hits[1] ? null : hits[0] ? 0 : 1
}

// turns, latest first: [{ words: what the owner said, people: [{ ref, person }] in the answer }]; person = the same customer
// under several references. A question that introduces someone ("the new lady") is not about anyone discussed.
export function whoIsMeant(question, turns) {
  const want = which(PRONOUN, question)
  if (want === null || which(CALLED, question) === null || /\[|\d{5}|\b(first|second|third|fourth|last|next|top|bottom|other) (one|person|customer)\b|\b\b(new|another|a)\s+(guy|man|lady|woman|gal|girl|customer|person)\b/i.test(question)) return null
  const seen = new Map() // person → { ref, cue }, latest reference, newest unambiguous cue
  turns.forEach((t, i) => {
    const only = new Set(t.people.map((p) => p.person)).size === 1
    for (const p of t.people) {
      const known = seen.get(p.person) || { ref: p.ref, cue: null }
      // A bare "him" about someone else (the person of the turn before) says nothing about the person in this answer.
      const about = which(CALLED, t.words)
      const pronounOnly = about !== null && which(NAMED, t.words) === null
      const prev = turns[i + 1]?.people.map((x) => x.person) || []
      if (known.cue === null && only && !ASIDE.test(t.words) && !(pronounOnly && prev.length && !prev.includes(p.person))) known.cue = about
      seen.set(p.person, known)
    }
  })
  const all = [...seen.values()] // most recently discussed first
  const same = all.findIndex((x) => x.cue === want)
  // Someone never called anything, discussed more recently, could be meant as well: then it isn't known.
  if (same >= 0) return all.slice(0, same).some((x) => x.cue === null) ? null : { ref: all[same].ref, sure: true }
  const left = all.filter((x) => x.cue === null)
  return all.length === 2 && left.length === 1 ? { ref: left[0].ref, sure: false } : null
}
