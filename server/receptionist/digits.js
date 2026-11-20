// Spoken digits → digits ("two nine four zero three" / "double five"), so numbers a caller says match what they mean.
// Shared by the receptionist engine (detail checks) and the intelligence engine (understanding what was said).
const WORD_DIGIT = { zero: '0', oh: '0', o: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9' }
export function spokenToDigits(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/\b(double|triple)\s+(zero|oh|one|two|three|four|five|six|seven|eight|nine|\d)\b/g, (_, n, d) => (WORD_DIGIT[d] || d).repeat(n === 'double' ? 2 : 3))
    .replace(/\b(zero|oh|one|two|three|four|five|six|seven|eight|nine)\b/g, (w) => WORD_DIGIT[w])
}
