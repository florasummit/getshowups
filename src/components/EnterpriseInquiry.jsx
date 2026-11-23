// Enterprise inquiry form (pricing → Contact sales). Posts to /api/enterprise/inquiry (functions/api/enterprise/
// inquiry.js): the server validates, refuses bots (trap field + a signed token fetched when the form opens; a reply
// faster than 3 s is refused) and stores the inquiry as a lead of the GetShowUps sales business. The page shows the
// server's answer as a sentence; nothing typed is kept in the page after a successful send.
import { useEffect, useId, useRef, useState } from 'react'
import { enterprise } from '../content/site.js'
import { track } from '../lib/analytics.js'

const MESSAGES = {
  invalid_organization: 'Please enter your organization’s name.',
  invalid_name: 'Please enter your name.',
  invalid_email: 'Please enter a valid email address.',
  invalid_type: 'Please choose the type of organization.',
  invalid_count: 'Please enter a whole number of businesses, or leave it empty.',
  invalid_goal: 'Tell us in a sentence what you want to accomplish.',
  expired: 'That took a moment. Please send again.',
  rate_limited: 'Too many requests from your connection. Please try again later.',
  unavailable: 'We couldn’t record your request right now. Please try again in a minute, or book a call below.',
}
const FIELD_FOR = { invalid_organization: 'organization', invalid_name: 'name', invalid_email: 'email', invalid_type: 'type', invalid_count: 'count', invalid_goal: 'goal' }

async function getToken() {
  try {
    const r = await fetch('/api/enterprise/inquiry', { headers: { Accept: 'application/json' } })
    if (r.ok) return { t: String((await r.json())?.t || ''), at: Date.now() }
  } catch {
    // The send retries it and reports the failure.
  }
  return { t: '', at: 0 }
}

export default function EnterpriseInquiry({ onClose }) {
  const id = useId()
  const token = useRef({ t: '', at: 0 })
  const [state, setState] = useState('idle') // idle | sending | sent | <error code>
  const firstField = useRef(null)
  useEffect(() => {
    let live = true
    getToken().then((t) => live && (token.current = t))
    firstField.current?.focus({ preventScroll: true })
    return () => {
      live = false
    }
  }, [])

  const submit = async (e) => {
    e.preventDefault()
    if (state === 'sending') return
    const form = e.currentTarget
    const data = Object.fromEntries(new FormData(form).entries())
    setState('sending')
    let outcome = 'error'
    try {
      if (!token.current.t) token.current = await getToken()
      // The server refuses a reply under 3 s after the token was made: a fast (autofilled) person just waits it out.
      const early = token.current.at + 3300 - Date.now()
      if (early > 0) await new Promise((done) => setTimeout(done, early))
      const t = token.current.t
      const r = await fetch('/api/enterprise/inquiry', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ ...data, t }) })
      const body = await r.json().catch(() => ({}))
      if (r.ok && body?.ok) {
        outcome = 'sent'
        setState('sent')
        form.reset()
      } else {
        const code = r.status === 429 ? 'rate_limited' : String(body?.error || 'unavailable')
        outcome = code === 'rate_limited' || code === 'unavailable' ? code : 'error'
        setState(MESSAGES[code] ? code : 'unavailable')
        if (code === 'expired') token.current = await getToken()
        if (FIELD_FOR[code]) form.elements[FIELD_FOR[code]]?.focus()
      }
    } catch {
      outcome = 'unavailable'
      setState('unavailable')
    }
    track('enterprise_inquiry', { outcome })
  }

  const error = MESSAGES[state]
  return (
    <div className="enq" data-enterprise-form data-enterprise-state={state}>
      <div className="enq-head">
        <div>
          <p className="price-list-title">Enterprise inquiry</p>
          <h3 className="enq-title">Tell us about your organization</h3>
          <p className="enq-sub">We reply by email to set up a call. Nothing is charged.</p>
        </div>
        <button type="button" className="btn btn-line btn-sm" onClick={onClose} data-enterprise-close>
          Close
        </button>
      </div>
      {state === 'sent' ? (
        <p className="enq-status enq-status--ok" role="status">
          Thanks. Your inquiry is recorded and we’ll reply by email.
        </p>
      ) : (
        <form className="enq-form" onSubmit={submit} noValidate>
          <div className="enq-field">
            <label htmlFor={`${id}-org`}>Organization name</label>
            <input ref={firstField} id={`${id}-org`} name="organization" autoComplete="organization" maxLength={120} required />
          </div>
          <div className="enq-field">
            <label htmlFor={`${id}-type`}>Type of organization</label>
            <select id={`${id}-type`} name="type" defaultValue="" required>
              <option value="" disabled>
                Choose one
              </option>
              {enterprise.types.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </div>
          <div className="enq-field">
            <label htmlFor={`${id}-name`}>Your name</label>
            <input id={`${id}-name`} name="name" autoComplete="name" maxLength={80} required />
          </div>
          <div className="enq-field">
            <label htmlFor={`${id}-email`}>Work email</label>
            <input id={`${id}-email`} name="email" type="email" inputMode="email" autoComplete="email" maxLength={254} required />
          </div>
          <div className="enq-field enq-field--wide">
            <label htmlFor={`${id}-count`}>
              Approximate number of businesses or locations
            </label>
            <input id={`${id}-count`} name="count" inputMode="numeric" pattern="[0-9]*" maxLength={6} placeholder="e.g. 25" />
          </div>
          <div className="enq-field enq-field--wide">
            <label htmlFor={`${id}-goal`}>What do you want to accomplish?</label>
            <textarea id={`${id}-goal`} name="goal" rows={3} maxLength={300} required />
          </div>
          {/* Trap field: people never see it; a filled value is refused silently. */}
          <div className="enq-trap" aria-hidden="true">
            <label>
              Website
              <input name="website" tabIndex={-1} autoComplete="off" />
            </label>
          </div>
          {error && (
            <p className="enq-status enq-status--err enq-field--wide" role="alert">
              {error}
            </p>
          )}
          <div className="enq-actions enq-field--wide">
            <button type="submit" className="btn btn-ink btn-lg" disabled={state === 'sending'} data-enterprise-send>
              {state === 'sending' ? 'Sending…' : 'Send inquiry'}
            </button>
            <p className="enq-fine">Your details go only to the GetShowUps founding team.</p>
          </div>
        </form>
      )}
    </div>
  )
}
