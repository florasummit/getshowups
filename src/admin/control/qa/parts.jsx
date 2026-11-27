// QA Command Center building blocks shared by every QA screen: status pills, the count strip, the plan dialog shown
// before EVERY run, the "Note an idea" control, and evidence (list + upload). Data comes only from ../qa-api.js.
import { useEffect, useRef, useState } from 'react'
import { Badge, Link } from '../ui.jsx'
import { ConfirmInline, SaveStatus } from '../../../dashboard/ui.jsx'
import { useSaveState } from '../../../dashboard/ui-hooks.js'
import * as qa from '../qa-api.js'
import { BACKLOG_STATUS, CLASS, ENV, EXEC_STATUS, KINDS, RESULT, STATUS_ORDER, TEST_STATUS, countTotal, duration, ideaContext, isDefect, sha, share, stamp, statusMap, usd } from '../qa-lib.js'

export const TestStatus = ({ s }) => {
  const [tone, label] = TEST_STATUS[s] || TEST_STATUS.untested
  return (
    <Badge tone={tone} data-test-status={TEST_STATUS[s] ? s : 'untested'}>
      {label}
    </Badge>
  )
}
export const ResultPill = ({ s }) => <Badge tone={RESULT[s]?.[0] || 'neutral'}>{RESULT[s]?.[1] || s}</Badge>
export const ExecPill = ({ s }) => (
  <Badge tone={EXEC_STATUS[s]?.[0] || 'neutral'} data-exec-status={s}>
    {EXEC_STATUS[s]?.[1] || s}
  </Badge>
)
export const ClassPill = ({ c }) => (CLASS[c] ? <Badge tone={CLASS[c][0]} plain>{CLASS[c][1]}</Badge> : null)
export const ItemStatus = ({ item }) => {
  const m = statusMap(item.kind)[item.status]
  return <Badge tone={m?.[0] || 'neutral'}>{m?.[1] || item.status}</Badge>
}
export const EnvLabel = ({ e }) => <Badge tone={e === 'production' ? 'info' : 'neutral'} plain>{ENV[e] || e}</Badge>

// Status counts with their denominator. Each count links to the Tests list filtered by that status.
export function Counts({ counts, go, area }) {
  const total = countTotal(counts)
  if (!total) return <p className="cc-status-line">No tests in the inventory yet.</p>
  return (
    <div className="qa-counts" aria-label="Test status counts">
      {STATUS_ORDER.map((s) => [s, Number(counts[s]) || 0]).map(([s, n]) => (
        <Link key={s} to={{ view: 'qa', tab: 'tests', status: s, area }} go={go} className="qa-count" data-count={s}>
          <TestStatus s={s} />
          <b>{n}</b>
          <small>{share(n, total)}</small>
        </Link>
      ))}
    </div>
  )
}

// ---------- the plan dialog: shown before every run ----------
// Asks the server for the plan (no side effects) and shows scope, environment, duration, cost, prerequisites,
// approvals, what is left out and why, and the duplicate notice. It starts only on an explicit confirmation, and only
// when the server says the plan is runnable; otherwise it says exactly what is missing.
export function PlanPanel({ scope, title, onClose, go }) {
  const env = scope.environment || (scope.preset === 'production_verify' ? 'production' : 'ci')
  // Paid AI / voice checks are only in scope when the admin ticks them in (they cost QA budget and need approval).
  const [includePaid, setIncludePaid] = useState(!!scope.includePaid)
  const body = { ...scope, environment: env, ...(includePaid ? { includePaid: true } : {}) }
  const key = JSON.stringify(body)
  const [planned, setPlanned] = useState({ key: null, data: undefined })
  const [rerun, setRerun] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const ref = useRef(null)
  const p = planned.key === key ? planned.data : undefined
  useEffect(() => {
    let live = true
    qa.plan(JSON.parse(key)).then((r) => live && setPlanned({ key, data: r.ok ? r.data : { failed: r.error } }))
    return () => {
      live = false
    }
  }, [key])
  useEffect(() => ref.current?.focus({ preventScroll: false }), [])
  const start = async () => {
    setBusy(true)
    setErr(null)
    const r = await qa.startRun(body, { planId: p?.planId, rerun })
    setBusy(false)
    const id = r.data?.execution?.id
    if (r.ok && id) return go({ view: 'qa', exec: id })
    if (r.data?.error === 'plan_changed' && r.data.plan) {
      setPlanned({ key, data: r.data.plan })
      setRerun(false)
      return setErr({ text: 'The plan changed since it was shown (new results or a new release). Review it and start again.' })
    }
    setErr({ text: r.error || 'The run didn’t start. Nothing was recorded.', executionId: r.data?.error === 'already_running' ? r.data.executionId : null })
  }
  const s = p?.scope || {}
  const nTests = Array.isArray(s.tests) ? s.tests.length : Number(s.tests) || 0
  const sample = qa.arr(s.sample)
  const excluded = qa.arr(s.excluded)
  const excludedCount = Number.isFinite(s.excludedCount) ? s.excludedCount : excluded.length
  const paidLeftOut = excluded.filter((x) => x.why === 'authorization_required').length
  const dup = p?.duplicate
  const approvals = qa.arr(p?.approvals).map(qa.setupText).filter(Boolean)
  const prereq = qa.arr(p?.prerequisites)
  const usdEst = qa.usdOf(p?.estimate)
  const why = !p || p.failed ? '' : p.refusal ? 'It can’t run until the item above is done.' : !nTests ? 'Nothing in this selection can run automatically.' : dup && !rerun ? 'Tick “Run them again anyway” to start.' : ''
  const canStart = !!p && !p.failed && p.runnable !== false && !p.refusal && nTests > 0 && (!dup || rerun)
  return (
    <div className="qa-plan" role="dialog" aria-modal="false" aria-labelledby="qa-plan-h" data-plan data-plan-runnable={p && !p.failed ? String(canStart) : undefined}>
      <div className="qa-plan-head">
        <h2 id="qa-plan-h" tabIndex={-1} ref={ref}>
          Before you run: {title}
        </h2>
        <button type="button" className="btn btn-quiet btn-sm" onClick={onClose}>
          Close
        </button>
      </div>
      {p === undefined ? (
        <p className="cc-status-line" aria-busy="true">
          Working out the plan…
        </p>
      ) : p.failed ? (
        <div className="cc-callout cc-callout--warn" role="alert">
          <strong>Couldn’t prepare the plan.</strong>
          <span>{p.failed}</span>
        </div>
      ) : (
        <>
          <dl className="cc-facts" data-plan-facts>
            <div>
              <dt>Scope</dt>
              <dd data-plan-scope={nTests}>
                {nTests} {nTests === 1 ? 'test' : 'tests'}
                {qa.arr(s.journeys).length ? ` · from ${s.journeys.length} ${s.journeys.length === 1 ? 'journey' : 'journeys'}` : ''}
              </dd>
            </div>
            <div>
              <dt>Where it runs</dt>
              <dd>
                {ENV[p.environment || env] || p.environment || env}
                {p.commit ? ` · release ${sha(p.commit)}` : ''}
              </dd>
            </div>
            <div>
              <dt>Estimated duration</dt>
              <dd data-plan-ms>
                {p.estimate?.approximate ? '' : ''}
                {duration(p.estimate?.ms)}
              </dd>
            </div>
            <div>
              <dt>Estimated cost</dt>
              <dd data-plan-usd>
                {usd(usdEst)}
                {usdEst > 0 ? ' from the QA budget' : ''}
              </dd>
            </div>
          </dl>
          {p.estimate?.basis && <p className="cc-status-line">Estimate: {p.estimate.basis}.</p>}
          {s.byClass && (
            <p className="cc-status-line" data-plan-classes>
              {Object.entries(s.byClass)
                .filter(([, n]) => n > 0)
                .map(([c, n]) => `${n} ${(CLASS[c]?.[1] || c).toLowerCase()}`)
                .join(' · ') || 'No tests'}
            </p>
          )}
          {sample.length > 0 && (
            <details className="cc-details">
              <summary>What will run{nTests > sample.length ? ` (first ${sample.length} of ${nTests})` : ''}</summary>
              <ul className="qa-plain-list">
                {sample.map((t) => (
                  <li key={t.id}>{t.title || t.id}</li>
                ))}
              </ul>
            </details>
          )}
          {(paidLeftOut > 0 || includePaid) && (
            <label className="qa-check" data-plan-include-paid>
              <input type="checkbox" checked={includePaid} onChange={(e) => setIncludePaid(e.target.checked)} />
              <span>Include paid AI and voice checks{paidLeftOut ? ` (${paidLeftOut} left out)` : ''}: they use the QA budget and need it authorized</span>
            </label>
          )}
          {excludedCount > 0 && (
            <details className="cc-details" data-plan-excluded={excludedCount}>
              <summary>
                Left out ({excludedCount}): {excludedCount === 1 ? 'it needs' : 'they need'} a person or an approval
              </summary>
              <ul className="qa-plain-list">
                {excluded.map((x) => (
                  <li key={x.id}>
                    <span className="cc-code">{x.id}</span> · {EXCLUDED[x.why] || (/^human/.test(x.why) ? EXCLUDED.human_required : x.why)}
                  </li>
                ))}
                {excludedCount > excluded.length && <li>…and {excludedCount - excluded.length} more</li>}
              </ul>
            </details>
          )}
          {prereq.length > 0 && (
            <div className="cc-callout" data-plan-prereq>
              <span className="cc-label">Prerequisites</span>
              <ul className="qa-plain-list qa-checklist">
                {prereq.map((x, k) => (
                  <li key={x.id || k} data-ok={x.ok === true ? 'yes' : x.ok === false ? 'no' : 'unknown'}>
                    <span className="qa-check-mark" aria-hidden="true">
                      {x.ok === true ? '✓' : x.ok === false ? '✕' : '?'}
                    </span>
                    <span>
                      <span className="sr-only">{x.ok === true ? 'Done: ' : x.ok === false ? 'Missing: ' : 'Unknown: '}</span>
                      {qa.setupText(x)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {approvals.length > 0 && (
            <div className="cc-callout cc-callout--warn" data-plan-approvals>
              <span className="cc-label">Approvals needed</span>
              <ul className="qa-plain-list">
                {approvals.map((x) => (
                  <li key={x}>{x}</li>
                ))}
              </ul>
            </div>
          )}
          {p.refusal && (
            <div className="cc-callout cc-callout--warn" role="alert" data-plan-refused={p.refusal.code || 'refused'}>
              <strong>This can’t run yet.</strong>
              <span>{p.refusal.text || qa.reasonText(p.refusal.code)}</span>
            </div>
          )}
          {dup && (
            <div className="cc-callout cc-callout--next" data-plan-duplicate>
              <strong>Already tested on this release.</strong>
              <span>
                {dup.text || `${dup.count} of these ${dup.of} tests already have a result on this release.`} Recorded {stamp(dup.at)}.
              </span>
              {dup.executionId && (
                <Link to={{ view: 'qa', exec: dup.executionId }} go={go} className="cc-more">
                  Open that run →
                </Link>
              )}
              <label className="qa-check">
                <input type="checkbox" checked={rerun} onChange={(e) => setRerun(e.target.checked)} />
                <span>Run them again anyway</span>
              </label>
            </div>
          )}
        </>
      )}
      {err && (
        <div className="form-error" role="alert">
          {err.text}{' '}
          {err.executionId && (
            <Link to={{ view: 'qa', exec: err.executionId }} go={go} className="cc-more">
              Open the run that is going →
            </Link>
          )}
        </div>
      )}
      {/* Sticky footer: Start (or the reason it can't start) stays on screen while the plan scrolls, on a phone too. */}
      <div className="cc-actions qa-plan-actions" data-plan-actions>
        <button type="button" className="btn btn-primary btn-sm" onClick={start} disabled={busy || !canStart} data-plan-start>
          {busy ? 'Starting…' : 'Start run'}
        </button>
        <button type="button" className="btn btn-quiet btn-sm" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        {why && <span className="cc-status-line">{why}</span>}
      </div>
      <p className="cc-status-line">The run continues on the server: you can close this page and come back to the results.</p>
    </div>
  )
}
const EXCLUDED = { authorization_required: 'needs approval (paid AI or voice)', human_required: 'needs a person: record it under Manual', production_only: 'runs only as a production check', ci_only: 'runs only in CI', local_only: 'runs only locally (imported reports)' }

// ---------- "Note an idea": on every QA screen ----------
// Saves a backlog entry in the Inbox. Recording an idea never starts work; the founder decides what is planned.
export function IdeaNote({ params }) {
  const [open, setOpen] = useState(false)
  const [f, setF] = useState({ kind: 'observation', title: '', description: '' })
  const [err, setErr] = useState({})
  const save = useSaveState()
  const title = useRef(null)
  useEffect(() => {
    if (open) title.current?.focus()
  }, [open])
  const ctx = ideaContext(params)
  const submit = (e) => {
    e.preventDefault()
    const errs = {}
    if (!f.title.trim()) errs.title = 'Give it a short title.'
    setErr(errs)
    if (errs.title) return title.current?.focus()
    save.run(async () => {
      const r = await qa.createItem({ kind: f.kind, title: f.title.trim(), description: [f.description.trim(), ctx.note].filter(Boolean).join('\n\n') || undefined, testIds: ctx.testIds || [] })
      if (!r.ok) return { error: r.error }
      setF({ kind: f.kind, title: '', description: '' })
      return { saved: isDefect(f.kind) ? 'Saved under Defects as Open.' : `Saved to the backlog ${BACKLOG_STATUS.inbox[1]}. Nothing starts until you plan it.` }
    })
  }
  if (!open)
    return (
      <div className="qa-idea" data-idea>
        <button type="button" className="btn btn-quiet btn-sm" onClick={() => setOpen(true)} aria-expanded="false">
          Note an idea
        </button>
        <SaveStatus save={save} />
      </div>
    )
  return (
    <form className="qa-idea qa-idea--open" onSubmit={submit} data-idea aria-label="Note an idea" noValidate>
      <div className="field-row">
        <label className="field" htmlFor="qa-idea-kind">
          <span>Kind</span>
          <select id="qa-idea-kind" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>
            {Object.entries(KINDS).map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <label className="field" htmlFor="qa-idea-title">
          <span>Title</span>
          <input id="qa-idea-title" ref={title} maxLength={140} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} aria-invalid={err.title ? 'true' : undefined} aria-describedby={err.title ? 'qa-idea-title-err' : undefined} placeholder="Booking page: show the time zone" />
          {err.title && (
            <span className="field-error" id="qa-idea-title-err">
              {err.title}
            </span>
          )}
        </label>
      </div>
      <label className="field" htmlFor="qa-idea-desc">
        <span>
          Details <em>optional</em>
        </span>
        <textarea id="qa-idea-desc" rows={2} maxLength={2000} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} placeholder="What you noticed and why it matters. No customer names, emails or phone numbers." />
      </label>
      <div className="cc-actions">
        <button type="submit" className="btn btn-primary btn-sm" disabled={save.pending}>
          {save.pending ? 'Saving…' : 'Save idea'}
        </button>
        <button type="button" className="btn btn-quiet btn-sm" onClick={() => setOpen(false)}>
          Close
        </button>
        <SaveStatus save={save} />
      </div>
      <p className="cc-status-line">Saved ideas go to the Inbox. Nothing is planned or started until you decide.</p>
    </form>
  )
}

// ---------- evidence ----------
export function EvidenceList({ items }) {
  const list = qa.arr(items)
  if (!list.length) return <p className="cc-status-line">No evidence attached.</p>
  return (
    <ul className="qa-evidence" data-evidence-list>
      {list.map((e) => (
        <li key={e.id} data-evidence={e.kind}>
          {/^AI assessment\b/.test(e.text || '') && (
            <span>
              <Badge tone="info" plain>
                AI assessment, not a verified result
              </Badge>
            </span>
          )}
          <span className="cc-label">{e.kind === 'screenshot' ? 'Screenshot' : e.kind === 'transcript' ? 'Transcript' : e.kind === 'link' ? 'Link' : e.kind === 'record' ? 'Record' : 'Log'}</span>
          {e.purged ? (
            <span className="cc-status-line">Removed by the retention policy (the record that it existed is kept).</span>
          ) : e.kind === 'screenshot' ? (
            <a href={qa.evidenceSrc(e)} target="_blank" rel="noreferrer">
              <img src={qa.evidenceSrc(e)} alt="Screenshot attached as evidence" loading="lazy" />
            </a>
          ) : e.kind === 'link' && e.url && /^https:/.test(e.url) ? (
            <a href={e.url} target="_blank" rel="noreferrer" className="cc-more">
              {e.url} ↗
            </a>
          ) : e.text ? (
            <pre className="qa-pre">{e.text}</pre>
          ) : (
            <a href={qa.evidenceSrc(e)} target="_blank" rel="noreferrer" className="cc-more">
              Open ({e.bytes ? `${Math.ceil(e.bytes / 1024)} KB` : 'text'}) ↗
            </a>
          )}
          <small className="cc-status-line">
            {stamp(e.createdAt || e.at)}
            {e.expiresAt ? ` · kept until ${stamp(e.expiresAt)}` : ''}
          </small>
        </li>
      ))}
    </ul>
  )
}

// Attach a screenshot, a log excerpt or a link to a result or an item.
export function EvidenceUpload({ ownerKind, ownerId, onAdded, idBase }) {
  const [mode, setMode] = useState('screenshot')
  const [text, setText] = useState('')
  const file = useRef(null)
  const save = useSaveState()
  const id = idBase || `ev-${ownerKind}-${ownerId}`
  const add = () =>
    save.run(async () => {
      let r
      if (mode === 'screenshot') {
        const f = file.current?.files?.[0]
        if (!f) return { error: 'Choose a screenshot first.' }
        r = await qa.uploadEvidence({ ownerKind, ownerId, file: f })
      } else {
        if (!text.trim()) return { error: mode === 'link' ? 'Paste the link first.' : 'Paste the text first.' }
        r = await qa.uploadEvidence({ ownerKind, ownerId, kind: mode, text: mode === 'link' ? undefined : text.trim(), url: mode === 'link' ? text.trim() : undefined })
      }
      if (!r.ok) return { error: r.error }
      setText('')
      if (file.current) file.current.value = ''
      onAdded?.(r.data)
      return { saved: 'Evidence attached.' }
    })
  return (
    <div className="qa-upload" data-evidence-upload>
      <div className="field-row">
        <label className="field" htmlFor={`${id}-kind`}>
          <span>Evidence</span>
          <select id={`${id}-kind`} value={mode} onChange={(e) => setMode(e.target.value)}>
            <option value="screenshot">Screenshot (PNG, JPEG or WebP, up to 1 MB)</option>
            <option value="log">Log or error text</option>
            <option value="transcript">Transcript excerpt</option>
            <option value="link">Link (CI run, PR, recording)</option>
          </select>
        </label>
        {mode === 'screenshot' ? (
          <label className="field" htmlFor={`${id}-file`}>
            <span>File</span>
            <input id={`${id}-file`} ref={file} type="file" accept="image/png,image/jpeg,image/webp" />
          </label>
        ) : (
          <label className="field" htmlFor={`${id}-text`}>
            <span>{mode === 'link' ? 'Link' : 'Text'}</span>
            {mode === 'link' ? <input id={`${id}-text`} inputMode="url" value={text} onChange={(e) => setText(e.target.value)} placeholder="https://github.com/…/actions/runs/…" /> : <textarea id={`${id}-text`} rows={3} maxLength={8000} value={text} onChange={(e) => setText(e.target.value)} placeholder="Secrets and customer details are removed when saved." />}
          </label>
        )}
      </div>
      <div className="cc-actions">
        <button type="button" className="btn btn-quiet btn-sm" onClick={add} disabled={save.pending}>
          {save.pending ? 'Attaching…' : 'Attach evidence'}
        </button>
        <SaveStatus save={save} />
      </div>
    </div>
  )
}

// A copyable block (Claude Code prompt): shows the text selected-ready; Copy uses the clipboard and says so.
export function CopyBlock({ text, label = 'Copy prompt', id }) {
  const [msg, setMsg] = useState('')
  const ref = useRef(null)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setMsg('Copied.')
    } catch {
      ref.current?.select()
      setMsg('Selected: press Ctrl+C or ⌘C to copy.')
    }
  }
  return (
    <div className="stack">
      <textarea ref={ref} id={id} className="qa-pre" readOnly rows={10} value={text} aria-label="Prompt text" data-prompt-text />
      <div className="cc-actions">
        <button type="button" className="btn btn-quiet btn-sm" onClick={copy}>
          {label}
        </button>
        <span className="cc-status-line" role="status">
          {msg}
        </span>
      </div>
    </div>
  )
}

// A destructive-ish confirm in the page (cancel a run).
export function ConfirmButton({ label, question, detail, confirmLabel, onConfirm, danger = true, ...rest }) {
  const [asking, setAsking] = useState(false)
  const [busy, setBusy] = useState(false)
  if (!asking)
    return (
      <button type="button" className="btn btn-quiet btn-sm" onClick={() => setAsking(true)} {...rest}>
        {label}
      </button>
    )
  return (
    <ConfirmInline
      question={question}
      detail={detail}
      confirmLabel={confirmLabel}
      danger={danger}
      busy={busy}
      onCancel={() => setAsking(false)}
      onConfirm={async () => {
        setBusy(true)
        await onConfirm()
        setBusy(false)
        setAsking(false)
      }}
    />
  )
}
