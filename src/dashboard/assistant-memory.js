// The assistant's conversations, kept in THIS browser only (nothing on our servers: the privacy policy says so). Per business
// and sign-in. What is kept: the owner's questions and answers with references (R1), never customers' names or contact
// details from answers, prepared changes or record cards; names are read again from the records when a conversation is
// opened (POST assist restore). Cleared on sign-out; gone after 30 days; at most 10 conversations.
const KEY = 'gsu:assistant:v1:'
const MAX = { conversations: 10, entries: 30, age: 30 * 86_400_000 }
let owner = null
const store = () => {
  try {
    return window.localStorage
  } catch {
    return null
  }
}
// Who is signed in, as business:account. Another account's conversations on this browser (someone who didn't sign out) are
// deleted, not just hidden.
export const setMemoryOwner = (id) => {
  if (owner === (id || null)) return
  owner = id || null
  try {
    const s = store()
    for (const k of Object.keys(s || {})) if (k.startsWith('gsu:assistant:') && k !== KEY + owner) s.removeItem(k)
  } catch {
    // Storage blocked: nothing is kept.
  }
}
const fresh = (c, now) => c && typeof c.id === 'string' && Array.isArray(c.talk) && now - c.at < MAX.age
export function conversations(now = Date.now()) {
  if (!owner) return []
  try {
    const list = JSON.parse(store()?.getItem(KEY + owner) || '[]')
    return (Array.isArray(list) ? list : []).filter((c) => fresh(c, now)).sort((a, b) => b.at - a.at)
  } catch {
    return []
  }
}
const subs = new Set()
const write = (list) => {
  if (!owner) return
  queueMicrotask(() => subs.forEach((f) => f()))
  try {
    if (list.length) store()?.setItem(KEY + owner, JSON.stringify(list.slice(0, MAX.conversations)))
    else store()?.removeItem(KEY + owner)
  } catch {
    // Full or blocked storage: the conversation simply isn't kept.
  }
}
// For the list on screen: the stored text changes exactly when the list does.
export const subscribe = (f) => (subs.add(f), () => subs.delete(f))
export const snapshot = () => {
  try {
    return (owner && store()?.getItem(KEY + owner)) || ''
  } catch {
    return ''
  }
}
export const asTalk = (c, names) => c.talk.map((e) => ({ ...e, kept: true, answer: e.failed ? undefined : withNames(e.raw, names), error: e.failed ? 'Not answered at the time.' : undefined, raw: e.failed ? undefined : e.raw }))
// An answer is kept only in its reference form; one without it (a name could be in it) is kept as a note.
const slim = (e) => ({ id: e.id, q: e.q, raw: e.raw || (e.answer ? '(answered from the records)' : ''), about: e.about, ctx: e.ctx, days: e.days, ...(e.error ? { failed: true } : {}) })
export function keep(id, talk, refs, looked, now = Date.now()) {
  const done = talk.filter((e) => !e.busy && (e.answer || e.error || e.raw))
  if (!done.length) return
  const rest = conversations(now).filter((c) => c.id !== id)
  write([{ id, at: now, title: done[0].q.slice(0, 60), talk: done.slice(-MAX.entries).map(slim), refs: refs || {}, looked: looked || [] }, ...rest])
}
export const forget = (id) => write(conversations().filter((c) => c.id !== id))
export function forgetAll() {
  write([])
}
// Sign-out: every business's conversations in this browser.
export function clearMemory() {
  owner = null // an answer still on its way is not kept either
  try {
    const s = store()
    for (const k of Object.keys(s || {})) if (k.startsWith('gsu:assistant:')) s.removeItem(k)
  } catch {
    // Nothing is kept then.
  }
}
const REF = /\[([ALR]\d{1,3})\]/g
export const withNames = (raw, names) => String(raw || '').replace(/(?:([\p{L}'’-]+) )?\[([ALR]\d{1,3})\]/gu, (m, word, r) => {
  const name = names[r] || 'a customer'
  return word && !name.toLowerCase().split(' ').includes(word.toLowerCase()) ? `${word} ${name}` : name
})
export const hasRefs = (talk) => talk.some((e) => new RegExp(REF.source).test(e.raw || ''))
export const newId = () => `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
