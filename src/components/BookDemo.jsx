import Icon from './Icon.jsx'
import { ghl } from '../config/ghl.js'
import { enrollmentClosed } from '../content/site.js'
import { useStartAction } from '../lib/enrollment.js'
import { track } from '../lib/analytics.js'

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
        <a className="embed-fallback" href={src} target="_blank" rel="noopener noreferrer" onClick={() => track('early_access_open', { how: 'new_tab' })}>
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
  const start = useStartAction()
  return (
    <section id="book-demo" className="section section--muted" aria-labelledby="demo-title">
      <div className="container demo-grid">
        <div className="demo-copy">
          <p className="eyebrow">{start.closed ? 'Early access' : 'Talk to us'}</p>
          <h2 id="demo-title">{start.closed ? 'Request early access' : 'Questions first? Book a short call'}</h2>
          <p className="section-intro">
            A short call about your business: how your inquiries would become booked visits, and what setup involves.
          </p>
          {start.closed && (
            <>
              <h3 className="demo-next-title">What happens next</h3>
              <ol className="demo-next">
                {enrollmentClosed.next.map((a) => (
                  <li key={a}>{a}</li>
                ))}
              </ol>
            </>
          )}
        </div>
        <div className="demo-panel">
          <SchedulerSlot />
        </div>
      </div>
    </section>
  )
}
