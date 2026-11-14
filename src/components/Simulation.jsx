import { useEffect, useRef, useState } from 'react'
import Icon from './Icon.jsx'
import SectionHeading from './SectionHeading.jsx'
import { steps } from '../content/site.js'
import { scenarios, stageNotes } from '../content/simulation.js'

const STEP_MS = 1400
const senderLabel = { system: 'System event', bot: 'GetShowUps assistant', lead: 'Lead' }

export default function Simulation() {
  const [scenarioId, setScenarioId] = useState(scenarios[0].id)
  const [shown, setShown] = useState(1)
  const [playRequested, setPlaying] = useState(false)
  const logRef = useRef(null)

  const scenario = scenarios.find((s) => s.id === scenarioId)
  const total = scenario.events.length
  const visible = scenario.events.slice(0, shown)
  const current = visible[visible.length - 1]
  const stageIndex = steps.findIndex((s) => s.id === current.stage)
  const done = shown >= total
  const note = stageNotes[current.stage]
  const playing = playRequested && !done

  useEffect(() => {
    if (!playing) return
    const t = setTimeout(() => setShown((n) => n + 1), STEP_MS)
    return () => clearTimeout(t)
  }, [playing, shown])

  useEffect(() => {
    const el = logRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [shown, scenarioId])

  const selectScenario = (id) => {
    setScenarioId(id)
    setShown(1)
    setPlaying(false)
  }
  const next = () => setShown((n) => Math.min(n + 1, total))
  const reset = () => {
    setShown(1)
    setPlaying(false)
  }
  const togglePlay = () => {
    if (done) {
      setShown(1)
      setPlaying(true)
    } else {
      setPlaying(!playing)
    }
  }

  return (
    <section id="simulation" className="section section--dark" aria-labelledby="sim-title">
      <div className="container">
        <SectionHeading
          id="sim-title"
          eyebrow="Interactive simulation"
          title="Watch one lead go from inquiry to appointment"
          intro="Step through a scripted example to see each stage of the workflow in action."
        />

        <p className="sim-disclaimer" role="note">
          <strong>Simulation only.</strong> Fictional business, scripted messages, sample data. Nothing here is sent,
          stored, or connected to a live system. Text messaging and automatic reminders are coming soon; today
          GetShowUps handles lead capture, service-area screening, calendar booking and show-up tracking.
        </p>

        <div className="sim">
          <div className="sim-toolbar">
            <div className="segmented" role="group" aria-label="Choose a scenario">
              {scenarios.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  aria-pressed={s.id === scenarioId}
                  onClick={() => selectScenario(s.id)}
                >
                  {s.label}
                </button>
              ))}
            </div>
            <div className="sim-controls">
              <button type="button" className="btn btn-ghost btn-sm" onClick={reset} disabled={shown === 1}>
                <Icon name="reset" size={16} /> Reset
              </button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={togglePlay}>
                <Icon name={playing ? 'pause' : 'play'} size={16} /> {playing ? 'Pause' : done ? 'Replay' : 'Play'}
              </button>
              <button type="button" className="btn btn-primary btn-sm" onClick={next} disabled={done || playing}>
                Next step <Icon name="next" size={16} />
              </button>
            </div>
          </div>

          <ol className="sim-stages" aria-label="Workflow progress">
            {steps.map((s, i) => {
              const state = i < stageIndex ? 'done' : i === stageIndex ? 'active' : 'todo'
              return (
                <li key={s.id} className={`sim-stage is-${state}`} aria-current={state === 'active' ? 'step' : undefined}>
                  <span className="sim-stage-dot">
                    {state === 'done' ? <Icon name="tick" size={12} strokeWidth={3} /> : i + 1}
                  </span>
                  <span className="sim-stage-label">{s.title}</span>
                </li>
              )
            })}
          </ol>

          <div className="sim-body">
            <div className="sim-phone">
              <div className="sim-phone-head">
                <span className="sim-avatar" aria-hidden="true">
                  {scenario.business[0]}
                </span>
                <div>
                  <p className="sim-phone-title">{scenario.business}</p>
                  <p className="sim-phone-sub">Fictional example · SMS thread with {scenario.contact}</p>
                </div>
              </div>
              <ol className="sim-log" ref={logRef} aria-live="polite" aria-label="Simulated conversation">
                {visible.map((e, i) => (
                  <li key={`${scenarioId}-${i}`} className={`msg msg--${e.from}${i > 0 ? " msg--enter" : ""}`}>
                    {e.day && <p className="msg-day">{e.day}</p>}
                    <div className="msg-bubble">
                      <span className="visually-hidden">{senderLabel[e.from]}: </span>
                      {e.text}
                    </div>
                    <p className="msg-meta">
                      {e.from !== 'system' && <span>{e.from === 'bot' ? 'Assistant' : scenario.contact} · </span>}
                      {e.time}
                    </p>
                  </li>
                ))}
              </ol>
              <p className="sim-progress">
                Step {shown} of {total}
              </p>
            </div>

            <aside className="sim-explain" aria-label="What is happening">
              <p className="sim-explain-stage">
                Stage {stageIndex + 1} · {steps[stageIndex].title}
              </p>
              <h3>What’s happening</h3>
              <p>{note.what}</p>
              <h3>In GetShowUps today</h3>
              <p className="sim-explain-today">{note.today}</p>
              {done && (
                <a href="#book-demo" className="btn btn-primary btn-block sim-cta">
                  See it with your business: book a call
                </a>
              )}
            </aside>
          </div>
        </div>
      </div>
    </section>
  )
}
