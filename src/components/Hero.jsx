import Icon from './Icon.jsx'
import GetStarted from './GetStarted.jsx'
import { useStartAction } from '../lib/enrollment.js'
import { track } from '../lib/analytics.js'
import { hero } from '../content/site.js'
import { CONVERSATION_EVENT, SCENARIOS } from '../content/conversation.js'

// Picks the trade in the demo below, then lets the #demo link scroll there.
const tryWith = (id) => {
  track('hero_cta', { cta: 'industry', industry: id })
  window.dispatchEvent(new CustomEvent(CONVERSATION_EVENT, { detail: id }))
}

// The first viewport: the promise, then the product doing the one thing that matters — turning a message into a
// qualified booking. The composition is a real excerpt of the pool scenario (content/conversation.js), labelled.
export default function Hero() {
  const start = useStartAction()
  const pool = SCENARIOS[0]
  const t0 = pool.turns[0]
  return (
    <section className="hero" aria-labelledby="hero-title">
      <div className="container hero-grid">
        <div className="hero-copy">
          <p className="eyebrow">{hero.eyebrow}</p>
          <h1 id="hero-title">
            <span className="hero-line">More booked jobs.</span> <em className="hero-line hero-em">Less chasing.</em>
          </h1>
          <p className="hero-sub">{hero.sub}</p>
          <div className="hero-actions">
            <GetStarted className="btn btn-primary btn-lg" onClick={() => track(start.closed ? 'early_access_cta' : 'hero_cta', start.closed ? { location: 'hero' } : { cta: 'get_started' })}>
              {' '}
              <Icon name="arrow" size={18} />
            </GetStarted>
            <a href="#demo" className="btn btn-ghost btn-lg" onClick={() => track('hero_cta', { cta: 'see_it_work' })}>
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

        <figure className="hero-stage" aria-label="Example: a customer message becomes a booking">
          <p className="hero-stage-label">
            <span className="cv-sim-dot" aria-hidden="true" /> Simulation · {pool.business} is an example
          </p>
          <p className="cv-msg cv-msg--customer">
            <span className="cv-who">Customer</span>
            {t0.customer}
          </p>
          <ul className="cv-facts is-in hero-facts" aria-label="What the AI understood">
            {t0.recognized.map(([k, v]) => (
              <li key={k}>
                <span>{k}</span> {v}
              </li>
            ))}
            <li>
              <span>Still needed</span> name, phone
            </li>
          </ul>
          <p className="cv-msg cv-msg--ai">
            <span className="cv-who">GetShowUps</span>
            {t0.reply}
          </p>
          <figcaption className="hero-try">
            <span id="hero-try-label">Try it as a</span>
            <ul aria-labelledby="hero-try-label">
              {SCENARIOS.map((s) => (
                <li key={s.id}>
                  <a href="#demo" onClick={() => tryWith(s.id)} data-try={s.id}>
                    {s.label}
                  </a>
                </li>
              ))}
            </ul>
          </figcaption>
        </figure>
      </div>
      <div className="hero-ledger container" aria-label="What GetShowUps does">
        {[
          ['Attract', 'Your site, with booking and chat'],
          ['Answer', 'Replies in seconds, in your words'],
          ['Qualify', 'Area, job and urgency checked'],
          ['Book', 'Real open times, confirmed'],
          ['Notify', 'On your calendar, you’re told'],
          ['Measure', 'Every inquiry accounted for'],
        ].map(([k, v]) => (
          <div key={k} className="is-on">
            <small>{k}</small>
            <p>{v}</p>
          </div>
        ))}
      </div>
    </section>
  )
}
