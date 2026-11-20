// "See it answer a customer": the AI conversation simulation (Mode A). Scripted and deterministic from
// content/conversation.js: the visitor sends the customer's next line, the AI's understanding appears as facts, then
// its reply, with the check or rule that applied. No network, no storage, no model. Labelled a simulation throughout.
// Mode B (the booking page + owner dashboard walkthrough) is components/Demo.jsx; the switch lives in Showcase.jsx.
import { useEffect, useRef, useState } from 'react'
import Icon from './Icon.jsx'
import { CONVERSATION_EVENT, DONE, SCENARIOS, ownerView } from '../content/conversation.js'
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
        <p className="cv-sim" role="note">
          <span className="cv-sim-dot" aria-hidden="true" />
          Simulation · {scenario.business} is an example · nothing is sent, booked or stored
        </p>
      </div>

      <div className="cv-panes">
        <div className="cv-chat" aria-live="polite" aria-label="Conversation">
          <p className="cv-rule">
            <Icon name="sparkles" size={14} /> {scenario.rulesNote}
          </p>
          {shown.map((t, i) => {
            const last = i === shown.length - 1
            const answered = !last || phase === 'replied'
            return (
              <div key={i} className="cv-turn">
                <p className="cv-msg cv-msg--customer">
                  <span className="cv-who">Customer</span>
                  {t.customer}
                </p>
                <ul className={`cv-facts${answered ? ' is-in' : ''}`} aria-label="What the AI understood">
                  {t.recognized.map(([k, v]) => (
                    <li key={k + v}>
                      <span>{k}</span> {v}
                    </li>
                  ))}
                </ul>
                {answered ? (
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
          <div ref={endRef} />
        </div>

        <aside className="cv-side" aria-label="Your side">
          {!showOwner ? (
            <>
              <p className="cv-side-title">Watch the customer’s side</p>
              <p className="cv-side-text">Send the customer’s next message and see what the AI understands, which of your rules apply, and what it answers.</p>
              <button type="button" className="btn btn-primary btn-block" onClick={send} disabled={!next} aria-busy={phase === 'thinking' || undefined} ref={live} data-send>
                {sent === 0 ? 'Send the first message' : next ? 'Send the next message' : 'Conversation complete'}
                {next && <Icon name="arrow" size={16} />}
              </button>
              {next && <p className="cv-preview">“{next.customer}”</p>}
              {finished && (
                <button type="button" className="btn btn-ghost btn-block" onClick={() => setShowOwner(true)} data-owner>
                  See what you’d see
                </button>
              )}
              <div className="cv-side-actions">
                <button type="button" className="link-btn" onClick={() => reset()} disabled={sent === 0}>
                  <Icon name="reset" size={14} /> Start over
                </button>
                {onSwitchMode && (
                  <button type="button" className="link-btn" onClick={onSwitchMode}>
                    Try the booking page instead →
                  </button>
                )}
              </div>
            </>
          ) : (
            <OwnerCard outcome={turns[turns.length - 1].done} business={scenario.business} onBack={() => setShowOwner(false)} onReset={() => reset()} />
          )}
        </aside>
      </div>
      <p className="cv-fine">
        Replies are scripted examples of how the AI receptionist behaves. In the product it checks your real calendar, follows the rules you set in Teach Your AI, and never books without the customer’s own yes. Texting, email reminders and automatic
        follow-ups aren’t shown because they aren’t live yet.
      </p>
    </div>
  )
}

function OwnerCard({ outcome, business, onBack, onReset }) {
  const [status, line, actions] = ownerView(outcome)
  return (
    <div className="cv-owner" role="region" aria-label="Your dashboard">
      <p className="cv-side-title">Your dashboard · {business}</p>
      <p className="cv-owner-status">{status}</p>
      <p className="cv-owner-line">{line}</p>
      <ul className="cv-owner-actions">
        {actions.map((a) => (
          <li key={a}>
            <Icon name="tick" size={14} /> {a}
          </li>
        ))}
      </ul>
      <p className="cv-side-text">Every conversation shows what was said, what the AI did, and the outcome. Nothing you’d see here involves a real customer.</p>
      <div className="cv-side-actions">
        <button type="button" className="link-btn" onClick={onBack}>
          ← Back to the conversation
        </button>
        <button type="button" className="link-btn" onClick={onReset}>
          <Icon name="reset" size={14} /> Start over
        </button>
      </div>
    </div>
  )
}
