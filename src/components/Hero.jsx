import Icon from './Icon.jsx'
import GetStarted from './GetStarted.jsx'
import { useStartAction } from '../lib/enrollment.js'
import { track } from '../lib/analytics.js'
import { hero } from '../content/site.js'

// The first viewport: the promise across the full width, then one row — what it does on the left, the one primary
// action (with a quiet "see it" link beside it) on the right — and the product stage (Showcase.jsx) rising into view
// directly beneath. The only colour is the beam: one diagonal gradient from the logo orange into sky and lavender,
// drawn once behind the headline (decorative, CSS only).
export default function Hero() {
  const start = useStartAction()
  return (
    <section className="hero" aria-labelledby="hero-title">
      <div className="hero-beam" aria-hidden="true" />
      <div className="container">
        <p className="eyebrow">{hero.eyebrow}</p>
        <h1 id="hero-title">
          <span className="hero-line">More booked jobs.</span> <span className="hero-line">Less chasing.</span>
        </h1>
        <div className="hero-row">
          <p className="hero-sub">{hero.sub}</p>
          <div className="hero-aside">
            <div className="hero-actions">
              <GetStarted location="hero" className="btn btn-ink btn-lg" onClick={() => track(start.closed ? 'early_access_cta' : 'hero_cta', start.closed ? { location: 'hero' } : { cta: 'get_started' })}>
                {' '}
                <Icon name="arrow" size={18} />
              </GetStarted>
              <a href="#demo" className="hero-secondary" onClick={() => track('hero_cta', { cta: 'see_it_work' })}>
                <Icon name="play" size={14} /> See it answer a customer
              </a>
            </div>
            <p className="hero-price">
              <strong>$499/month</strong>
              <span>Ad spend separate · No setup fee</span>
            </p>
            {start.closed && (
              <p className="hero-note enrollment-note" role="status">
                {start.note}
              </p>
            )}
          </div>
        </div>
      </div>
    </section>
  )
}
