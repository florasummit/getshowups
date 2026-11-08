import Icon from './Icon.jsx'
import SectionHeading from './SectionHeading.jsx'
import { steps } from '../content/site.js'

export default function HowItWorks() {
  return (
    <section id="how-it-works" className="section" aria-labelledby="how-title">
      <div className="container">
        <SectionHeading
          id="how-title"
          eyebrow="How it works"
          title="One workflow from first inquiry to follow-up"
          intro="Every lead moves through the same six stages, automatically — and your team steps in only where it matters."
        />
        <ol className="steps">
          {steps.map((s, i) => (
            <li key={s.id} className="step">
              <div className="step-top">
                <span className="step-icon">
                  <Icon name={s.icon} size={22} />
                </span>
                <span className="step-num">{String(i + 1).padStart(2, '0')}</span>
              </div>
              <h3>{s.title}</h3>
              <p>{s.body}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  )
}
