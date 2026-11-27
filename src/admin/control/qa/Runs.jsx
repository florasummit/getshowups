// QA → Runs: every execution (filters in the URL), and one run's page with live progress. State lives on the server,
// so closing the browser loses nothing: reopening the page shows where the run is. Earlier CI runs from before the
// QA Command Center (the Testing tab's history) stay listed and open in the same run review as before.
import { useEffect, useState } from 'react'
import { Badge, Empty, Facts, Link, LoadError, Loading, PageHead, Section } from '../ui.jsx'
import * as qa from '../qa-api.js'
import { ENV, EXEC_STATUS, MAX_REPORT_BYTES, PRESETS, duration, isActive, previewReport, scopeText, sha, stamp, usd } from '../qa-lib.js'
import { ConfirmButton, EnvLabel, ExecPill, ResultPill } from './parts.jsx'
import { useLoad, usePlan } from './hooks.jsx'

const crumbs = [
  ['Control Center', {}],
  ['QA', { view: 'qa' }],
]
const POLL_MS = 4000
const dayStart = (d) => (d ? new Date(`${d}T00:00:00`).getTime() : undefined) // the viewer's own midnight
const progressText = (p) => (p ? `${p.done ?? 0} of ${p.total ?? '?'} done · ${p.pass ?? 0} passed · ${p.fail ?? 0} failed${p.blocked ? ` · ${p.blocked} blocked` : ''}${p.skipped ? ` · ${p.skipped} skipped` : ''}` : '')
const REASON = { cancelled_by_admin: 'Cancelled by an admin.', ci_not_configured: 'Automated runs aren’t connected yet.', dispatch_failed: 'CI didn’t accept the run.', timed_out: 'No result arrived in time.', budget_entry: 'No QA budget for paid checks.' }
const reasonOf = (r) => (r ? REASON[r] || r.replace(/_/g, ' ') : '')

function ExecRow({ x, go }) {
  return (
    <li>
      <Link to={{ view: 'qa', exec: x.id }} go={go} className="cc-item" data-exec={x.id}>
        <span className="cc-item-main">
          <span className="cc-item-title">{scopeText(x)}</span>
          <span className="cc-item-sub">
            {stamp(x.requestedAt)}
            {x.commit ? ` · release ${sha(x.commit)}` : ''}
            {x.progress ? ` · ${progressText(x.progress)}` : ''}
          </span>
        </span>
        <span className="cc-item-meta">
          <EnvLabel e={x.environment} />
          <ExecPill s={x.status} />
          <span className="cc-chev" aria-hidden="true">
            ›
          </span>
        </span>
      </Link>
    </li>
  )
}

// ---------- import a report ----------
// A report produced off-CI (the admin assistant evaluation, a local run) recorded in the QA system with its costs:
// pick the file → see exactly what it will record → confirm → a link to the new run.
function ImportReport({ go, onImported }) {
  const [open, setOpen] = useState(false)
  const [file, setFile] = useState(null) // { name, report, preview } | { name, error }
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(null)
  const [err, setErr] = useState('')
  const pick = async (f) => {
    setDone(null)
    setErr('')
    if (!f) return setFile(null)
    if (f.size > MAX_REPORT_BYTES) return setFile({ name: f.name, error: 'The file is larger than 2 MB.' })
    let report
    try {
      report = JSON.parse(await f.text())
    } catch {
      return setFile({ name: f.name, error: 'This file isn’t valid JSON.' })
    }
    const preview = previewReport(report)
    setFile(preview.error ? { name: f.name, error: preview.error } : { name: f.name, report, preview })
  }
  const record = async () => {
    setBusy(true)
    setErr('')
    const r = await qa.importReport(file.report)
    setBusy(false)
    if (!r.ok || !r.data?.run) return setErr(r.error || 'Nothing was recorded. Try again.')
    setDone(r.data.run)
    setFile(null)
    onImported?.()
  }
  if (!open)
    return (
      <div className="cc-actions">
        <button type="button" className="btn btn-quiet btn-sm" onClick={() => setOpen(true)} data-import-open>
          Import a report
        </button>
      </div>
    )
  const p = file?.preview
  return (
    <section className="qa-card" aria-labelledby="qa-import-h" data-import>
      <div className="qa-plan-head">
        <h2 id="qa-import-h">Import a report</h2>
        <button type="button" className="btn btn-quiet btn-sm" onClick={() => (setOpen(false), setFile(null), setDone(null))}>
          Close
        </button>
      </div>
      <p className="cc-status-line">For results produced outside CI: an AI evaluation (admin-assistant-eval.mjs --qa-json) or a local run (qa-report.mjs --out). They are recorded as a local run, with the costs the report lists.</p>
      <label className="field" htmlFor="qa-import-file">
        <span>Report file (JSON, up to 2 MB)</span>
        <input id="qa-import-file" type="file" accept="application/json,.json" onChange={(e) => pick(e.target.files?.[0])} />
      </label>
      {file?.error && (
        <p className="form-error" role="alert" data-import-error>
          {file.name}: {file.error}
        </p>
      )}
      {p && (
        <div className="stack" data-import-preview>
          <span className="cc-label">What it will record</span>
          <dl className="cc-facts">
            <div>
              <dt>Results</dt>
              <dd data-import-tests={p.tests}>
                {p.tests} ({p.byStatus.pass} passed · {p.byStatus.fail} failed{p.byStatus.blocked ? ` · ${p.byStatus.blocked} blocked` : ''}
                {p.byStatus.skipped ? ` · ${p.byStatus.skipped} skipped` : ''})
              </dd>
            </div>
            <div>
              <dt>Environment</dt>
              <dd>
                {ENV.local}
                {p.provider === 'real' ? ' · real providers' : ' · stand-in providers'}
              </dd>
            </div>
            <div>
              <dt>Release (commit)</dt>
              <dd>{p.revision ? <span className="cc-code">{sha(p.revision)}</span> : 'Not in the report: results can’t be tied to a release'}</dd>
            </div>
            <div>
              <dt>Recorded cost</dt>
              <dd data-import-cost>{p.costUsd == null ? 'Not in the report' : usd(p.costUsd, { free: false })}</dd>
            </div>
          </dl>
          <p className="cc-status-line">
            {Object.entries(p.byKind)
              .map(([k, n]) => `${n} ${k === 'eval' ? 'AI evaluation' : k === 'unit' ? 'unit' : 'browser'} ${n === 1 ? 'result' : 'results'}`)
              .join(' · ')}
            {p.models.length ? ` · model ${p.models.join(', ')}` : ''}
            {p.startedAt ? ` · run ${stamp(p.startedAt)}` : ''}
            {p.hashes ? '' : ' · no code versions, so these results can’t be checked for staleness'}. Results that don’t match a test in the inventory are counted and left out. AI evaluation results are graded by fixed checks; they record what the checks found.
          </p>
          {err && (
            <p className="form-error" role="alert">
              {err}
            </p>
          )}
          <div className="cc-actions">
            <button type="button" className="btn btn-primary btn-sm" onClick={record} disabled={busy} data-import-confirm>
              {busy ? 'Recording…' : `Record ${p.tests} ${p.tests === 1 ? 'result' : 'results'}`}
            </button>
            <button type="button" className="btn btn-quiet btn-sm" onClick={() => setFile(null)} disabled={busy}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {done && (
        <div className="cc-callout cc-callout--ok" role="status" data-import-done={done.id}>
          <strong>{done.duplicate ? 'Already imported: nothing new was recorded.' : `Recorded ${done.stored} ${done.stored === 1 ? 'result' : 'results'}.`}</strong>
          <span>
            {done.unmatched ? `${done.unmatched} didn’t match a test in the inventory and were left out. ` : ''}
            Recorded cost {usd((done.costMicros || 0) / 1e6, { free: false })}. Each result is on its test’s history.
          </span>
          {done.id && (
            <Link to={{ run: done.id }} go={go} className="cc-more">
              Open the imported run →
            </Link>
          )}
        </div>
      )}
    </section>
  )
}

export function RunsView({ params, go }) {
  const [d, reload] = useLoad(() => qa.listExecutions({ status: params.status, environment: params.env, preset: params.kind, commit: params.release, from: dayStart(params.since) }), [params.status, params.env, params.kind, params.release, params.since])
  const [legacy, reloadLegacy] = useLoad(qa.getLegacy, [])
  const [release, setRelease] = useState(params.release || '')
  const set = (k, v) => go({ ...params, view: 'qa', tab: 'runs', [k]: v || null }, { replace: true })
  const list = d && !d.error ? qa.arr(d.executions) : []
  const earlier = legacy && !legacy.error ? qa.arr(legacy.automated) : []
  const filtered = !!(params.status || params.env || params.kind || params.release || params.since)
  return (
    <div className="cc-main" data-qa-runs>
      <PageHead go={go} crumbs={[crumbs[0]]} title="Runs" lede="Every run, automated or manual: who started it, against which release, and what it found. Results by test, area or severity are under Tests and Defects." />
      <ImportReport go={go} onImported={() => (reload(true), reloadLegacy(true))} />
      <form
        className="cc-toolbar qa-filters"
        onSubmit={(e) => {
          e.preventDefault()
          set('release', release.trim())
        }}
      >
        <label className="field qa-filter" htmlFor="qa-r-status">
          <span>Status</span>
          <select id="qa-r-status" value={params.status || ''} onChange={(e) => set('status', e.target.value)}>
            <option value="">Any status</option>
            {Object.entries(EXEC_STATUS).map(([k, [, l]]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <label className="field qa-filter" htmlFor="qa-r-env">
          <span>Environment</span>
          <select id="qa-r-env" value={params.env || ''} onChange={(e) => set('env', e.target.value)}>
            <option value="">Any</option>
            {['ci', 'production', 'manual'].map((k) => (
              <option key={k} value={k}>
                {ENV[k]}
              </option>
            ))}
          </select>
        </label>
        <label className="field qa-filter" htmlFor="qa-r-kind">
          <span>Kind of run</span>
          <select id="qa-r-kind" value={params.kind || ''} onChange={(e) => set('kind', e.target.value)}>
            <option value="">Any</option>
            {PRESETS.map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <label className="field qa-filter" htmlFor="qa-r-release">
          <span>Release (commit)</span>
          <input id="qa-r-release" value={release} placeholder="e.g. 8ea75f9" onChange={(e) => setRelease(e.target.value)} onBlur={() => release.trim() !== (params.release || '') && set('release', release.trim())} />
        </label>
        <label className="field qa-filter" htmlFor="qa-r-since">
          <span>Since</span>
          <input id="qa-r-since" type="date" value={params.since || ''} onChange={(e) => set('since', e.target.value)} />
        </label>
      </form>
      <Section title="Runs" id="qa-r-list">
        {d === undefined ? (
          <Loading label="Loading runs…" />
        ) : d.error ? (
          <div className="cc-section-body">
            <LoadError what="runs" onRetry={reload} />
          </div>
        ) : list.length ? (
          <ul className="cc-list" data-qa-exec-list>
            {list.map((x) => (
              <ExecRow key={x.id} x={x} go={go} />
            ))}
          </ul>
        ) : (
          <Empty title={filtered ? 'No run matches these filters.' : 'No runs yet.'}>{filtered ? null : 'Start one from the QA overview or the Tests list.'}</Empty>
        )}
      </Section>
      {earlier.length > 0 && (
        <Section title="Earlier CI runs" id="qa-r-earlier" sub="Recorded before the QA Command Center: browser tests against stand-in providers.">
          <ul className="cc-list">
            {earlier.map((r) => (
              <li key={r.id}>
                <Link to={{ run: r.id }} go={go} className="cc-item" data-qa-auto={r.id}>
                  <span className="cc-item-main">
                    <span className="cc-item-title">
                      {r.source === 'ci' ? 'CI run' : 'Local run'} {r.revision ? <span className="cc-code">{sha(r.revision)}</span> : null}
                    </span>
                    <span className="cc-item-sub">
                      {stamp(r.startedAt)} · {r.summary?.pass ?? 0} passed · {r.summary?.fail ?? 0} failed · {r.summary?.not_tested ?? 0} skipped
                    </span>
                  </span>
                  <span className="cc-item-meta">
                    <Badge tone={r.provider === 'real' ? 'info' : 'neutral'}>{r.provider === 'real' ? 'Real providers' : 'Mocked providers'}</Badge>
                    <Badge tone={r.status === 'passed' ? 'ok' : r.status === 'failed' ? 'bad' : 'warn'}>{r.status === 'passed' ? 'Passed' : r.status === 'failed' ? 'Failed' : 'Incomplete'}</Badge>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  )
}

// ---------- one run ----------
export function ExecutionDetail({ id, go }) {
  const [d, reload, setD] = useLoad(() => qa.getExecution(id), [id])
  const [openPlan, plan] = usePlan(go)
  const [msg, setMsg] = useState('')
  const x = d && !d.error ? d.execution || {} : null
  const active = !!x && isActive(x.status)
  // Live progress while the run is active and this tab is visible. Closing the page stops only the polling.
  useEffect(() => {
    if (!active) return undefined
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') qa.getExecution(id).then((r) => r.ok && setD(r.data))
    }, POLL_MS)
    return () => clearInterval(t)
  }, [active, id, setD])
  if (d === undefined) return <Loading label="Loading the run…" />
  if (d.error) return d.status === 404 ? <Empty title="Run not found.">It may have been removed by retention.</Empty> : <LoadError what="this run" onRetry={reload} />
  const results = qa.arr(d.results)
  const events = qa.arr(d.events)
  const failed = results.filter((r) => r.status === 'fail')
  const p = x.progress
  const cancel = async () => {
    const r = await qa.cancelRun(id)
    setMsg(r.ok ? `Cancelled.${r.data?.githubCancelled === false ? ' The CI job may still finish its current step; its results will be recorded.' : ''} Results recorded so far are kept.` : r.error)
    reload(true)
  }
  return (
    <div className="cc-main" data-qa-exec={x.id} data-exec-status={x.status}>
      <PageHead go={go} crumbs={[...crumbs, ['Runs', { view: 'qa', tab: 'runs' }]]} title={scopeText(x)}>
        <ExecPill s={x.status} />
        <EnvLabel e={x.environment} />
      </PageHead>
      {plan}
      {active && (
        <div className="cc-callout cc-callout--next" role="status" data-exec-live>
          <strong>{x.status === 'queued' ? 'Waiting to start.' : x.status === 'dispatched' ? 'Sent to CI, waiting for it to start.' : 'Running.'}</strong>
          <span>{x.next || 'This page refreshes by itself. You can close it: the run continues on the server and its results stay here.'}</span>
        </div>
      )}
      {!active && x.reason && (
        <div className="cc-callout cc-callout--warn" data-exec-reason>
          <strong>{x.status === 'cancelled' ? 'Cancelled.' : x.status === 'refused' ? 'Not started.' : 'Stopped.'}</strong>
          <span>{reasonOf(x.reason)}</span>
        </div>
      )}
      <div className="qa-progress-block">
        <p className="cc-status-line" data-exec-progress>
          {p ? progressText(p) : `${results.length} recorded`}
        </p>
        {p?.total ? (
          <div className="qa-bar" role="progressbar" aria-label="Progress" aria-valuemin={0} aria-valuemax={p.total} aria-valuenow={p.done ?? 0}>
            <span style={{ width: `${Math.min(100, ((p.done ?? 0) / p.total) * 100)}%` }} />
          </div>
        ) : null}
      </div>
      <Facts
        items={[
          ['Requested', stamp(x.requestedAt)],
          x.requestedBy && ['By', x.requestedBy],
          x.startedAt && ['Started', stamp(x.startedAt)],
          x.finishedAt && ['Finished', stamp(x.finishedAt)],
          ['Environment', ENV[x.environment] || x.environment],
          ['Release', x.commit ? <span key="c" className="cc-code">{sha(x.commit)}</span> : 'Unknown'],
          x.deployment && ['Deployment', <span key="d" className="cc-code">{String(x.deployment).slice(0, 8)}</span>],
          ['Estimated', `${duration(x.estimate?.ms)} · ${usd(qa.usdOf(x.estimate))}`],
          x.costMicros != null && ['Recorded cost', usd(x.costMicros / 1e6, { free: false })],
          x.attempts > 1 && ['Attempts', String(x.attempts)],
        ]}
      />
      <div className="cc-actions">
        {x.runUrl && /^https:/.test(x.runUrl) && (
          <a className="btn btn-quiet btn-sm" href={x.runUrl} target="_blank" rel="noreferrer">
            Open in CI ↗
          </a>
        )}
        {active && <ConfirmButton label="Cancel run" question="Cancel this run?" detail="Tests that already finished keep their results." confirmLabel="Cancel run" onConfirm={cancel} data-exec-cancel />}
        {!active && failed.length > 0 && (
          <button type="button" className="btn btn-primary btn-sm" onClick={() => openPlan({ tests: failed.map((r) => r.testId) }, `Retest ${failed.length} failed ${failed.length === 1 ? 'test' : 'tests'}`)} data-retest-failed>
            Retest failed
          </button>
        )}
        <span className="cc-status-line" role="status">
          {msg}
        </span>
      </div>
      <Section title="Results" id="qa-x-res" sub={results.length ? 'Failures first. Each result is kept; a retest adds a new one.' : null}>
        {results.length ? (
          <ul className="cc-list">
            {[...results]
              .sort((a, b) => (a.status === 'fail' ? 0 : 1) - (b.status === 'fail' ? 0 : 1))
              .map((r) => (
                <li key={r.id || r.testId} className="cc-item qa-row" data-result-id={r.id} data-result={r.status} data-test={r.testId}>
                  <span className="cc-item-main">
                    <Link to={{ view: 'qa', test: r.testId }} go={go} className="cc-item-title">
                      {r.title || r.testId}
                    </Link>
                    {r.expected && <span className="cc-item-sub">Expected: {r.expected}</span>}
                    {r.actual && <span className="cc-item-sub">Actual: {r.actual}</span>}
                    <span className="cc-item-sub">
                      {stamp(r.at)}
                      {r.ms != null ? ` · ${duration(r.ms)}` : ''}
                      {r.costMicros ? ` · ${usd(r.costMicros / 1e6)}` : ''}
                      {r.model ? ` · ${r.model}` : ''}
                    </span>
                  </span>
                  <span className="cc-item-meta">
                    <ResultPill s={r.status} />
                    {r.status === 'fail' && (
                      <Link to={{ view: 'qa', tab: 'defects', from: r.testId, result: r.id }} go={go} className="btn btn-quiet btn-sm" data-defect-from={r.id}>
                        Record defect
                      </Link>
                    )}
                  </span>
                </li>
              ))}
          </ul>
        ) : (
          <Empty title={active ? 'No results yet.' : 'No results were recorded.'}>{active ? 'They appear here as tests finish.' : null}</Empty>
        )}
      </Section>
      {events.length > 0 && (
        <Section title="Timeline" id="qa-x-ev" sub="Every status change, kept.">
          <div className="cc-section-body">
            <ol className="cc-timeline" data-exec-events>
              {events.map((e, k) => (
                <li key={k}>
                  <time>{stamp(e.at)}</time>
                  <span>
                    {EXEC_STATUS[e.to]?.[1] || e.to}
                    {e.actor ? ` · ${String(e.actor).startsWith('system:') ? 'automatic' : e.actor}` : ''}
                    {e.detail?.done != null ? ` · ${e.detail.done} done` : ''}
                  </span>
                </li>
              ))}
            </ol>
          </div>
        </Section>
      )}
    </div>
  )
}
