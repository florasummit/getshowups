// The homepage story between the stage and pricing: the problem, how it works, Teach Your AI, industries.
// Copy in content/site.js. Every status is what runs in production today.
import Icon from './Icon.jsx'
import SectionHeading from './SectionHeading.jsx'
import { industries, journey, journeyNotes, problem, teach } from '../content/site.js'
import { CONVERSATION_EVENT } from '../content/conversation.js'
import { track } from '../lib/analytics.js'

export function Problem() {
  return (
    <section id="problem" className="section problem" aria-labelledby="problem-title">
      <div className="container">
        <div className="split-head">
          <p className="eyebrow">The problem</p>
          <h2 id="problem-title">{problem.title}</h2>
        </div>
        <div className="problem-grid">
          {problem.items.map((p, i) => (
            <div key={p.title} className="problem-item">
              <span className="num" aria-hidden="true">
                0{i + 1}
              </span>
              <h3>{p.title}</h3>
              <p>{p.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

const STATUS = { live: ['Live today', 'ok'], partly: ['Partly live', 'warn'], soon: ['Coming soon', 'neutral'] }
export function HowItWorks() {
  return (
    <section id="how-it-works" className="section how" aria-labelledby="how-title">
      <div className="container">
        <SectionHeading id="how-title" eyebrow="How it works" title="From first message to finished job" intro="Six steps, one system. Each one says what it does today." />
        <ol className="jr" aria-label="The six steps">
          {journey.map((s, i) => {
            const [label, tone] = STATUS[s.status]
            return (
              <li key={s.id} className="jr-step">
                <span className="jr-dot" aria-hidden="true" />
                <span className="num" aria-hidden="true">
                  {String(i + 1).padStart(2, '0')}
                </span>
                <h3>{s.title}</h3>
                <span className={`status status--${tone}`}>{label}</span>
                <p>{s.body}</p>
              </li>
            )
          })}
        </ol>
        <p className="jr-note">{journeyNotes}</p>
      </div>
    </section>
  )
}

export function TeachYourAI() {
  return (
    <section id="teach" className="section section--dark teach" aria-labelledby="teach-title">
      <div className="container teach-grid">
        <div className="teach-copy">
          <p className="eyebrow">Teach Your AI</p>
          <h2 id="teach-title">{teach.title}</h2>
          <p className="section-intro">{teach.sub}</p>
          <span className="status status--pilot">{teach.status}</span>
          <ul className="teach-points">
            {teach.points.map(([t, b]) => (
              <li key={t}>
                <strong>{t}</strong>
                <span>{b}</span>
              </li>
            ))}
          </ul>
        </div>
        <figure className="teach-panel" aria-label="Teach a change: an example proposal">
          <div className="teach-panel-head">
            <p className="teach-panel-label">Teach a change · example</p>
            <p className="teach-panel-label teach-panel-label--on">Nothing is saved until you add it</p>
          </div>
          <p className="teach-ask">“We don’t install equipment, only repair it. Ask about the problem first. If someone reports no heat, get them the soonest time.”</p>
          <p className="teach-panel-label">This would change</p>
          <ul className="teach-diff">
            <li>Services you don’t offer: added Equipment installation.</li>
            <li>What they need is already asked first.</li>
            <li>Urgent situations: added no heat → offer the soonest open time.</li>
          </ul>
          <p className="teach-locked">
            <Icon name="check" size={14} /> Area check, the customer’s yes and safety advice stay on. Always.
          </p>
          <div className="teach-panel-actions" aria-hidden="true">
            <span className="btn btn-primary btn-sm">Add to my draft</span>
            <span className="btn btn-ghost btn-sm">Discard</span>
          </div>
        </figure>
      </div>
    </section>
  )
}

export function Industries() {
  const go = (id) => {
    track('hero_cta', { cta: 'industry', industry: id })
    window.dispatchEvent(new CustomEvent(CONVERSATION_EVENT, { detail: id }))
  }
  return (
    <section id="industries" className="section industries" aria-labelledby="industries-title">
      <div className="container">
        <div className="split-head">
          <p className="eyebrow">Built for</p>
          <h2 id="industries-title">Trades where the first reply wins the job</h2>
        </div>
        <div className="ind-list">
          {industries.map((i) => (
            <article key={i.id} className="ind-row">
              <h3>
                {i.title}
                {i.upcoming && <span className="status status--neutral">Upcoming</span>}
              </h3>
              <p>{i.body}</p>
              <a href="#demo" className="link-btn" onClick={() => go(i.id)}>
                See {/^[aeiou]/i.test(i.title) ? 'an' : 'a'} {i.title === i.title.toUpperCase() ? i.title : i.title.toLowerCase()} conversation →
              </a>
            </article>
          ))}
        </div>
      </div>
    </section>
  )
}
