import Icon from './Icon.jsx'
import { ghl } from '../config/ghl.js'

const agenda = [
  'A walkthrough of the full lead-to-appointment workflow',
  'How qualification questions and reminders would work for your services',
  'What setup involves, including SMS registration requirements',
  'Current pricing and next steps — no obligation',
]

/**
 * GHL integration point.
 * Priority: booking calendar embed → lead form embed → honest "not connected" state.
 * Configure via VITE_GHL_BOOKING_URL / VITE_GHL_FORM_URL (see .env.example).
 */
function SchedulerSlot() {
  const src = ghl.bookingUrl ?? ghl.leadFormUrl
  if (src) {
    const isCalendar = Boolean(ghl.bookingUrl)
    return (
      <>
        <iframe
          className="ghl-embed"
          src={src}
          title={isCalendar ? 'Book a GetShowUps demo' : 'Request a GetShowUps demo'}
          loading="lazy"
          referrerPolicy="strict-origin-when-cross-origin"
        />
        <a className="embed-fallback" href={src} target="_blank" rel="noopener noreferrer">
          Calendar not loading? Open booking page in a new tab ↗
        </a>
      </>
    )
  }

  return (
    <div className="scheduler-placeholder" role="status">
      <span className="placeholder-icon">
        <Icon name="calendar" size={28} />
      </span>
      <p className="placeholder-title">Online booking isn’t connected yet</p>
      <p>
        Our scheduling calendar is being set up. No form is collecting information on this page, so nothing you enter
        here would be sent.
      </p>
      {ghl.contactEmail ? (
        <a className="btn btn-primary" href={`mailto:${ghl.contactEmail}?subject=GetShowUps%20demo%20request`}>
          Email us to request a demo
        </a>
      ) : (
        <p className="placeholder-soon">Check back soon to pick a time.</p>
      )}
      {import.meta.env.DEV && (
        <p className="dev-hint">
          Dev note: set <code>VITE_GHL_BOOKING_URL</code> (or <code>VITE_GHL_FORM_URL</code>) to render the GHL embed
          here. This note is hidden in production builds.
        </p>
      )}
    </div>
  )
}

export default function BookDemo() {
  return (
    <section id="book-demo" className="section section--muted" aria-labelledby="demo-title">
      <div className="container demo-grid">
        <div className="demo-copy">
          <p className="eyebrow">Book a demo</p>
          <h2 id="demo-title">See GetShowUps mapped to your business</h2>
          <p className="section-intro">
            A short call to walk through how leads would move from inquiry to appointment for your team.
          </p>
          <ul className="demo-agenda">
            {agenda.map((a) => (
              <li key={a}>
                <Icon name="tick" size={18} strokeWidth={2.5} />
                {a}
              </li>
            ))}
          </ul>
        </div>
        <div className="demo-panel">
          <SchedulerSlot />
        </div>
      </div>
    </section>
  )
}
