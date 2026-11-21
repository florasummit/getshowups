// The homepage story between the stage and pricing: the problem, how it works, Teach Your AI, industries.
// Copy and example data in content/site.js. Every status is what runs in production today. Each section explains
// through a product-derived visual (fictional example data, labelled) and keeps visible copy to a line per idea.
import Icon from './Icon.jsx'
import SectionHeading from './SectionHeading.jsx'
import { industries, journey, journeyNotes, problem, teach } from '../content/site.js'
import { CONVERSATION_EVENT } from '../content/conversation.js'
import { track } from '../lib/analytics.js'

// One inquiry, two mornings: the timeline on the left waits, the one on the right books. Same words, different outcome.
function Timeline({ story, tone }) {
  return (
    <figure className={`pn-col pn-col--${tone}`} aria-label={story.label}>
      <figcaption className="pn-col-head">
        <span className={`pn-col-mark pn-col-mark--${tone}`} aria-hidden="true" />
        {story.label}
      </figcaption>
      <ol className="pn-events">
        {story.events.map((e, i) => (
          <li key={i} className={`pn-event${e.note ? ` pn-event--note pn-event--${e.tone}` : ` pn-event--${e.who}`}`}>
            <span className="pn-time">{e.t}</span>
            {e.note ? (
              <span className="pn-note">
                {e.tone === 'ok' && <Icon name="tick" size={13} strokeWidth={3} />}
                {e.note}
              </span>
            ) : (
              <span className="pn-msg">
                <span className="pn-who">{e.who === 'ai' ? 'GetShowUps' : 'Customer'}</span>
                {e.text}
              </span>
            )}
          </li>
        ))}
      </ol>
    </figure>
  )
}

export function Problem() {
  return (
    <section id="problem" className="section problem" aria-labelledby="problem-title">
      <div className="container">
        <div className="split-head">
          <p className="eyebrow">The problem</p>
          <h2 id="problem-title">{problem.title}</h2>
        </div>
        <div className="pn" role="group" aria-label="One inquiry, answered late or answered now (example)">
          <Timeline story={problem.without} tone="without" />
          <div className="pn-divider" aria-hidden="true">
            <span>vs</span>
          </div>
          <Timeline story={problem.with} tone="with" />
        </div>
        <ul className="pn-legend" aria-label="What gets in the way">
          {problem.legend.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
        <p className="pn-fine">Example with made-up times. Not a measured result.</p>
      </div>
    </section>
  )
}

// Each step drawn as the product state it produces: the website with its Book button, the chat reply, the area
// check, the open times, the appointment on the owner's calendar, the counts. Fictional example data.
const STEP_UI = {
  attract: (
    <div className="jf-ui jf-site">
      <span className="jf-site-bar">
        <i />
        <i />
        <i />
        <span>tidewaterpools.getshowups.com</span>
      </span>
      <span className="jf-site-name">Tidewater Pools</span>
      <span className="jf-site-line" />
      <span className="jf-site-line jf-site-line--short" />
      <span className="jf-site-btn">Book online</span>
    </div>
  ),
  answer: (
    <div className="jf-ui jf-chat">
      <span className="jf-bubble jf-bubble--customer">My pool is green. I’m in Mount Pleasant.</span>
      <span className="jf-bubble jf-bubble--ai">Got it, a green pool in Mount Pleasant. What’s your name and the best number?</span>
    </div>
  ),
  qualify: (
    <div className="jf-ui jf-checks">
      <span className="jf-chip jf-chip--ok">
        <Icon name="tick" size={12} strokeWidth={3} /> Mount Pleasant · in your area
      </span>
      <span className="jf-chip jf-chip--ok">
        <Icon name="tick" size={12} strokeWidth={3} /> Your rule: urgency asked first
      </span>
      <span className="jf-chip">No price invented</span>
    </div>
  ),
  book: (
    <div className="jf-ui jf-slots">
      <span className="jf-slots-day">Friday</span>
      <span className="jf-slot">8:00 AM</span>
      <span className="jf-slot jf-slot--on">10:30 AM</span>
      <span className="jf-slot">1:00 PM</span>
      <span className="jf-slot jf-slot--gone">3:30 PM</span>
    </div>
  ),
  notify: (
    <div className="jf-ui jf-appt">
      <span className="jf-appt-when">Fri 10:30 AM · 60 min</span>
      <span className="jf-appt-who">Jamie Rivera · Green pool cleanup</span>
      <span className="jf-appt-where">14 Harbor Oak Lane, Mount Pleasant</span>
      <span className="jf-chip jf-chip--ok">
        <Icon name="tick" size={12} strokeWidth={3} /> Invitation sent
      </span>
    </div>
  ),
  measure: (
    <div className="jf-ui jf-stats" aria-hidden="true">
      {[
        ['Inquiries', '12'],
        ['Booked', '9'],
        ['Showed', '8'],
        ['Done', '7'],
      ].map(([l, v]) => (
        <span key={l} className="jf-stat">
          <b>{v}</b>
          {l}
        </span>
      ))}
    </div>
  ),
}
const STATUS = { live: ['Live today', 'ok'], partly: ['Partly live', 'warn'], soon: ['Coming soon', 'neutral'] }

export function HowItWorks() {
  return (
    <section id="how-it-works" className="section how" aria-labelledby="how-title">
      <div className="container">
        <SectionHeading id="how-title" eyebrow="How it works" title="From first message to finished job" />
        <ol className="jf" aria-label="The six steps">
          {journey.map((s, i) => {
            const [label, tone] = STATUS[s.status]
            return (
              <li key={s.id} className={`jf-step jf-step--${s.id}`}>
                <div className="jf-card">
                  <span className="jf-n" aria-hidden="true">
                    {i + 1}
                  </span>
                  {STEP_UI[s.id]}
                </div>
                <h3>{s.title}</h3>
                <p>{s.body}</p>
                <span className={`status status--${tone}`}>{label}</span>
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
    <section id="teach" className="section teach" aria-labelledby="teach-title">
      <div className="container">
        <div className="teach-head">
          <div>
            <p className="eyebrow">Teach Your AI</p>
            <h2 id="teach-title">{teach.title}</h2>
            <p className="section-intro">{teach.sub}</p>
          </div>
          <span className="status status--pilot">{teach.status}</span>
        </div>
        <figure className="teach-stage" aria-label="Your rules beside the conversation they decide (example)">
          <div className="teach-rules" aria-label="Your rules">
            <p className="teach-panel-label">Your rules · Lowcountry Air</p>
            <ol className="teach-rule-list">
              {teach.rules.map((r) => (
                <li key={r.n} className={`teach-rule${r.hit ? ' is-hit' : ''}${r.fixed ? ' is-fixed' : ''}`} aria-current={r.hit ? 'true' : undefined}>
                  <span className="teach-rule-n" aria-hidden="true">
                    {r.n}
                  </span>
                  <span>{r.text}</span>
                  {r.fixed && <span className="teach-rule-tag">always on</span>}
                  {r.hit && <span className="teach-rule-tag teach-rule-tag--hit">applied</span>}
                </li>
              ))}
            </ol>
          </div>
          <div className="teach-chat" aria-label="The conversation">
            <p className="teach-panel-label">Customer on your website</p>
            {teach.chat.map((m, i) => (
              <p key={i} className={`teach-msg teach-msg--${m.who}`}>
                <span className="teach-who">{m.who === 'ai' ? 'Your AI' : 'Customer'}</span>
                {m.text}
              </p>
            ))}
            <p className="teach-applied">
              <Icon name="tick" size={14} strokeWidth={3} /> {teach.applied}
            </p>
          </div>
        </figure>
        <ul className="teach-points">
          {teach.points.map(([t, b]) => (
            <li key={t}>
              <strong>{t}</strong>
              <span>{b}</span>
            </li>
          ))}
        </ul>
        <p className="teach-locked">
          <Icon name="check" size={14} /> {teach.locked}
        </p>
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
        <div className="ind-grid">
          {industries.map((i) => (
            <article key={i.id} className={`ind-card ind-card--${i.id}`}>
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
