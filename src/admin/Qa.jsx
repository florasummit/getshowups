// Control Center → Testing: guided human QA on the SAME journey definitions as automation (server/ops/journeys.js),
// one step at a time, saved to the server after every step (so a session can be paused and resumed), reviewed when
// finished. Plus automated run history (Playwright, mocked vs real providers) and the activation measurement.
// Observations only: nothing here changes a business, a message or a setting.
import { useEffect, useMemo, useState } from 'react'
import { api } from '../lib/api.js'
import { Badge, Empty, Facts, Link, LoadError, Loading, PageHead, Section } from './control/ui.jsx'
import { ago, mins, plural, when } from './control/lib.js'

const RUN = { passed: ['ok', 'Passed'], failed: ['bad', 'Failed'], blocked: ['warn', 'Incomplete'], running: ['info', 'In progress'] }
const RESULT = { pass: ['ok', 'Pass'], fail: ['bad', 'Fail'], blocked: ['warn', 'Blocked'], not_tested: ['neutral', 'Not tested'] }
const USABILITY = [
  ['keep', 'Keep', 'Works well as it is'],
  ['simplify', 'Simplify', 'Too many steps or words'],
  ['change', 'Change', 'Confusing or misleading'],
  ['remove', 'Remove', 'Not needed'],
  ['add', 'Add', 'Something is missing'],
]
const USABILITY_LABEL = Object.fromEntries(USABILITY.map(([id, l]) => [id, l]))
const Provider = ({ p }) => <Badge tone={p === 'real' ? 'info' : 'neutral'}>{p === 'real' ? 'Real providers' : 'Mocked providers'}</Badge>
const RunStatus = ({ s }) => <Badge tone={RUN[s]?.[0] || 'neutral'}>{RUN[s]?.[1] || s}</Badge>
const Result = ({ s }) => <Badge tone={RESULT[s]?.[0] || 'neutral'}>{RESULT[s]?.[1] || s}</Badge>
const crumbs = [
  ['Control Center', {}],
  ['Testing', { view: 'qa' }],
]

function useQa(reload = 0) {
  const [q, setQ] = useState(null)
  useEffect(() => {
    let live = true
    api('/api/platform/qa').then(({ status, data }) => live && setQ(status === 200 ? data : { error: true }))
    return () => {
      live = false
    }
  }, [reload])
  return q
}

// ---------- start a session ----------
function StartSession({ j, businesses, preset, go, open, onOpen }) {
  const tests = businesses.filter((b) => b.test)
  const [customer, setCustomer] = useState(preset && businesses.some((b) => b.id === preset) ? preset : '')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const start = async () => {
    setBusy(true)
    setErr('')
    const { status, data } = await api('/api/platform/qa', { method: 'POST', body: { action: 'start', journey: j.id, customer: customer || null } })
    setBusy(false)
    if (status !== 200) return setErr(status === 429 ? 'Too many QA actions just now. Try again in a minute.' : 'The session couldn’t start. Nothing was recorded.')
    go({ session: data.id })
  }
  if (!open)
    return (
      <div className="cc-actions">
        <button type="button" className="btn btn-quiet btn-sm" onClick={onOpen} aria-label={`Start guided QA: ${j.title.replace(/ \(target.*\)$/, '')}`}>
          Start session
        </button>
      </div>
    )
  return (
    <div className="stack" data-start={j.id}>
      <label className="field" htmlFor={`qa-biz-${j.id}`}>
        <span>Test account used (optional)</span>
        <select id={`qa-biz-${j.id}`} value={customer} onChange={(e) => setCustomer(e.target.value)}>
          <option value="">None / not tied to one account</option>
          {tests.length > 0 && (
            <optgroup label="Test accounts">
              {tests.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name} ({b.id})
                </option>
              ))}
            </optgroup>
          )}
          {preset && !businesses.find((b) => b.id === preset)?.test && businesses.some((b) => b.id === preset) && (
            <optgroup label="Selected account">
              <option value={preset}>{businesses.find((b) => b.id === preset).name}</option>
            </optgroup>
          )}
        </select>
      </label>
      {j.note && <p className="cc-status-line">{j.note}</p>}
      {err && (
        <p className="form-error" role="alert">
          {err}
        </p>
      )}
      <div className="cc-actions">
        <button type="button" className="btn btn-primary btn-sm" onClick={start} disabled={busy}>
          {busy ? 'Starting…' : 'Begin'}
        </button>
      </div>
    </div>
  )
}

// ---------- the Testing home ----------
export default function Testing({ o, params, go }) {
  const q = useQa()
  const [opening, setOpening] = useState(params.journey || (params.for ? 'activation' : null))
  if (!q) return <Loading label="Loading testing…" />
  if (q.error) return <LoadError what="testing" />
  const head = <PageHead go={go} crumbs={[crumbs[0]]} title="Testing" lede="Guided tests for real people, automated test history, and the 20-minute activation target. Results are observations; nothing here changes an account." />
  if (!q.available)
    return (
      <>
        {head}
        <Empty title="Testing isn’t available yet.">The QA tables (migration 0032) aren’t applied in this environment.</Empty>
      </>
    )
  const running = q.human.filter((r) => r.status === 'running')
  const finished = q.human.filter((r) => r.status !== 'running')
  const titleOf = (id) => q.journeys.find((j) => j.id === id)?.title || id
  const journeys = params.journey ? [...q.journeys].sort((a, b) => (b.id === params.journey) - (a.id === params.journey)) : q.journeys
  return (
    <div className="cc-main" data-testing>
      {head}
      <Section title="Activation: first owner to a live booking in ≤ 20 minutes" id="qa-act">
        <div className="cc-section-body">
          {q.activation.measured ? (
            <p data-activation="measured">
              <strong>{q.activation.latest.totalMinutes} min</strong> in the latest observer-recorded run ({RUN[q.activation.latest.status]?.[1] || q.activation.latest.status}, {when(q.activation.latest.finishedAt)}). {plural(q.activation.runs, 'run')} recorded.{' '}
              <Link to={{ run: q.activation.latest.id }} go={go} className="cc-more">
                Open the run →
              </Link>
            </p>
          ) : (
            <div className="cc-callout" data-activation="not-measured">
              <strong>Not measured yet.</strong>
              <span>No real person has completed an observed activation run. Automated tests never count as this measurement.</span>
            </div>
          )}
          <details className="cc-details">
            <summary>How to run the 20-minute test safely</summary>
            <ol className="cc-status-line" style={{ display: 'grid', gap: 6, paddingLeft: 20 }}>
              <li>Get approval for a tester who has never seen GetShowUps, and their written consent to screen recording.</li>
              <li>Their email must be on the test-recipient list (approval and a redeploy): that is what lets them through while public signup stays closed. This is authorized test onboarding, never “public signup works”.</li>
              <li>Stripe stays in test mode: give them card 4242 4242 4242 4242.</li>
              <li>On your own screen, start a session for “New owner activation” below when they first see getshowups.com. The clock runs on the server.</li>
              <li>Record each step as they finish it. Don’t help unless they’re stuck for 2 minutes, and note it if you do.</li>
              <li>Afterwards, mark their business as a test account in the admin console and remove them from the test-recipient list.</li>
            </ol>
            <p className="cc-status-line">Full script: docs/ACTIVATION_TEST.md · approvals: docs/OPERATIONAL_ACTIVATION.md §4.</p>
          </details>
        </div>
      </Section>
      {running.length > 0 && (
        <Section title={`In progress (${running.length})`} id="qa-running" sub="Saved after every step. Resume where you left off.">
          <ul className="cc-list">
            {running.map((r) => (
              <li key={r.id}>
                <Link to={{ session: r.id }} go={go} className="cc-item" data-qa-running={r.id}>
                  <span className="cc-item-main">
                    <span className="cc-item-title">{titleOf(r.journey)}</span>
                    <span className="cc-item-sub">
                      Started {ago(r.startedAt)}
                      {r.customer ? ` · ${r.customer}` : ''}
                    </span>
                  </span>
                  <span className="cc-item-meta">
                    <RunStatus s="running" />
                    <span className="btn btn-quiet btn-sm">Resume</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </Section>
      )}
      <Section title="Guided tests" id="qa-journeys" sub="Pick a journey, start a session and follow it step by step. Each step asks what to do, what should happen, and what actually happened.">
        <div className="cc-section-body">
          <div className="qa-journeys">
            {journeys.map((j) => (
              <article key={j.id} className="qa-journey" data-qa-journey={j.id}>
                <div className="cc-head-row">
                  <h3>{j.title}</h3>
                  {j.timed && <Badge tone="info">Timed</Badge>}
                </div>
                {j.purpose && <p>{j.purpose}</p>}
                <p>
                  {plural(j.steps.length, 'step')} · {plural(j.tests.length, 'linked automated test')}
                </p>
                <StartSession j={j} businesses={o.businesses} preset={params.for} go={go} open={opening === j.id} onOpen={() => setOpening(j.id)} />
              </article>
            ))}
          </div>
        </div>
      </Section>
      <Section title="Completed sessions" id="qa-human">
        {finished.length ? (
          <ul className="cc-list">
            {finished.map((r) => (
              <li key={r.id}>
                <Link to={{ run: r.id }} go={go} className="cc-item" data-qa-human={r.id}>
                  <span className="cc-item-main">
                    <span className="cc-item-title">{titleOf(r.journey)}</span>
                    <span className="cc-item-sub">
                      {when(r.finishedAt || r.startedAt)} · {r.summary.pass ?? 0} pass · {r.summary.fail ?? 0} fail · {r.summary.blocked ?? 0} blocked · {r.summary.not_tested ?? 0} not tested
                      {r.summary.totalMs != null ? ` · ${mins(r.summary.totalMs)}` : ''}
                    </span>
                  </span>
                  <span className="cc-item-meta">
                    <RunStatus s={r.status} />
                    <span className="cc-chev" aria-hidden="true">
                      ›
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <Empty title="No completed sessions yet.">Finished guided tests appear here with every observation and finding.</Empty>
        )}
      </Section>
      <Section title="Automated runs" id="qa-auto" sub="Playwright browser tests against mocked providers (fake Google, Stripe and messaging). They check mechanics, not real-person experience.">
        {q.failedJourneys.length > 0 && (
          <div className="cc-section-body">
            <div className="cc-callout cc-callout--warn">
              <strong>Failing journeys (latest automated result)</strong>
              <span>{q.failedJourneys.map(titleOf).join(', ')}</span>
            </div>
          </div>
        )}
        {q.automated.length ? (
          <ul className="cc-list">
            {q.automated.map((r) => (
              <li key={r.id}>
                <Link to={{ run: r.id }} go={go} className="cc-item" data-qa-auto={r.id}>
                  <span className="cc-item-main">
                    <span className="cc-item-title">
                      {r.source === 'ci' ? 'CI run' : 'Local run'} {r.revision ? <span className="cc-code">{r.revision.slice(0, 7)}</span> : null}
                    </span>
                    <span className="cc-item-sub">
                      {when(r.startedAt)} · {r.summary.pass ?? 0} passed · {r.summary.fail ?? 0} failed · {r.summary.not_tested ?? 0} skipped
                    </span>
                  </span>
                  <span className="cc-item-meta">
                    <Provider p={r.provider} />
                    <RunStatus s={r.status} />
                    <span className="cc-chev" aria-hidden="true">
                      ›
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <Empty title="CI isn’t connected yet." data-qa-auto-empty>
            No automated runs recorded. Connecting CI needs a token and a workflow change (approval): see docs/QA_CI_SETUP.md.
          </Empty>
        )}
      </Section>
    </div>
  )
}

// ---------- one guided session (step by step) ----------
function StepForm({ run, step, index, total, saved, timed, onSaved, onNav, onPause }) {
  const [status, setStatus] = useState(saved?.status || '')
  const [observed, setObserved] = useState(saved?.observed || '')
  const [answers, setAnswers] = useState(() => Object.fromEntries(Object.entries(saved?.answers || {}).filter(([k]) => /^\d$/.test(k))))
  const [usability, setUsability] = useState(saved?.answers?.u || '')
  const [usabilityNote, setUsabilityNote] = useState(saved?.answers?.un || '')
  const [finding, setFinding] = useState({ type: 'defect', severity: 'medium', text: '' })
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)
  const id = `qs-${step.id}`
  const save = async (advance) => {
    if (!status) return setMsg('Choose a result first (Pass, Fail, Blocked or Not tested).')
    setBusy(true)
    const { status: code, data } = await api('/api/platform/qa', { method: 'POST', body: { action: 'step', run: run.id, step: step.id, status, observed, answers, usability: usability || null, usabilityNote } })
    setBusy(false)
    if (code !== 200) return setMsg(code === 409 ? 'This session is already finished.' : 'Not saved. Check your connection and try again.')
    onSaved(step.id, { status, observed, answers: { ...answers, ...(usability ? { u: usability } : {}), ...(usabilityNote.trim() ? { un: usabilityNote.trim() } : {}) }, ms: data.ms })
    setMsg(`Saved: ${RESULT[status][1]}${timed && data.ms != null ? ` (${mins(data.ms)} on this step)` : ''}.`)
    if (advance) onNav(index + 1)
  }
  const addFinding = async () => {
    const { status: code } = await api('/api/platform/qa', { method: 'POST', body: { action: 'finding', run: run.id, step: step.id, type: finding.type, severity: finding.type === 'defect' ? finding.severity : null, text: finding.text } })
    setMsg(code === 200 ? `${finding.type === 'defect' ? 'Defect' : 'Improvement'} saved.` : 'Not saved. Try again.')
    if (code === 200) setFinding((f) => ({ ...f, text: '' }))
  }
  return (
    <section className="qa-step" data-qa-step={step.id} data-recorded={saved?.status || ''} aria-labelledby={`${id}-h`}>
      <div className="qa-step-head">
        <span className="cc-label">
          Step {index + 1} of {total}
        </span>
        <h2 id={`${id}-h`} tabIndex={-1} data-step-heading>
          {step.title}
        </h2>
      </div>
      <div className="qa-do">
        <div className="cc-callout">
          <span className="cc-label">What to do</span>
          <span>{step.action}</span>
        </div>
        <div className="cc-callout">
          <span className="cc-label">Expected result</span>
          <span>{step.expected}</span>
        </div>
      </div>
      <label className="field" htmlFor={`${id}-obs`}>
        <span>What actually happened</span>
        <textarea id={`${id}-obs`} rows={3} maxLength={500} value={observed} onChange={(e) => setObserved(e.target.value)} placeholder="Describe what you saw. No customer names, emails or phone numbers." />
      </label>
      <fieldset className="qa-group">
        <legend>Does it work? (functional result)</legend>
        <div className="qa-options" role="radiogroup" aria-label={`Result for ${step.title}`}>
          {['pass', 'fail', 'blocked', 'not_tested'].map((s) => (
            <label key={s} className={`qa-option qa-option--${s}`}>
              <input type="radio" name={`${id}-result`} value={s} checked={status === s} onChange={() => setStatus(s)} />
              <span>{RESULT[s][1]}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset className="qa-group">
        <legend>How should this step change? (usability, separate from the result)</legend>
        <div className="qa-options">
          {USABILITY.map(([v, label, hint]) => (
            <label key={v} className="qa-option" title={hint}>
              <input type="radio" name={`${id}-usability`} value={v} checked={usability === v} onChange={() => setUsability(v)} />
              <span>{label}</span>
            </label>
          ))}
        </div>
        <label className="field" htmlFor={`${id}-un`}>
          <span>Usability note (optional)</span>
          <textarea id={`${id}-un`} rows={2} maxLength={300} value={usabilityNote} onChange={(e) => setUsabilityNote(e.target.value)} />
        </label>
      </fieldset>
      {step.ask.length > 0 && (
        <details className="cc-details">
          <summary>Context questions ({step.ask.length})</summary>
          <div className="stack">
            {step.ask.map((qq, k) => (
              <label key={k} className="field" htmlFor={`${id}-q${k}`}>
                <span>{qq}</span>
                <textarea id={`${id}-q${k}`} rows={1} maxLength={300} value={answers[k] || ''} onChange={(e) => setAnswers((a) => ({ ...a, [k]: e.target.value }))} />
              </label>
            ))}
          </div>
        </details>
      )}
      <details className="cc-details">
        <summary>Report a defect or improvement</summary>
        <div className="stack">
          <div className="field-row">
            <label className="field" htmlFor={`${id}-ft`}>
              <span>Type</span>
              <select id={`${id}-ft`} value={finding.type} onChange={(e) => setFinding((f) => ({ ...f, type: e.target.value }))}>
                <option value="defect">Defect (something is wrong)</option>
                <option value="improvement">Improvement (works, could be better)</option>
              </select>
            </label>
            {finding.type === 'defect' && (
              <label className="field" htmlFor={`${id}-fs`}>
                <span>Severity</span>
                <select id={`${id}-fs`} value={finding.severity} onChange={(e) => setFinding((f) => ({ ...f, severity: e.target.value }))}>
                  <option value="critical">Critical</option>
                  <option value="high">High</option>
                  <option value="medium">Medium</option>
                  <option value="low">Low</option>
                </select>
              </label>
            )}
          </div>
          <label className="field" htmlFor={`${id}-fx`}>
            <span>Describe it (no customer details)</span>
            <textarea id={`${id}-fx`} rows={2} maxLength={1000} value={finding.text} onChange={(e) => setFinding((f) => ({ ...f, text: e.target.value }))} />
          </label>
          <div>
            <button type="button" className="btn btn-quiet btn-sm" onClick={addFinding} disabled={!finding.text.trim()}>
              Save finding
            </button>
          </div>
        </div>
      </details>
      <p className="cc-status-line" role="status" aria-live="polite" data-step-msg>
        {msg}
      </p>
      <div className="qa-nav">
        <div className="cc-actions">
          <button type="button" className="btn btn-quiet btn-sm" onClick={() => onNav(index - 1)} disabled={index === 0}>
            ← Previous
          </button>
          <button type="button" className="btn btn-quiet btn-sm" onClick={onPause}>
            Pause session
          </button>
        </div>
        <div className="cc-actions">
          <button type="button" className="btn btn-quiet btn-sm" onClick={() => save(false)} disabled={busy}>
            Save
          </button>
          <button type="button" className="btn btn-primary btn-sm" onClick={() => save(true)} disabled={busy}>
            {index + 1 < total ? 'Save and continue →' : 'Save and review →'}
          </button>
        </div>
      </div>
    </section>
  )
}

export function Session({ id, go }) {
  const [d, setD] = useState(null)
  const [results, setResults] = useState({})
  const [index, setIndex] = useState(null)
  const [now, setNow] = useState(() => Date.now())
  const [finishing, setFinishing] = useState(false)
  const [err, setErr] = useState('')
  useEffect(() => {
    let live = true
    api(`/api/platform/qa?run=${encodeURIComponent(id)}`).then(({ status, data }) => {
      if (!live) return
      if (status !== 200 || data.run.kind !== 'human') return setD({ error: status === 404 ? 'not_found' : 'failed' })
      if (data.run.status !== 'running') return go({ run: id }, { replace: true })
      const r = Object.fromEntries(data.results.map((x) => [x.step, x]))
      setResults(r)
      setD(data)
      const first = data.journey.steps.findIndex((s) => !r[s.id])
      setIndex(first === -1 ? data.journey.steps.length : first)
    })
    return () => {
      live = false
    }
  }, [id, go])
  const timed = d?.journey?.timed
  useEffect(() => {
    if (!timed) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [timed])
  const nav = (k) => {
    setIndex(Math.max(0, Math.min(k, d.journey.steps.length)))
    requestAnimationFrame(() => document.querySelector('[data-step-heading]')?.focus({ preventScroll: false }))
  }
  if (!d) return <Loading label="Loading session…" />
  if (d.error) return d.error === 'not_found' ? <Empty title="Session not found.">It may have been removed by retention (365 days).</Empty> : <LoadError what="this session" />
  const steps = d.journey.steps
  const done = steps.filter((s) => results[s.id]).length
  const finish = async () => {
    setErr('')
    const { status } = await api('/api/platform/qa', { method: 'POST', body: { action: 'finish', run: id } })
    if (status !== 200 && status !== 409) return setErr('Couldn’t finish the session. Your saved steps are kept; try again.')
    go({ run: id }, { replace: true })
  }
  return (
    <div className="cc-main" data-qa-run={id} data-session>
      <PageHead go={go} crumbs={crumbs} title={d.journey.title}>
        <RunStatus s="running" />
        {d.run.customer && <Badge tone="neutral">{d.run.customer}</Badge>}
      </PageHead>
      <div className="qa-run">
        <aside className="qa-progress" aria-label="Session progress">
          {timed && (
            <p className="qa-timer" data-elapsed>
              {mins(now - d.run.startedAt)} <small>/ target {d.journey.targetMinutes}:00 · server clock, keeps running while paused</small>
            </p>
          )}
          <p className="cc-status-line">
            {done} of {steps.length} steps recorded
          </p>
          <div className="qa-bar" aria-hidden="true">
            <span style={{ width: `${(done / steps.length) * 100}%` }} />
          </div>
          <ol className="qa-steps">
            {steps.map((s, k) => {
              const r = results[s.id]
              return (
                <li key={s.id}>
                  <button type="button" aria-current={index === k ? 'step' : undefined} onClick={() => nav(k)} data-nav-step={s.id}>
                    <span className={`qa-dot ${r ? `qa-dot--${r.status}` : ''}`} aria-hidden="true">
                      {r ? (r.status === 'pass' ? '✓' : r.status === 'fail' ? '✕' : r.status === 'blocked' ? '!' : '–') : k + 1}
                    </span>
                    <span>
                      {s.title}
                      <span className="sr-only">{r ? `: ${RESULT[r.status][1]}` : ': not recorded'}</span>
                    </span>
                  </button>
                </li>
              )
            })}
            <li>
              <button type="button" aria-current={index === steps.length ? 'step' : undefined} onClick={() => nav(steps.length)}>
                <span className="qa-dot" aria-hidden="true">
                  ✓
                </span>
                <span>Review and finish</span>
              </button>
            </li>
          </ol>
        </aside>
        <div>
          {index < steps.length ? (
            <StepForm
              key={steps[index].id}
              run={d.run}
              step={steps[index]}
              index={index}
              total={steps.length}
              saved={results[steps[index].id]}
              timed={timed}
              onSaved={(sid, r) => setResults((x) => ({ ...x, [sid]: r }))}
              onNav={nav}
              onPause={() => go({ view: 'qa' })}
            />
          ) : (
            <section className="qa-step" data-qa-review>
              <div className="qa-step-head">
                <span className="cc-label">Review</span>
                <h2 tabIndex={-1} data-step-heading>
                  {done === steps.length ? 'All steps recorded' : `${plural(steps.length - done, 'step')} not recorded yet`}
                </h2>
              </div>
              <ul className="cc-list">
                {steps.map((s, k) => (
                  <li key={s.id}>
                    <button type="button" className="cc-item" onClick={() => nav(k)}>
                      <span className="cc-item-main">
                        <span className="cc-item-title">{s.title}</span>
                        {results[s.id]?.observed && <span className="cc-item-sub">{results[s.id].observed}</span>}
                      </span>
                      <span className="cc-item-meta">{results[s.id] ? <Result s={results[s.id].status} /> : <Badge tone="neutral">Not recorded</Badge>}</span>
                    </button>
                  </li>
                ))}
              </ul>
              {done < steps.length && <p className="cc-status-line">Steps you don’t record count as “Not tested”, so the session will be marked Incomplete. You can also pause and come back.</p>}
              {err && (
                <p className="form-error" role="alert">
                  {err}
                </p>
              )}
              <div className="qa-nav">
                <button type="button" className="btn btn-quiet btn-sm" onClick={() => go({ view: 'qa' })}>
                  Pause session
                </button>
                {finishing ? (
                  <div className="cc-actions">
                    <span className="cc-status-line">Finishing locks the results.</span>
                    <button type="button" className="btn btn-quiet btn-sm" onClick={() => setFinishing(false)}>
                      Cancel
                    </button>
                    <button type="button" className="btn btn-primary btn-sm" onClick={finish}>
                      Finish session
                    </button>
                  </div>
                ) : (
                  <button type="button" className="btn btn-primary btn-sm" onClick={() => setFinishing(true)}>
                    Finish session…
                  </button>
                )}
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  )
}

// ---------- a finished (or automated) run ----------
export function RunReview({ id, go }) {
  const [d, setD] = useState(null)
  const [hist, setHist] = useState({})
  useEffect(() => {
    let live = true
    api(`/api/platform/qa?run=${encodeURIComponent(id)}`).then(({ status, data }) => live && setD(status === 200 ? data : { error: status === 404 ? 'not_found' : 'failed' }))
    return () => {
      live = false
    }
  }, [id])
  const byStep = useMemo(() => Object.fromEntries((d?.results || []).map((r) => [r.step, r])), [d])
  if (!d) return <Loading label="Loading results…" />
  if (d.error) return d.error === 'not_found' ? <Empty title="Run not found.">It may have been removed by retention.</Empty> : <LoadError what="this run" />
  const r = d.run
  const human = r.kind === 'human'
  const history = async (t) => {
    const { data } = await api(`/api/platform/qa?test=${encodeURIComponent(t)}`)
    setHist((h) => ({ ...h, [t]: data.history || [] }))
  }
  return (
    <div className="cc-main" data-run={r.id}>
      <PageHead go={go} crumbs={crumbs} title={human ? d.journey?.title || r.journey : `Automated run${r.revision ? ` · ${r.revision.slice(0, 7)}` : ''}`}>
        <RunStatus s={r.status} />
        {human ? <Badge tone="info">Human-observed</Badge> : <Provider p={r.provider} />}
      </PageHead>
      {r.status === 'running' && (
        <div className="cc-callout cc-callout--next">
          <strong>This session is still in progress.</strong>
          <Link to={{ session: r.id }} go={go} className="btn btn-primary btn-sm" style={{ justifySelf: 'start' }}>
            Resume session
          </Link>
        </div>
      )}
      <Facts
        items={[
          ['Started', when(r.startedAt)],
          r.finishedAt && ['Finished', when(r.finishedAt)],
          human ? ['Kind', 'Human-observed'] : ['Source', r.source === 'ci' ? 'CI' : 'Local'],
          ['Pass', String(r.summary.pass ?? 0)],
          ['Fail', String(r.summary.fail ?? 0)],
          [human ? 'Blocked / not tested' : 'Skipped', human ? `${r.summary.blocked ?? 0} / ${r.summary.not_tested ?? 0}` : String(r.summary.not_tested ?? 0)],
          r.summary.totalMs != null && ['Total time', `${mins(r.summary.totalMs)} (target ${r.summary.targetMinutes} min)`],
          r.customer && ['Test account', r.customer],
        ]}
      />
      {r.artifactsUrl && (
        <a className="cc-more" href={r.artifactsUrl} target="_blank" rel="noreferrer">
          Screenshots and traces (CI artifacts) ↗
        </a>
      )}
      {d.related?.length > 0 && (
        <Section title="Related open incidents" id="qa-rel">
          <ul className="cc-list">
            {d.related.map((i) => (
              <li key={i.id}>
                <Link to={{ incident: i.id }} go={go} className="cc-item">
                  <span className="cc-item-main">
                    <span className="cc-item-title">{i.title}</span>
                    <span className="cc-item-sub">
                      {i.customer || 'Platform-wide'} · <span className="cc-code">{i.code}</span>
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </Section>
      )}
      <Section title={human ? 'Steps' : 'Results'} id="qa-res">
        {human ? (
          <ul className="cc-list">
            {(d.journey?.steps || []).map((s) => {
              const x = byStep[s.id]
              return (
                <li key={s.id} className="cc-item" style={{ cursor: 'default' }} data-test={`${r.journey}.${s.id}`} data-result={x?.status || 'not_tested'}>
                  <span className="cc-item-main">
                    <span className="cc-item-title">{s.title}</span>
                    <span className="cc-item-sub">Expected: {s.expected}</span>
                    {x?.observed && <span className="cc-item-sub">Observed: {x.observed}</span>}
                    {x?.answers?.u && (
                      <span className="cc-item-sub" data-usability={x.answers.u}>
                        Usability: <strong>{USABILITY_LABEL[x.answers.u]}</strong>
                        {x.answers.un ? ` · ${x.answers.un}` : ''}
                      </span>
                    )}
                    {s.ask.map((qq, k) => (x?.answers?.[k] ? <span key={k} className="cc-item-sub">{`${qq} ${x.answers[k]}`}</span> : null))}
                  </span>
                  <span className="cc-item-meta">
                    {x ? <Result s={x.status} /> : <Badge tone="neutral">Not recorded</Badge>}
                    {x?.ms != null && <span className="cc-status-line">{mins(x.ms)}</span>}
                  </span>
                </li>
              )
            })}
          </ul>
        ) : d.results.length ? (
          <ul className="cc-list">
            {d.results.map((x) => (
              <li key={x.test_id} className="cc-item" style={{ cursor: 'default' }} data-test={x.test_id} data-result={x.status}>
                <span className="cc-item-main">
                  <span className="cc-item-title">{x.test_id.replace(/@.*/, '')}</span>
                  {x.observed && <span className="cc-item-sub">{x.observed}</span>}
                  {hist[x.test_id] && (
                    <ol className="cc-timeline" aria-label="Retest history">
                      {hist[x.test_id].map((h) => (
                        <li key={h.run_id}>
                          <time>{when(h.at)}</time>
                          <span>
                            {RESULT[h.status][1]} · {h.revision ? h.revision.slice(0, 7) : '—'} · {h.provider}
                          </span>
                        </li>
                      ))}
                    </ol>
                  )}
                </span>
                <span className="cc-item-meta">
                  <Result s={x.status} />
                  <button type="button" className="btn btn-quiet btn-sm" onClick={() => history(x.test_id)}>
                    Retest history
                  </button>
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <Empty title="No linked results stored.">Only tests linked to a journey, and failures, are kept.</Empty>
        )}
      </Section>
      <Section title="Defects and improvements" id="qa-find">
        {d.findings.length ? (
          <ul className="cc-list">
            {d.findings.map((f) => (
              <li key={f.id} className="cc-item" style={{ cursor: 'default' }} data-finding={f.type}>
                <span className="cc-item-main">
                  <span className="cc-item-title">{f.text}</span>
                  <span className="cc-item-sub">{f.step ? d.journey?.steps.find((s) => s.id === f.step)?.title || f.step : 'Whole journey'}</span>
                </span>
                <span className="cc-item-meta">
                  <Badge tone={f.type === 'defect' ? 'bad' : 'info'}>{f.type === 'defect' ? `Defect · ${f.severity}` : 'Improvement'}</Badge>
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <Empty title="None reported." />
        )}
      </Section>
    </div>
  )
}
