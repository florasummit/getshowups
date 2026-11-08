import Icon from './Icon.jsx'
import SectionHeading from './SectionHeading.jsx'
import { features } from '../content/site.js'

export default function Features() {
  return (
    <section id="features" className="section section--muted" aria-labelledby="features-title">
      <div className="container">
        <SectionHeading
          id="features-title"
          eyebrow="Features"
          title="Everything between “new lead” and “they showed up”"
          intro="The parts of appointment conversion that usually fall through the cracks, handled in one place."
        />
        <ul className="feature-grid">
          {features.map((f) => (
            <li key={f.title} className="feature-card">
              <span className="feature-icon">
                <Icon name={f.icon} size={22} />
              </span>
              <h3>{f.title}</h3>
              <p>{f.body}</p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  )
}
