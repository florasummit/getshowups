// Launch checklist: an honest status for everything the business depends on. Used at the end of
// onboarding and as the "next step" card on the dashboard.
import { useEffect, useState } from 'react'
import { api } from '../lib/api.js'

const TEXT = {
  subscription: {
    label: 'Founding plan',
    active: 'Active',
    cancel_scheduled: 'Cancels at the end of this billing period',
    past_due: 'Payment failed. Update your card in billing.',
    canceled: 'Ended. Reactivate in billing.',
    incomplete: 'Payment not completed',
    not_started: 'Not started',
  },
  calendar: { label: 'Google Calendar', healthy: 'Connected', default: 'Needs reconnecting' },
  hours: { label: 'Booking hours', ok: 'Set', action: 'Not set' },
  page: { label: 'Landing page', published: 'Published', draft: 'Draft (private). Publish it in Settings.', none: 'Not created' },
  booking: { label: 'Bookings', has_bookings: 'Receiving bookings', no_bookings_yet: 'No bookings yet. Share your page to get your first one.' },
  email: { label: 'Email confirmations & reminders', live: 'On', activating: 'Activating soon. We’ll tell you when they start sending.' },
  sms: { label: 'Text messages', not_available_yet: 'Not available yet' },
  ads: { label: 'Google & Meta ads', not_available_yet: 'Not available yet', connect_in_ads: 'Connect in Ads' },
}
const ICON = { ok: '✓', action: '!', pending: '…', off: '–' }

function describe(item) {
  const t = TEXT[item.id] || {}
  return { label: t.label || item.id, text: t[item.detail] ?? t[item.state] ?? t.default ?? '' }
}

export default function Readiness({ onLoad, compact = false }) {
  const [data, setData] = useState(null)
  useEffect(() => {
    api('/api/dashboard/onboarding').then(({ status, data: d }) => {
      const r = status === 200 ? d.readiness : null
      setData(r || { failed: true })
      onLoad?.(r)
    })
  }, [onLoad])
  if (!data) return <p className="fine">Checking your setup…</p>
  if (data.failed) return <p className="fine">Couldn’t check your setup right now.</p>
  const items = compact ? data.items.filter((i) => i.state !== 'off') : data.items
  return (
    <ul className="checklist">
      {items.map((item) => {
        const { label, text } = describe(item)
        return (
          <li key={item.id} className={`checklist-item checklist-item--${item.state}`}>
            <span className="checklist-icon" aria-hidden="true">
              {ICON[item.state]}
            </span>
            <span>
              <strong>{label}</strong>
              <span className="fine"> {text}</span>
            </span>
          </li>
        )
      })}
    </ul>
  )
}

// Dashboard card: the single most useful next action, with the full status one tap away.
const NEXT = {
  subscription: ['Fix your plan', 'billing'],
  calendar: ['Reconnect Google Calendar', 'settings'],
  hours: ['Set your booking hours', 'settings'],
  page: ['Publish your landing page', 'settings'],
  share: ['Share your booking link to get your first booking', null],
}
export function NextStep({ onOpen }) {
  const [r, setR] = useState(null)
  const [open, setOpen] = useState(false)
  if (r && !r.next) return null
  const next = r ? NEXT[r.next] : null
  return (
    <section className="card next-step" aria-label="Next step">
      <p className="eyebrow-sm">Next step</p>
      {next ? <p className="next-step-title">{next[0]}</p> : <p className="fine">Checking your setup…</p>}
      <div className="card-actions">
        {next?.[1] && (
          <button type="button" className="btn btn-primary btn-sm" onClick={() => onOpen(next[1])}>
            {next[1] === 'billing' ? 'Fix billing' : 'Fix this'}
          </button>
        )}
        <button type="button" className="link-btn" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? 'Hide setup status' : 'Setup status'}
        </button>
      </div>
      <div hidden={!open}>
        <Readiness onLoad={setR} />
      </div>
    </section>
  )
}
