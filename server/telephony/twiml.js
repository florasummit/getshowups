// The few TwiML verbs the phone line uses, built from fixed parts with every value escaped. Nothing a caller says or types
// is ever placed in TwiML except digits we checked. No <Record>, no `record` attribute: recording does not exist.
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
const attrs = (o) =>
  Object.entries(o)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => ` ${k}="${esc(v)}"`)
    .join('')

export const say = (text) => `<Say voice="Polly.Joanna">${esc(text)}</Say>`
export const hangup = () => '<Hangup/>'
export const pause = (s = 1) => `<Pause length="${Math.max(1, Math.min(5, Number(s) || 1))}"/>`
export const gather = ({ action, digits, timeout = 6, prompt }) => `<Gather${attrs({ input: 'dtmf', numDigits: digits, timeout, action, method: 'POST', actionOnEmptyResult: 'true' })}>${prompt ? say(prompt) : ''}</Gather>`
// Ring numbers at the same time (the first to accept takes it). `url` on each Number = the screening prompt.
export const dialNumbers = ({ numbers, timeout, action, screenUrl, callerId }) =>
  `<Dial${attrs({ timeout, action, method: 'POST', answerOnBridge: 'true', callerId })}>${numbers.map((n) => `<Number${attrs({ url: screenUrl, method: 'POST' })}>${esc(n)}</Number>`).join('')}</Dial>`
export const dialSip = ({ uri, action }) => `<Dial${attrs({ action, method: 'POST', answerOnBridge: 'true' })}><Sip>${esc(uri)}</Sip></Dial>`

export const twiml = (...parts) => new Response(`<?xml version="1.0" encoding="UTF-8"?><Response>${parts.join('')}</Response>`, { status: 200, headers: { 'Content-Type': 'text/xml', 'Cache-Control': 'no-store' } })
