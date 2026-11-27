// QA → Manual: the checks that need a person (and AI-assisted ones a person confirms), as guided step cards:
// what to do, prerequisites, expected outcome, the result (pass / fail / blocked / skipped / unverified / retest
// required), what actually happened, and evidence. Below them, the guided journey sessions from the earlier Testing
// tab (activation measurement, sessions in progress, completed sessions), unchanged.
import { useMemo, useState } from 'react'
import { Badge, Empty, Link, LoadError, Loading, PageHead, Section } from '../ui.jsx'
import { SaveStatus } from '../../../dashboard/ui.jsx'
import { useSaveState } from '../../../dashboard/ui-hooks.js'
import * as qa from '../qa-api.js'
import { MANUAL_RESULTS, RESULT, allTests, share, stamp } from '../qa-lib.js'
import { ClassPill, EvidenceUpload, TestStatus } from './parts.jsx'
import { useLoad } from './hooks.jsx'
import Testing from '../../Qa.jsx'

const DONE = ['verified', 'verified_ci_only']

// One guided check. Saving appends a result (it never overwrites an earlier one); evidence attaches to that result.
export function ManualCard({ t, onSaved, executionId, go }) {
  const [status, setStatus] = useState('')
  const [actual, setActual] = useState('')
  // AI-assisted checks: an AI's assessment may be pasted alongside; it is stored as labelled evidence and is never the
  // result (the result is always the person's choice below).
  const [aiText, setAiText] = useState('')
  const [aiModel, setAiModel] = useState('')
  const [err, setErr] = useState('')
  const [saved, setSaved] = useState(null)
  const save = useSaveState()
  const id = `qm-${String(t.id).replace(/[^a-z0-9]/gi, '-').slice(-60)}`
  const ai = t.aiAssessment
  const submit = (e) => {
    e.preventDefault()
    if (!status) {
      setErr('Choose a result first.')
      return
    }
    if (['fail', 'blocked'].includes(status) && !actual.trim()) {
      setErr('Say what happened, so the result can be followed up.')
      return
    }
    setErr('')
    save.run(async () => {
      const r = await qa.recordResult({ testId: t.id, executionId: executionId || undefined, status, actual: actual.trim() || undefined, expected: t.steps?.expected || undefined, ...(aiText.trim() ? { aiAssessment: { text: aiText.trim(), model: aiModel.trim() || undefined } } : {}) })
      if (!r.ok) return { error: r.error }
      const res = r.data?.result || {}
      const verified = qa.arr(r.data?.items).filter((i) => i.status === 'verified')
      setSaved({ id: res.id, status, at: res.at || Date.now(), revision: res.revision, verified })
      setAiText('')
      setAiModel('')
      onSaved?.(r.data)
      return { saved: `Recorded: ${RESULT[status][1]}.` }
    })
  }
  return (
    <form className="qa-card" onSubmit={submit} data-manual={t.id} aria-labelledby={`${id}-h`} noValidate>
      <div className="qa-card-head">
        <h3 id={`${id}-h`}>{t.title}</h3>
        <TestStatus s={t.status} />
        <ClassPill c={t.class} />
      </div>
      {qa.arr(t.prerequisites).length > 0 && (
        <div className="cc-callout">
          <span className="cc-label">Before you start</span>
          <ul className="qa-plain-list">
            {t.prerequisites.map((p, k) => (
              <li key={k}>{qa.setupText(p)}</li>
            ))}
          </ul>
        </div>
      )}
      <div className="qa-do">
        <div className="cc-callout">
          <span className="cc-label">What to do</span>
          <span>{t.steps?.action || t.instructions || 'Follow the journey step named above.'}</span>
        </div>
        <div className="cc-callout">
          <span className="cc-label">Expected result</span>
          <span>{t.steps?.expected || t.expected || 'Not written down yet: record what you saw.'}</span>
        </div>
      </div>
      {ai && (
        <div className="cc-callout" data-ai-assessment>
          <span>
            <Badge tone="info" plain>
              AI assessment, not a verified result
            </Badge>
          </span>
          <span>{ai.text || String(ai)}</span>
          <span className="cc-status-line">
            {ai.model ? `${ai.model} · ` : ''}
            {ai.at ? stamp(ai.at) : ''} Confirm or correct it with your own result below.
          </span>
        </div>
      )}
      {t.last && (
        <p className="cc-status-line">
          Last recorded {stamp(t.last.at)}: {RESULT[t.last.status]?.[1] || t.last.status}.
        </p>
      )}
      {t.class === 'ai_assisted' && (
        <details className="cc-details" data-ai-paste>
          <summary>Add the AI’s assessment (optional, labelled, never the result)</summary>
          <div className="stack">
            <label className="field" htmlFor={`${id}-ai`}>
              <span>AI assessment</span>
              <textarea id={`${id}-ai`} rows={3} maxLength={4000} value={aiText} onChange={(e) => setAiText(e.target.value)} placeholder="e.g. the factual check of the transcript: which statements matched the business records." />
            </label>
            <label className="field" htmlFor={`${id}-aim`}>
              <span>
                Model <em>optional</em>
              </span>
              <input id={`${id}-aim`} maxLength={80} value={aiModel} onChange={(e) => setAiModel(e.target.value)} placeholder="claude-opus-5-5" />
            </label>
            <p className="cc-status-line">It is saved as evidence marked “AI assessment”. Your own result below is what counts; subjective things like voice quality are yours to judge.</p>
          </div>
        </details>
      )}
      <fieldset className="qa-group">
        <legend>{t.class === 'ai_assisted' ? 'Your result' : 'Result'}</legend>
        <div className="qa-options" role="radiogroup" aria-label={`Result for ${t.title}`}>
          {MANUAL_RESULTS.map((s) => (
            <label key={s} className={`qa-option qa-option--${s}`}>
              <input type="radio" name={`${id}-result`} value={s} checked={status === s} onChange={() => setStatus(s)} />
              <span>{RESULT[s][1]}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <label className="field" htmlFor={`${id}-obs`}>
        <span>What actually happened {['fail', 'blocked'].includes(status) ? '' : <em>optional</em>}</span>
        <textarea id={`${id}-obs`} rows={3} maxLength={1000} value={actual} onChange={(e) => setActual(e.target.value)} placeholder="Describe what you saw. No customer names, emails or phone numbers." aria-invalid={err && status ? 'true' : undefined} />
      </label>
      {err && (
        <p className="form-error" role="alert">
          {err}
        </p>
      )}
      <div className="cc-actions">
        <button type="submit" className="btn btn-primary btn-sm" disabled={save.pending}>
          {save.pending ? 'Saving…' : 'Save result'}
        </button>
        <SaveStatus save={save} />
      </div>
      {saved?.id && (
        <div className="stack" data-manual-saved={saved.status}>
          <p className="cc-status-line">
            Saved {stamp(saved.at)}{saved.revision ? ` against release ${String(saved.revision).slice(0, 7)}` : ''}. Earlier results are kept.
            {saved.verified.length > 0 && ` This pass verified ${saved.verified.length === 1 ? 'a defect' : `${saved.verified.length} defects`}.`}
            {saved.status === 'fail' && (
              <>
                {' '}
                <Link to={{ view: 'qa', tab: 'defects', from: t.id, result: saved.id }} go={go} className="cc-more">
                  Record a defect from this →
                </Link>
              </>
            )}
          </p>
          <EvidenceUpload ownerKind="result" ownerId={saved.id} idBase={`${id}-ev`} />
        </div>
      )}
    </form>
  )
}

export function ManualView({ o, params, go }) {
  const [d, reload] = useLoad(async () => {
    const [h, a] = await Promise.all([qa.getInventory({ cls: 'human' }), qa.getInventory({ cls: 'ai_assisted' })])
    return h.ok && a.ok ? { ok: true, data: { human: h.data, ai: a.data } } : h.ok ? h : { ...h, ok: false }
  }, [])
  const [show, setShow] = useState('todo')
  const groups = useMemo(() => {
    if (!d || d.error) return []
    const human = qa.normalizeInventory(d.human)
    const ai = qa.normalizeInventory(d.ai)
    // One group per area, in the server's order; each test once.
    const seen = new Set()
    const out = []
    for (const area of [...human.areas, ...ai.areas]) {
      const ts = allTests(area).filter((t) => (t.class === 'human' || t.class === 'ai_assisted') && !seen.has(t.id) && seen.add(t.id))
      if (!ts.length) continue
      const g = out.find((x) => x.id === area.id)
      if (g) g.tests.push(...ts)
      else out.push({ id: area.id, title: area.title, tests: ts })
    }
    return out
  }, [d])
  const all = groups.flatMap((g) => g.tests)
  const done = all.filter((t) => DONE.includes(t.status)).length
  const visible = groups.map((g) => ({ ...g, tests: show === 'todo' ? g.tests.filter((t) => !DONE.includes(t.status)) : g.tests })).filter((g) => g.tests.length)
  return (
    <div className="cc-main" data-qa-manual>
      <PageHead go={go} title="Manual checks" lede="Checks that need a person. Each says what to do and what should happen; your result and evidence are saved with the release you checked." />
      <Section title="Checks on the current release" id="qa-m-list" sub={d && !d.error ? `${share(done, all.length)} verified.` : null}>
        <div className="cc-section-body">
          <div className="cc-chips" role="group" aria-label="Show">
            <button type="button" className="cc-chip" aria-pressed={show === 'todo'} onClick={() => setShow('todo')}>
              Still to do
            </button>
            <button type="button" className="cc-chip" aria-pressed={show === 'all'} onClick={() => setShow('all')}>
              All
            </button>
          </div>
          {d === undefined ? (
            <Loading label="Loading manual checks…" />
          ) : d.error ? (
            <LoadError what="manual checks" onRetry={reload} />
          ) : !all.length ? (
            <Empty title="No manual checks in the inventory yet.">The guided journeys below still work.</Empty>
          ) : !visible.length ? (
            <Empty title="Every manual check is verified on this release." />
          ) : (
            visible.map((g) => (
              <details key={g.id} className="cc-details qa-area" open={visible.length <= 2} data-manual-area={g.id}>
                <summary>
                  {g.title} ({g.tests.length})
                </summary>
                <div className="stack">
                  {g.tests.map((t) => (
                    <ManualCard key={t.id} t={t} go={go} onSaved={() => reload(true)} />
                  ))}
                </div>
              </details>
            ))
          )}
        </div>
      </Section>
      <div className="qa-legacy" data-qa-guided>
        <Testing o={o} params={params} go={go} embedded />
      </div>
    </div>
  )
}
