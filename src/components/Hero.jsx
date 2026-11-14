import Icon from './Icon.jsx'
import { getStarted, steps } from '../content/site.js'

export default function Hero() {
  return (
    <section className="hero" aria-labelledby="hero-title">
      <div className="hero-glow" aria-hidden="true" />
      <div className="container hero-inner">
        <p className="eyebrow eyebrow--dark">Online booking for home service businesses</p>
        <h1 id="hero-title">
          Turn More Leads Into Appointments That <span className="text-accent">Actually Show Up</span>
        </h1>
        <p className="hero-sub">
          GetShowUps builds and hosts your business website, books leads straight onto your Google Calendar, and
          tracks who actually shows up. $499/month.
        </p>
        <div className="hero-actions">
          <a href={getStarted.href} className="btn btn-primary btn-lg">
            {getStarted.label} <Icon name="arrow" size={18} />
          </a>
          <a href="#how-it-works" className="btn btn-ghost btn-lg">
            See how it works
          </a>
        </div>
        <ol className="hero-flow" aria-label="The GetShowUps workflow">
          {steps.map((s, i) => (
            <li key={s.id}>
              <span className="hero-flow-pill">
                <Icon name={s.icon} size={16} />
                {s.title}
              </span>
              {i < steps.length - 1 && (
                <span className="hero-flow-arrow" aria-hidden="true">
                  →
                </span>
              )}
            </li>
          ))}
        </ol>
      </div>
    </section>
  )
}
