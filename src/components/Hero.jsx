import Icon from './Icon.jsx'
import GetStarted from './GetStarted.jsx'
import { useStartAction } from '../lib/enrollment.js'
import { track } from '../lib/analytics.js'
import { hero } from '../content/site.js'

// The first viewport: the promise on white, then the product stage (Showcase.jsx) rising into view beneath it. The
// hero itself is text only, so the product is the first thing with any visual weight.
export default function Hero() {
  const start = useStartAction()
  return (
    <section className="hero" aria-labelledby="hero-title">
      <div className="container hero-grid">
        <div className="hero-copy">
          <p className="eyebrow">{hero.eyebrow}</p>
          <h1 id="hero-title">
            <span className="hero-line">More booked jobs.</span> <span className="hero-line">Less chasing.</span>
          </h1>
        </div>
        <div className="hero-aside">
          <p className="hero-sub">{hero.sub}</p>
          <div className="hero-actions">
            <GetStarted className="btn btn-ink btn-lg" onClick={() => track(start.closed ? 'early_access_cta' : 'hero_cta', start.closed ? { location: 'hero' } : { cta: 'get_started' })}>
              {' '}
              <Icon name="arrow" size={18} />
            </GetStarted>
            <a href="#demo" className="btn btn-line btn-lg" onClick={() => track('hero_cta', { cta: 'see_it_work' })}>
              <Icon name="play" size={16} /> See it answer a customer
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
    </section>
  )
}
