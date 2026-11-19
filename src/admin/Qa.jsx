// Control Center → QA: automated run history (Playwright results, mocked vs real providers), run detail with retest
// history and related incidents, and guided human QA on the SAME journey definitions as automation. Timed journeys
// (activation, ≤ 20 min) record step times on the server clock. Observations only: nothing here changes a business.
import { useEffect, useState } from 'react'
import { api, fmt } from '../lib/api.js'

const when = (ms) => (ms ? fmt(new Date(ms).toISOString(), undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—')
const mins = (ms) => (ms == null ? '—' : `${Math.floor(ms / 60000)}:${String(Math.round((ms % 60000) / 1000)).padStart(2, '0')}`)
const RUN_TAG = { passed: 'tag--ok', failed: 'tag--bad', blocked: 'tag--warn', running: 'tag--info' }
const RES_TAG = { pass: 'tag--ok', fail: 'tag--bad', blocked: 'tag--warn', not_tested: '' }
const RES_LABEL = { pass: 'Pass', fail: 'Fail', blocked: 'Blocked', not_tested: 'Not tested' }
const Provider = ({ p }) => <span className={`tag ${p === 'real' ? 'tag--info' : ''}`}>{p === 'real' ? 'Real provider' : 'Mocked providers'}</span>

function RunDetail({ id, onBack }) {
  const [d, setD] = useState(null)
  const [hist, setHist] = useState({})
  useEffect(() => {
    let live = true
    api(`/api/platform/qa?run=${encodeURIComponent(id)}`).then(({ status, data }) => live && setD(status === 200 ? data : { error: true }))
    return () => {
      live = false
    }
  }, [id])
  const history = async (t) => {
    const { data } = await api(`/api/platform/qa?test=${encodeURIComponent(t)}`)
    setHist((h) => ({ ...h, [t]: data.history || [] }))
  }
  if (!d) return <p aria-busy="true">Loading run…</p>
  if (d.error) return <p className="form-error" role="alert">Couldn’t load this run.</p>
  const related = d.related || []
  return (
    <div className="stack-lg" data-run={d.run.id}>
      <button type="button" className="link-btn" onClick={onBack}>
        ← QA
      </button>
      <h2 className="title title--page">
        {d.run.kind === 'human' ? `Human QA: ${d.run.journey}` : 'Automated run'} <span className={`tag ${RUN_TAG[d.run.status]}`}>{d.run.status}</span> <Provider p={d.run.provider} />
      </h2>
      <p className="fine">
        {when(d.run.startedAt)} · {d.run.source}
        {d.run.revision ? ` · revision ${d.run.revision.slice(0, 7)}` : ''}
        {d.run.summary.totalMs != null ? ` · total ${mins(d.run.summary.totalMs)} (target ${d.run.summary.targetMinutes} min)` : ''}
        {d.run.artifactsUrl && (
          <>
            {' · '}
            <a href={d.run.artifactsUrl} target="_blank" rel="noreferrer">
              Screenshots and traces (CI artifacts)
            </a>
          </>
        )}
      </p>
      {related.length > 0 && (
        <section className="card" aria-labelledby="qa-rel">
          <h3 id="qa-rel" className="card-title">Related open incidents</h3>
          <ul className="rows">
            {related.map((i) => (
              <li key={i.id} className="row">
                <p className="row-title">
                  {i.severity} · {i.impact} ({i.customer}, {i.code})
                </p>
              </li>
            ))}
          </ul>
        </section>
      )}
      <section className="card" aria-labelledby="qa-res">
        <h3 id="qa-res" className="card-title">Results</h3>
        <ul className="rows">
          {d.results.map((r) => (
            <li key={r.test_id} className="row" data-test={r.test_id} data-result={r.status}>
              <div className="row-main">
                <p className="row-title">
                  <span className={`tag ${RES_TAG[r.status]}`}>{RES_LABEL[r.status]}</span> {r.test_id}
                  {r.ms != null && <span className="fine"> · {d.run.kind === 'human' ? mins(r.ms) : `${(r.ms / 1000).toFixed(1)} s`}</span>}
                </p>
                {r.observed && <p className="row-sub cc-evidence">{r.observed}</p>}
                {Object.keys(r.answers || {}).length > 0 && <p className="row-sub">Answers: {Object.values(r.answers).join(' · ')}</p>}
                {hist[r.test_id] && (
                  <ol className="cc-steps" aria-label="Retest history">
                    {hist[r.test_id].map((h) => (
                      <li key={h.run_id}>
                        <span className={`tag ${RES_TAG[h.status]}`}>{RES_LABEL[h.status]}</span> {when(h.at)} · {h.source} · {h.revision ? h.revision.slice(0, 7) : '—'} · {h.provider}
                      </li>
                    ))}
                  </ol>
                )}
              </div>
              {d.run.kind === 'automated' && (
                <button type="button" className="link-btn" onClick={() => history(r.test_id)}>
                  Retest history
                </button>
              )}
            </li>
          ))}
        </ul>
        {!d.results.length && <p className="empty">No results recorded.</p>}
      </section>
      {d.findings.length > 0 && (
        <section className="card" aria-labelledby="qa-find">
          <h3 id="qa-find" className="card-title">Defects and improvements</h3>
          <ul className="rows">
            {d.findings.map((f) => (
              <li key={f.id} className="row" data-finding={f.type}>
                <p className="row-title">
                  <span className={`tag ${f.type === 'defect' ? 'tag--bad' : 'tag--info'}`}>{f.type === 'defect' ? `Defect · ${f.severity}` : 'Improvement'}</span> {f.step || 'whole journey'}: {f.text}
                </p>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}

function Step({ s, run, timed, recorded, onRecorded }) {
  const [observed, setObserved] = useState('')
  const [answers, setAnswers] = useState({})
  const [finding, setFinding] = useState({ type: 'defect', severity: 'medium', text: '' })
  const [msg, setMsg] = useState('')
  const record = async (status) => {
    const { status: code, data } = await api('/api/platform/qa', { method: 'POST', body: { action: 'step', run, step: s.id, status, observed, answers } })
    if (code === 200) onRecorded(s.id, status, data.ms)
    setMsg(code === 200 ? `Recorded: ${RES_LABEL[status]}${timed && data.ms != null ? ` (${mins(data.ms)})` : ''}` : `Not recorded (${data.error})`)
  }
  const addFinding = async () => {
    const { status: code, data } = await api('/api/platform/qa', { method: 'POST', body: { action: 'finding', run, step: s.id, ...finding, severity: finding.type === 'defect' ? finding.severity : null } })
    setMsg(code === 200 ? `${finding.type === 'defect' ? 'Defect' : 'Improvement'} saved` : `Not saved (${data.error})`)
    if (code === 200) setFinding((f) => ({ ...f, text: '' }))
  }
  const id = `qs-${s.id}`
  return (
    <li className="card" data-qa-step={s.id} data-recorded={recorded || ''}>
      <h4 className="card-title">
        {s.title} {recorded && <span className={`tag ${RES_TAG[recorded]}`}>{RES_LABEL[recorded]}</span>}
      </h4>
      <p>
        <strong>Do:</strong> {s.action}
      </p>
      <p>
        <strong>Expected:</strong> {s.expected}
      </p>
      <label className="field" htmlFor={`${id}-obs`}>
        <span>What happened</span>
        <textarea id={`${id}-obs`} rows={2} maxLength={500} value={observed} onChange={(e) => setObserved(e.target.value)} />
      </label>
      {s.ask.map((q, k) => (
        <label key={k} className="field" htmlFor={`${id}-q${k}`}>
          <span>{q}</span>
          <textarea id={`${id}-q${k}`} rows={1} maxLength={300} value={answers[k] || ''} onChange={(e) => setAnswers((a) => ({ ...a, [k]: e.target.value }))} />
        </label>
      ))}
      <div className="qa-actions" role="group" aria-label={`Result for ${s.title}`}>
        {['pass', 'fail', 'blocked', 'not_tested'].map((st) => (
          <button key={st} type="button" className={`btn ${st === 'pass' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => record(st)}>
            {RES_LABEL[st]}
          </button>
        ))}
      </div>
      <details>
        <summary className="fine">Report a defect or an improvement (separately)</summary>
        <div className="stack">
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
                {['critical', 'high', 'medium', 'low'].map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="field" htmlFor={`${id}-fx`}>
            <span>Describe it (no customer details)</span>
            <textarea id={`${id}-fx`} rows={2} maxLength={1000} value={finding.text} onChange={(e) => setFinding((f) => ({ ...f, text: e.target.value }))} />
          </label>
          <button type="button" className="btn btn-ghost" onClick={addFinding} disabled={!finding.text.trim()}>
            Save
          </button>
        </div>
      </details>
      <p className="fine" role="status" aria-live="polite">
        {msg}
      </p>
    </li>
  )
}

function Runner({ run, journey, onDone }) {
  const [recorded, setRecorded] = useState({})
  const [now, setNow] = useState(() => Date.now())
  const [result, setResult] = useState(null)
  useEffect(() => {
    if (!journey.timed || result) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [journey.timed, result])
  const finish = async () => {
    const { status, data } = await api('/api/platform/qa', { method: 'POST', body: { action: 'finish', run: run.id } })
    setResult(status === 200 ? data : { error: data.error })
  }
  return (
    <div className="stack-lg" data-qa-run={run.id}>
      <h2 className="title title--page">Guided QA: {journey.title}</h2>
      {journey.note && <p className="notice">{journey.note}</p>}
      {journey.timed && (
        <p className="stat-value" aria-live="off" data-elapsed>
          {mins((result?.summary?.totalMs ?? now - run.startedAt) || 0)} <span className="fine">/ target {journey.targetMinutes}:00</span>
        </p>
      )}
      <p className="fine">Evaluate clarity, trust, effort, accessibility and visual quality. Automation already checks the mechanics.</p>
      <ol className="stack-lg qa-list">
        {journey.steps.map((s) => (
          <Step key={s.id} s={s} run={run.id} timed={journey.timed} recorded={recorded[s.id]} onRecorded={(id, st) => setRecorded((r) => ({ ...r, [id]: st }))} />
        ))}
      </ol>
      {result ? (
        <p role="status" data-run-result={result.status || 'error'}>
          {result.error ? `Not finished (${result.error})` : `Run finished: ${result.status}${result.summary.totalMs != null ? ` · total ${mins(result.summary.totalMs)}` : ''}`}{' '}
          <button type="button" className="link-btn" onClick={onDone}>
            Back to QA
          </button>
        </p>
      ) : (
        <button type="button" className="btn btn-primary" onClick={finish}>
          Finish run
        </button>
      )}
    </div>
  )
}

export default function Qa({ initialJourney = null }) {
  const [q, setQ] = useState(null)
  const [detail, setDetail] = useState(null)
  const [running, setRunning] = useState(null)
  const [customer, setCustomer] = useState('')
  const [err, setErr] = useState('')
  const [reload, setReload] = useState(0)
  useEffect(() => {
    let live = true
    api('/api/platform/qa').then(({ status, data }) => live && setQ(status === 200 ? data : { error: true }))
    return () => {
      live = false
    }
  }, [reload])
  const start = async (j) => {
    setErr('')
    const { status, data } = await api('/api/platform/qa', { method: 'POST', body: { action: 'start', journey: j.id, customer: customer.trim() || null } })
    if (status !== 200) return setErr(`Couldn’t start (${data.error})`)
    setRunning({ run: { id: data.id, startedAt: Date.now() }, journey: j })
  }
  const back = () => {
    setDetail(null)
    setRunning(null)
    setReload((n) => n + 1)
  }
  if (running) return <Runner run={running.run} journey={running.journey} onDone={back} />
  if (detail) return <RunDetail id={detail} onBack={back} />
  if (!q) return <p aria-busy="true">Loading QA…</p>
  if (q.error) return <p className="form-error" role="alert">Couldn’t load QA.</p>
  if (!q.available) return <p className="empty">QA history isn’t available yet (migration 0032 not applied).</p>
  const ordered = initialJourney ? [...q.journeys].sort((a, b) => (b.id === initialJourney) - (a.id === initialJourney)) : q.journeys
  return (
    <div className="stack-lg">
      <section className="card" aria-labelledby="qa-act">
        <h2 id="qa-act" className="card-title">Activation (target ≤ 20 min)</h2>
        {q.activation.measured ? (
          <p data-activation="measured">
            Latest observer-recorded run: {q.activation.latest.totalMinutes} min · {q.activation.latest.status} · <Provider p={q.activation.latest.provider} /> · {when(q.activation.latest.finishedAt)} ({q.activation.runs} run{q.activation.runs === 1 ? '' : 's'})
          </p>
        ) : (
          <p className="empty" data-activation="not-measured">
            Not measured yet. No real-person activation run has been recorded.
          </p>
        )}
        <p className="fine">Authorized test onboarding only, while public signup is closed. A result here is never “public signup works”.</p>
      </section>
      <section className="card" aria-labelledby="qa-auto">
        <h2 id="qa-auto" className="card-title">Automated runs</h2>
        {q.failedJourneys.length > 0 && <p className="bad">Failing journeys: {q.failedJourneys.join(', ')}</p>}
        {q.automated.length ? (
          <ul className="rows">
            {q.automated.map((r) => (
              <li key={r.id} className="row" data-qa-auto={r.id}>
                <div className="row-main">
                  <p className="row-title">
                    <span className={`tag ${RUN_TAG[r.status]}`}>{r.status}</span> {when(r.startedAt)} · {r.source} · {r.revision ? r.revision.slice(0, 7) : 'no revision'} <Provider p={r.provider} />
                  </p>
                  <p className="row-sub">
                    {r.summary.pass ?? 0} passed · {r.summary.fail ?? 0} failed · {r.summary.blocked ?? 0} blocked · {r.summary.not_tested ?? 0} skipped
                  </p>
                </div>
                <button type="button" className="link-btn" onClick={() => setDetail(r.id)}>
                  Open run
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="empty">No automated runs recorded. CI posts them with scripts/qa-report.mjs once QA_INGEST_TOKEN is set (approval).</p>
        )}
      </section>
      <section className="card" aria-labelledby="qa-human">
        <h2 id="qa-human" className="card-title">Guided human QA</h2>
        <label className="field" htmlFor="qa-biz">
          <span>Test business used (optional)</span>
          <input id="qa-biz" value={customer} onChange={(e) => setCustomer(e.target.value)} placeholder="e.g. e2e-cc" />
        </label>
        {err && (
          <p className="form-error" role="alert">
            {err}
          </p>
        )}
        <ul className="rows">
          {ordered.map((j) => (
            <li key={j.id} className="row" data-qa-journey={j.id}>
              <div className="row-main">
                <p className="row-title">
                  {j.title} {j.timed && <span className="tag tag--info">Timed</span>}
                </p>
                <p className="row-sub">
                  {j.steps.length} steps · {j.tests.length} linked automated test{j.tests.length === 1 ? '' : 's'}
                </p>
              </div>
              <button type="button" className="btn btn-ghost" onClick={() => start(j)} aria-label={`Start guided QA: ${j.title}`}>
                Start
              </button>
            </li>
          ))}
        </ul>
        {q.human.length > 0 && (
          <>
            <h3 className="card-title">Recent human runs</h3>
            <ul className="rows">
              {q.human.map((r) => (
                <li key={r.id} className="row">
                  <div className="row-main">
                    <p className="row-title">
                      <span className={`tag ${RUN_TAG[r.status]}`}>{r.status}</span> {r.journey} · {when(r.startedAt)}
                      {r.summary.totalMs != null ? ` · ${mins(r.summary.totalMs)}` : ''}
                    </p>
                  </div>
                  <button type="button" className="link-btn" onClick={() => setDetail(r.id)}>
                    Open run
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
    </div>
  )
}
