import SectionHeading from './SectionHeading.jsx'
import { faqs } from '../content/site.js'

export default function Faq() {
  return (
    <section id="faq" className="section" aria-labelledby="faq-title">
      <div className="container container--narrow">
        <SectionHeading id="faq-title" eyebrow="FAQ" title="Questions, answered" />
        <div className="faq-list">
          {faqs.map((f) => (
            <details key={f.q} className="faq-item">
              <summary>
                <span>{f.q}</span>
                <span className="faq-toggle" aria-hidden="true" />
              </summary>
              <p>{f.a}</p>
            </details>
          ))}
        </div>
      </div>
    </section>
  )
}
