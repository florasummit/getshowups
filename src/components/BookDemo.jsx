import Icon from './Icon.jsx'
import { ghl } from '../config/ghl.js'
import { enrollmentClosed } from '../content/site.js'
import { CONTACT_EMAIL, SALES_BUSINESS, salesBookingHref, useSalesChat, useStartAction } from '../lib/enrollment.js'
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
        here would be sent. Email us and a person replies with times for a call.
      </p>
      {/* Always a working way to reach us: the configured address, else the one the product uses everywhere. */}
      <a className="btn btn-primary" href={`mailto:${ghl.contactEmail || CONTACT_EMAIL}?subject=GetShowUps%20call%20request`} data-contact-email onClick={() => track('early_access_open', { how: 'email' })}>
        Email us to arrange a call
      </a>
      {import.meta.env.DEV && (
        <p className="dev-hint">
          Dev note: set <code>VITE_GHL_BOOKING_URL</code> (or <code>VITE_GHL_FORM_URL</code>) to render the GHL embed
          here. This note is hidden in production builds.
        </p>
      )}
    </div>
  )
}

// GetShowUps' own booking page (the product every customer gets): the visitor leaves details, picks one of the founder's
// real open times, and the call is booked on the calendar, with Google's invitation. The request is a lead in GetShowUps,
// attributed to this button (salesBookingHref), so it can be followed up and counted.
function SalesBooking() {
  return (
    <div className="scheduler-placeholder sales-booking" data-sales-booking>
      <span className="placeholder-icon">
        <Icon name="calendar" size={28} />
      </span>
      <p className="placeholder-title">Book a 20-minute call</p>
      <p>Pick a time that suits you. It goes straight onto our calendar and Google sends you the invitation.</p>
      <a className="btn btn-primary" href={salesBookingHref('section')} onClick={() => track('early_access_open', { how: 'booking_page' })}>
        See open times
      </a>
    </div>
  )
}

export default function BookDemo() {
  const start = useStartAction()
  // GetShowUps selling itself: the same receptionist every customer gets, with the sales playbook, on the GetShowUps
  // business record. Offered only when that record runs it (read with the enrollment check; nothing else changes).
  const salesChat = useSalesChat()
  return (
    <section id="book-demo" className="section" aria-labelledby="demo-title">
      <div className="container demo-grid">
        <div className="demo-copy">
          <p className="eyebrow">{start.closed ? 'Early access' : 'Talk to us'}</p>
          <h2 id="demo-title">{start.closed ? 'Request early access' : 'Questions first? Book a short call'}</h2>
          <p className="section-intro">A short call: how your inquiries become booked visits, and what setup involves.</p>
          {salesChat && (
            <p className="demo-chat">
              <a className="btn btn-line" href={`/chat/${SALES_BUSINESS}`} onClick={() => track('early_access_cta', { location: 'sales_chat' })} data-sales-chat>
                Ask our AI about GetShowUps
              </a>
              <span className="fine">Questions, pricing, or book the call right there.</span>
            </p>
          )}
          {start.closed && (
            <>
              <h3 className="demo-next-title">What happens next</h3>
              <ol className="demo-next">
                {(salesChat ? enrollmentClosed.nextOwnBooking : enrollmentClosed.next).map((a) => (
                  <li key={a}>{a}</li>
                ))}
              </ol>
            </>
          )}
        </div>
        <div className="demo-panel">{salesChat ? <SalesBooking /> : <SchedulerSlot />}</div>
      </div>
    </section>
  )
}
