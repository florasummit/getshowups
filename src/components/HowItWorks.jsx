import Icon from './Icon.jsx'
import SectionHeading from './SectionHeading.jsx'
import { steps } from '../content/site.js'

const STATUS = { live: 'Live today', partly: 'Partly live' }

export default function HowItWorks() {
  return (
    <section id="how-it-works" className="section" aria-labelledby="how-title">
      <div className="container">
        <SectionHeading
          id="how-title"
          eyebrow="How it works"
          title="Six steps from first inquiry to follow-up"
          intro="What each step does today. Where part of a step is still coming, it says so."
        />
        <ol className="flow">
          {steps.map((s, i) => (
            <li key={s.id} className="flow-step" data-step={s.id}>
              <div className="flow-head">
                <span className="flow-num" aria-hidden="true">
                  {String(i + 1).padStart(2, '0')}
                </span>
                <span className="flow-icon" aria-hidden="true">
                  <Icon name={s.icon} size={20} />
                </span>
                <h3>{s.title}</h3>
                <span className={`flow-status is-${s.status}`}>{STATUS[s.status]}</span>
              </div>
              <p>{s.body}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  )
}
