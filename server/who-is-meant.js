// Who "she" or "him" is, from how the owner themselves referred to the people discussed ("that guy", "the lady", "she"). The
// records hold no gender and a name never decides it. → { ref, sure } or null. Not sure = the only other person discussed.
const PRONOUN = [/\b(he|hes|he['’]s|him|his)\b/i, /\b(she|shes|she['’]s|her|hers)\b/i]
const CALLED = [/\b(?:he|hes|he['’]s|him|his)\b|\b(?:that|the|this)\s+(?:other\s+)?(?:guy|man|gentleman|dude)\b/i, /\b(?:she|shes|she['’]s|her|hers)\b|\b(?:that|the|this)\s+(?:other\s+)?(?:lady|woman|gal|girl)\b/i]
// "the one after him": the pronoun is about someone other than the answer's person.
const ASIDE = /\b(after|before|besides|than|except|instead of|not)\s+(him|her|that guy|that lady)\b/i
const which = (res, t) => {
  const hits = res.map((re) => re.test(t))
  return hits[0] === hits[1] ? null : hits[0] ? 0 : 1
}

// turns, latest first: [{ words: what the owner said, people: [{ ref, person }] in the answer }]; person = the same customer
// under several references. A question that introduces someone ("the new lady") is not about anyone discussed.
export function whoIsMeant(question, turns) {
  const want = which(PRONOUN, question)
  if (want === null || which(CALLED, question) === null || /\b(new|another|a)\s+(guy|man|lady|woman|gal|girl|customer|person)\b/i.test(question)) return null
  const seen = new Map() // person → { ref, cue }, latest reference, newest unambiguous cue
  for (const t of turns) {
    const only = new Set(t.people.map((p) => p.person)).size === 1
    for (const p of t.people) {
      const known = seen.get(p.person) || { ref: p.ref, cue: null }
      if (known.cue === null && only && !ASIDE.test(t.words)) known.cue = which(CALLED, t.words)
      seen.set(p.person, known)
    }
  }
  const all = [...seen.values()]
  const same = all.find((x) => x.cue === want)
  if (same) return { ref: same.ref, sure: true }
  const left = all.filter((x) => x.cue === null)
  return all.length === 2 && left.length === 1 ? { ref: left[0].ref, sure: false } : null
}
