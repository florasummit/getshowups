import Icon from './Icon.jsx'
import GetStarted from './GetStarted.jsx'
import { useStartAction } from '../lib/enrollment.js'
import { track } from '../lib/analytics.js'
import { DEMO_INDUSTRY_EVENT, industries } from '../content/demo.js'

// Picks the trade in the demo below, then lets the #demo link scroll there.
const tryWith = (id) => {
  track('hero_cta', { cta: 'industry', industry: id })
  window.dispatchEvent(new CustomEvent(DEMO_INDUSTRY_EVENT, { detail: id }))
}

export default function Hero() {
  const start = useStartAction()
  return (
    <section className="hero" aria-labelledby="hero-title">
      <div className="hero-glow" aria-hidden="true" />
      <div className="container hero-grid">
        <div className="hero-copy">
          <p className="eyebrow eyebrow--dark">Built for home service businesses</p>
          <h1 id="hero-title">
            <span className="hero-line">More booked jobs.</span> <span className="hero-line text-accent">Less chasing.</span>
          </h1>
          <p className="hero-sub">
            A professional website that books customers straight onto your Google Calendar, and one dashboard that shows
            every inquiry, booking and finished job.
          </p>
          <p className="hero-price">
            <strong>$499/month</strong>
            <span>Ad spend separate · No setup fee</span>
          </p>
          <div className="hero-actions">
            <GetStarted
              className="btn btn-primary btn-lg"
              onClick={() => track(start.closed ? 'early_access_cta' : 'hero_cta', start.closed ? { location: 'hero' } : { cta: 'get_started' })}
            >
              {' '}
              <Icon name="arrow" size={18} />
            </GetStarted>
            <a href="#demo" className="btn btn-ghost btn-lg" onClick={() => track('hero_cta', { cta: 'see_it_work' })}>
              <Icon name="play" size={16} /> See it work
            </a>
          </div>
          {start.closed && (
            <p className="hero-note enrollment-note" role="status">
              {start.note}
            </p>
          )}
          <div className="hero-try">
            <span id="hero-try-label">Try the demo as a</span>
            <ul aria-labelledby="hero-try-label">
              {industries.map((i) => (
                <li key={i.id}>
                  <a href="#demo" onClick={() => tryWith(i.id)} data-try={i.id}>
                    {i.label}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        </div>

        <figure className="hero-preview">
          <div className="hp-stack" aria-hidden="true">
            <div className="hp-phone">
              <div className="hp-site">
                <span className="hp-logo">T</span> Tidewater Pools
              </div>
              <p className="hp-title">Pick a visit time</p>
              <div className="hp-days">
                <span className="is-on">Thu</span>
                <span>Fri</span>
                <span>Sat</span>
              </div>
              <div className="hp-slots">
                <span>8:00 AM</span>
                <span className="is-on">10:30 AM</span>
                <span>1:00 PM</span>
                <span>3:30 PM</span>
              </div>
              <span className="hp-book">Book Thu 10:30 AM</span>
            </div>
            <div className="hp-owner">
              <p className="hp-owner-label">Your dashboard · Upcoming</p>
              <p className="hp-owner-name">Jordan Lee · weekly pool service</p>
              <p className="hp-owner-when">
                <Icon name="calendar" size={14} /> Thu 10:30 AM · 60 min visit
              </p>
              <p className="hp-tags">
                <span>ZIP 29464 in your area</span>
                <span>On your Google Calendar</span>
              </p>
            </div>
          </div>
          <figcaption>Example: a customer books a visit on the business’s page, and it lands in the owner’s dashboard.</figcaption>
        </figure>
      </div>
    </section>
  )
}
