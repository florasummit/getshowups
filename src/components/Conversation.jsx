// "See it answer a customer": the AI conversation simulation (Mode A). Scripted and deterministic from
// content/conversation.js: the visitor sends the customer's next line; the reply appears in the chat, and the trace
// beside it shows what the AI is doing (Inquiry → Understanding → Qualification → Action → Booking), one stage at a
// time. No network, no storage, no model. Labelled a simulation throughout.
// Mode B (the booking page + owner dashboard walkthrough) is components/Demo.jsx; the switch lives in Showcase.jsx.
import { useEffect, useRef, useState } from 'react'
import Icon from './Icon.jsx'
import { CONVERSATION_EVENT, DONE, SCENARIOS, STAGES, ownerView } from '../content/conversation.js'
import { track } from '../lib/analytics.js'

const reduced = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

export default function Conversation({ onSwitchMode }) {
  const [scenarioId, setScenarioId] = useState(SCENARIOS[0].id)
  const scenario = SCENARIOS.find((s) => s.id === scenarioId)
  const [sent, setSent] = useState(0) // customer lines sent so far
  const [phase, setPhase] = useState('idle') // idle | thinking | replied
  const [showOwner, setShowOwner] = useState(false)
  const timers = useRef([])
  const live = useRef(null)
  const endRef = useRef(null)

  const clear = () => {
    timers.current.forEach(clearTimeout)
    timers.current = []
  }
  const reset = (id = scenarioId, announce = true) => {
    clear()
    setScenarioId(id)
    setSent(0)
    setPhase('idle')
    setShowOwner(false)
    if (announce) live.current?.focus({ preventScroll: true })
  }
  const choose = (id, announce = true) => {
    if (id !== scenarioId) track('conversation_industry', { industry: id })
    reset(id, announce)
  }
  useEffect(() => {
    const onPick = (e) => SCENARIOS.some((s) => s.id === e.detail) && choose(e.detail, false)
    window.addEventListener(CONVERSATION_EVENT, onPick)
    return () => window.removeEventListener(CONVERSATION_EVENT, onPick)
  })
  useEffect(() => clear, [])

  const turns = scenario.turns
  const next = turns[sent]
  const finished = sent === turns.length && phase === 'replied'
  const done = finished ? DONE[turns[turns.length - 1].done] : null

  const send = () => {
    if (!next || phase === 'thinking') return
    if (sent === 0) track('conversation_started', { industry: scenarioId })
    setSent((n) => n + 1)
    setPhase('thinking')
    const wait = reduced() ? 0 : 700
    timers.current.push(
      setTimeout(() => {
        setPhase('replied')
        if (sent + 1 === turns.length) track('conversation_finished', { industry: scenarioId })
        endRef.current?.scrollIntoView?.({ block: 'nearest', behavior: reduced() ? 'auto' : 'smooth' })
      }, wait),
    )
  }

  const shown = turns.slice(0, sent)
  // Turns whose reply is on screen: the trace only ever shows what the AI has actually done.
  const answered = phase === 'replied' ? shown : shown.slice(0, -1)
  const current = sent === 0 ? 'inquiry' : phase === 'thinking' ? 'understanding' : finished ? 'booking' : 'action'
  const currentIndex = STAGES.findIndex((s) => s.id === current)
  const state = (i) => (finished ? 'done' : i < currentIndex ? 'done' : i === currentIndex ? 'now' : 'todo')

  return (
    <div className="cv" data-conversation data-industry={scenarioId} data-phase={phase}>
      <div className="cv-bar">
        <div className="seg" role="group" aria-label="Business type">
          {SCENARIOS.map((s) => (
            <button key={s.id} type="button" aria-pressed={s.id === scenarioId} onClick={() => choose(s.id)}>
              {s.label}
              {s.upcoming && <span className="cv-upcoming">upcoming</span>}
            </button>
          ))}
        </div>
        <p className="cv-sim">{scenario.business} is an example business</p>
      </div>

      <div className="cv-panes">
        <div className="cv-chat" aria-label="Conversation">
          <div className="cv-thread" aria-live="polite">
            {shown.map((t, i) => {
              const last = i === shown.length - 1
              const replied = !last || phase === 'replied'
              return (
                <div key={i} className="cv-turn">
                  <p className="cv-msg cv-msg--customer">
                    <span className="cv-who">Customer</span>
                    {t.customer}
                  </p>
                  {replied ? (
                    <>
                      <p className="cv-check">{t.check}</p>
                      <p className="cv-msg cv-msg--ai">
                        <span className="cv-who">GetShowUps</span>
                        {t.reply}
                      </p>
                      {t.offers && (
                        <p className="cv-offers" aria-label="Times offered (illustrative)">
                          {t.offers.map((o) => (
                            <span key={o}>{o}</span>
                          ))}
                        </p>
                      )}
                    </>
                  ) : (
                    <p className="cv-msg cv-msg--ai cv-typing" aria-label="GetShowUps is replying">
                      <span />
                      <span />
                      <span />
                    </p>
                  )}
                </div>
              )
            })}
            {done && (
              <p className={`cv-done cv-done--${done.tone}`} role="status">
                <Icon name="check" size={16} /> {done.label}
              </p>
            )}
            {next && (
              <p className="cv-ghost cv-preview">
                <span className="cv-who">Customer · next message</span>
                {next.customer}
              </p>
            )}
            <div ref={endRef} />
          </div>
          <div className="cv-compose">
            {sent === 0 && <p className="cv-hint">You’re the customer. Send the message and watch what the AI does.</p>}
            <button type="button" className="btn btn-primary" onClick={send} disabled={!next} aria-busy={phase === 'thinking' || undefined} ref={live} data-send>
              {sent === 0 ? 'Send the first message' : next ? 'Send the next message' : 'Conversation complete'}
              {next && <Icon name="arrow" size={16} />}
            </button>
          </div>
        </div>

        <aside className="cv-side" aria-label="What the AI is doing">
          {!showOwner ? (
            <ol className="cv-trace">
              {STAGES.map((s, i) => {
                const st = state(i)
                return (
                  <li key={s.id} className={`cv-node is-${st}`} aria-current={st === 'now' ? 'step' : undefined}>
                    <span className="cv-node-i" aria-hidden="true">
                      {st === 'done' ? <Icon name="tick" size={12} strokeWidth={3} /> : i + 1}
                    </span>
                    <div className="cv-node-body">
                      <h3>{s.label}</h3>
                      {s.id === 'inquiry' && <p>{sent ? 'The customer wrote in on the website chat.' : s.body}</p>}
                      {s.id === 'understanding' &&
                        (answered.length ? (
                          answered.map((t, ti) => (
                            <ul key={ti} className="cv-facts is-in" aria-label="What the AI understood">
                              {t.recognized.map(([k, v]) => (
                                <li key={k + v}>
                                  <span>{k}</span> {v}
                                </li>
                              ))}
                            </ul>
                          ))
                        ) : (
                          <p>{s.body}</p>
                        ))}
                      {s.id === 'qualification' && <p>{answered.length ? scenario.rulesNote : s.body}</p>}
                      {s.id === 'action' && <p>{answered.length ? answered[answered.length - 1].action : s.body}</p>}
                      {s.id === 'booking' &&
                        (done ? (
                          <>
                            <p className="cv-node-booked">{done.label}</p>
                            <p className="cv-node-owner">
                              <span>On your dashboard</span> {ownerView(turns[turns.length - 1].done)[0]} · {ownerView(turns[turns.length - 1].done)[1]}
                            </p>
                          </>
                        ) : (
                          <p>{s.body}</p>
                        ))}
                    </div>
                  </li>
                )
              })}
            </ol>
          ) : (
            <OwnerCard outcome={turns[turns.length - 1].done} business={scenario.business} onBack={() => setShowOwner(false)} />
          )}
          <div className="cv-side-actions">
            {finished && !showOwner && (
              <button type="button" className="btn btn-line btn-sm" onClick={() => setShowOwner(true)} data-owner>
                See what you’d see
              </button>
            )}
            <button type="button" className="link-btn" onClick={() => reset()} disabled={sent === 0}>
              <Icon name="reset" size={14} /> Start over
            </button>
            {onSwitchMode && (
              <button type="button" className="link-btn" onClick={onSwitchMode}>
                Try the booking page instead →
              </button>
            )}
          </div>
        </aside>
      </div>
      <p className="cv-fine">
        Replies are scripted examples of how the AI receptionist behaves. In the product it checks your real calendar, follows the rules you set in Teach Your AI, and never books without the customer’s own yes. Texting, email reminders and automatic
        follow-ups aren’t shown because they aren’t live yet.
      </p>
    </div>
  )
}

function OwnerCard({ outcome, business, onBack }) {
  const [status, line, actions] = ownerView(outcome)
  return (
    <div className="cv-owner" role="region" aria-label="Your dashboard">
      <p className="cv-owner-title">Your dashboard · {business}</p>
      <p className="cv-owner-status">{status}</p>
      <p className="cv-owner-line">{line}</p>
      <ul className="cv-owner-actions">
        {actions.map((a) => (
          <li key={a}>
            <Icon name="tick" size={14} /> {a}
          </li>
        ))}
      </ul>
      <p className="cv-owner-text">Every conversation shows what was said, what the AI did, and the outcome. Nothing you’d see here involves a real customer.</p>
      <button type="button" className="link-btn" onClick={onBack}>
        ← Back to the conversation
      </button>
    </div>
  )
}
