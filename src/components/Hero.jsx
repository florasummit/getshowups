import Icon from './Icon.jsx'
import { steps } from '../content/site.js'

export default function Hero() {
  return (
    <section className="hero" aria-labelledby="hero-title">
      <div className="hero-glow" aria-hidden="true" />
      <div className="container hero-inner">
        <p className="eyebrow eyebrow--dark">AI appointment conversion for service businesses</p>
        <h1 id="hero-title">
          Turn More Leads Into Appointments That <span className="text-accent">Actually Show Up</span>
        </h1>
        <p className="hero-sub">
          GetShowUps responds to every new lead in moments, qualifies them by text, books them onto your calendar, and
          keeps them reminded until they walk through your door.
        </p>
        <div className="hero-actions">
          <a href="#book-demo" className="btn btn-primary btn-lg">
            Book a Demo <Icon name="arrow" size={18} />
          </a>
          <a href="#simulation" className="btn btn-ghost btn-lg">
            Try the simulation
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
