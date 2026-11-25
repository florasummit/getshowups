// Who "she", "him" or "that guy" is, from how the owner themselves referred to the people discussed. The records hold no
// gender and a name never decides it: only the owner's own words do. → the reference, or null when it can't be told.
const CUES = [/\b(he|hes|he['’]s|him|his|guy|man|gentleman|dude|mr)\b/i, /\b(she|shes|she['’]s|her|hers|lady|woman|gal|girl|mrs|ms|miss)\b/i]
const cue = (t) => {
  const hits = CUES.map((re) => re.test(t))
  return hits[0] === hits[1] ? null : hits[0] ? 0 : 1
}

// discussed: [{ ref, words, alone }] latest first; words = what the owner said in that turn, alone = the only person in it.
export function whoIsMeant(question, discussed) {
  const want = cue(question)
  if (want === null || !discussed.length) return null
  const called = discussed.map((d) => ({ ref: d.ref, cue: d.alone ? cue(d.words) : null }))
  const same = called.find((d) => d.cue === want)
  if (same) return same.ref
  // Someone the owner called otherwise is ruled out; that settles it only when it leaves one person.
  const left = called.filter((d) => d.cue === null)
  return left.length < called.length && left.length === 1 ? left[0].ref : null
}
