// QA → Defects and Backlog: one record type (qa_items), two lists. Defects = bugs and regressions (open → in progress →
// fixed, awaiting retest → verified ONLY by a passing retest recorded after the fix). Backlog = ideas, requests and
// improvements (Inbox → … → Released / Deferred); recording one never starts work, the founder moves it.
// Each item: evidence, linked tests, PR / commit / release references, an append-only history, and a copyable
// Claude Code prompt built by the server from the recorded evidence.
import { useEffect, useRef, useState } from 'react'
import { Badge, Empty, Facts, Link, LoadError, Loading, PageHead, Section, Severity } from '../ui.jsx'
import { SaveStatus } from '../../../dashboard/ui.jsx'
import { useSaveState } from '../../../dashboard/ui-hooks.js'
import * as qa from '../qa-api.js'
import { BACKLOG_KINDS, BACKLOG_STATUS, DEFECT_CHOICES, DEFECT_KINDS, DEFECT_STATUS, KINDS, PRIORITY, RESULT, SEVERITY, isDefect, sha, stamp, statusMap, toggleSelection } from '../qa-lib.js'
import { CopyBlock, EvidenceList, EvidenceUpload, ItemStatus, ResultPill, TestStatus } from './parts.jsx'
import { useAreas, useLoad, usePlan } from './hooks.jsx'

const areaName = (areas, id) => areas.find((a) => a.id === id)?.title || id

const crumbs = [
  ['Control Center', {}],
  ['QA', { view: 'qa' }],
]
const LISTS = {
  defects: { title: 'Defects', kinds: DEFECT_KINDS, statuses: DEFECT_STATUS, lede: 'Bugs and regressions found by tests or by people. A defect is verified only by a passing retest after its fix, never because a fix was merged.' },
  backlog: { title: 'Backlog', kinds: BACKLOG_KINDS, statuses: BACKLOG_STATUS, lede: 'Ideas, requests and improvements. Recording one never starts work: you decide what moves to Planned.' },
}

// ---------- create ----------
function NewItem({ list, from, result, go, onCancel }) {
  const areas = useAreas()
  const L = LISTS[list]
  const [f, setF] = useState({ kind: L.kinds[0], title: from ? `Fails: ${from.split(/[›>]/).pop().trim().slice(0, 100)}` : '', description: '', expected: '', actual: '', steps: '', area: '', feature: '', severity: 'medium', priority: 'p3', customerImpact: '', release: '' })
  const [errs, setErrs] = useState({})
  const save = useSaveState()
  const first = useRef(null)
  useEffect(() => first.current?.focus(), [])
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value })
  const defect = isDefect(f.kind)
  const submit = (e) => {
    e.preventDefault()
    const x = {}
    if (!f.title.trim()) x.title = 'Give it a short title.'
    if (defect && !f.actual.trim() && !result) x.actual = 'Say what actually happens.'
    setErrs(x)
    if (Object.keys(x).length) return document.getElementById(`qa-new-${Object.keys(x)[0]}`)?.focus()
    save.run(async () => {
      const r = await qa.createItem({
        kind: f.kind,
        title: f.title.trim(),
        description: f.description.trim(),
        expected: defect ? f.expected.trim() : undefined,
        actual: defect ? f.actual.trim() : undefined,
        steps: defect ? f.steps.trim() : undefined,
        area: f.area || undefined,
        feature: f.feature.trim() || undefined,
        severity: defect ? f.severity : undefined,
        priority: f.priority,
        customerImpact: f.customerImpact.trim() || undefined,
        testIds: from ? [from] : [],
        fromResult: result || undefined,
        refs: f.release.trim() ? { release: f.release.trim() } : undefined,
      })
      if (!r.ok) return { error: r.error }
      go({ view: 'qa', item: r.data.item.id, list: isDefect(f.kind) ? null : 'backlog' })
      return { saved: 'Saved.' }
    })
  }
  const field = (k, label, el, optional = false) => (
    <label className="field" htmlFor={`qa-new-${k}`}>
      <span>
        {label} {optional && <em>optional</em>}
      </span>
      {el}
      {errs[k] && (
        <span className="field-error" id={`qa-new-${k}-err`}>
          {errs[k]}
        </span>
      )}
    </label>
  )
  const inv = (k) => ({ id: `qa-new-${k}`, 'aria-invalid': errs[k] ? 'true' : undefined, 'aria-describedby': errs[k] ? `qa-new-${k}-err` : undefined })
  return (
    <form className="qa-card" onSubmit={submit} noValidate data-new-item={list}>
      <h2>{list === 'defects' ? 'Record a defect' : 'Add to the backlog'}</h2>
      {from && (
        <p className="cc-status-line">
          Linked to the test <span className="cc-code">{from}</span>
          {result ? ' and its failed result (its evidence is attached).' : '.'}
        </p>
      )}
      <div className="field-row">
        {field(
          'kind',
          'Kind',
          <select {...inv('kind')} value={f.kind} onChange={set('kind')}>
            {L.kinds.map((k) => (
              <option key={k} value={k}>
                {KINDS[k]}
              </option>
            ))}
          </select>,
        )}
        {field('title', 'Title', <input {...inv('title')} ref={first} maxLength={140} value={f.title} onChange={set('title')} placeholder={defect ? 'Booking page shows no times after a reconnect' : 'Show the time zone next to booked times'} />)}
      </div>
      {field('description', 'Description', <textarea {...inv('description')} rows={3} maxLength={4000} value={f.description} onChange={set('description')} placeholder="No customer names, emails or phone numbers." />, true)}
      {defect && (
        <>
          <div className="field-row">
            {field('expected', 'Expected', <textarea {...inv('expected')} rows={2} maxLength={1000} value={f.expected} onChange={set('expected')} />, true)}
            {field('actual', 'Actual', <textarea {...inv('actual')} rows={2} maxLength={1000} value={f.actual} onChange={set('actual')} />, !!result)}
          </div>
          {field('steps', 'Steps to reproduce', <textarea {...inv('steps')} rows={3} maxLength={2000} value={f.steps} onChange={set('steps')} placeholder={'1. Open …\n2. …'} />, true)}
        </>
      )}
      <div className="field-row">
        {field(
          'area',
          'Product area',
          <select {...inv('area')} value={f.area} onChange={set('area')}>
            <option value="">Not set</option>
            {areas.map((a) => (
              <option key={a.id} value={a.id}>
                {a.title}
              </option>
            ))}
          </select>,
          true,
        )}
        {field('feature', 'Feature', <input {...inv('feature')} maxLength={80} value={f.feature} onChange={set('feature')} placeholder="booking.slots" />, true)}
      </div>
      <div className="field-row">
        {defect &&
          field(
            'severity',
            'Severity',
            <select {...inv('severity')} value={f.severity} onChange={set('severity')}>
              {SEVERITY.map((s) => (
                <option key={s} value={s}>
                  {s[0].toUpperCase() + s.slice(1)}
                </option>
              ))}
            </select>,
          )}
        {field(
          'priority',
          'Priority',
          <select {...inv('priority')} value={f.priority} onChange={set('priority')}>
            {Object.entries(PRIORITY).map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </select>,
        )}
      </div>
      <div className="field-row">
        {field('customerImpact', 'Customer impact', <input {...inv('customerImpact')} maxLength={300} value={f.customerImpact} onChange={set('customerImpact')} placeholder="Owners can’t see new bookings" />, true)}
        {field('release', 'Release', <input {...inv('release')} maxLength={40} value={f.release} onChange={set('release')} placeholder="Commit, e.g. 8ea75f9" />, true)}
      </div>
      <div className="cc-actions">
        <button type="submit" className="btn btn-primary btn-sm" disabled={save.pending}>
          {save.pending ? 'Saving…' : list === 'defects' ? 'Save defect' : 'Save idea'}
        </button>
        <button type="button" className="btn btn-quiet btn-sm" onClick={onCancel}>
          Cancel
        </button>
        <SaveStatus save={save} />
      </div>
    </form>
  )
}

// ---------- list ----------
export function ItemsView({ list, params, go }) {
  const L = LISTS[list]
  const [d, reload] = useLoad(() => qa.listItems({ group: list, kind: params.kind && L.kinds.includes(params.kind) ? params.kind : undefined, status: params.status, area: params.area, severity: params.sev }), [list, params.kind, params.status, params.area, params.sev])
  const areas = useAreas()
  const [adding, setAdding] = useState(!!params.from && list === 'defects')
  const [picked, setPicked] = useState(() => new Set())
  const [prompt, setPrompt] = useState(null)
  const set = (k, v) => go({ ...params, view: 'qa', tab: list, [k]: v || null }, { replace: true })
  const items = d && !d.error ? qa.arr(d.items).filter((i) => L.kinds.includes(i.kind)) : []
  const counts = d && !d.error ? d.counts?.[list] : null
  const buildPrompt = async () => {
    setPrompt({ loading: true })
    // One deterministic prompt per item from the server, joined in the order shown.
    const ids = items.filter((i) => picked.has(i.id)).map((i) => i.id)
    const rs = await Promise.all(ids.map((id) => qa.getPrompt(id)))
    const bad = rs.find((r) => !r.ok)
    setPrompt(bad ? { error: bad.error } : { text: rs.map((r, k) => `## ${k + 1} of ${rs.length}\n\n${r.data.prompt}`).join('\n\n---\n\n') })
  }
  return (
    <div className="cc-main" data-qa-items={list}>
      <PageHead go={go} crumbs={[crumbs[0]]} title={L.title} lede={L.lede} />
      {adding ? (
        <NewItem list={list} from={params.from} result={params.result} go={go} onCancel={() => (setAdding(false), params.from && go({ view: 'qa', tab: list }, { replace: true }))} />
      ) : (
        <div className="cc-actions">
          <button type="button" className="btn btn-primary btn-sm" onClick={() => setAdding(true)} data-new-item-open>
            {list === 'defects' ? 'Record a defect' : 'Add to the backlog'}
          </button>
        </div>
      )}
      <div className="cc-toolbar qa-filters">
        <label className="field qa-filter" htmlFor={`qa-i-status-${list}`}>
          <span>Status</span>
          <select id={`qa-i-status-${list}`} value={params.status || ''} onChange={(e) => set('status', e.target.value)}>
            <option value="">Any status</option>
            {Object.entries(L.statuses).map(([k, [, l]]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <label className="field qa-filter" htmlFor={`qa-i-kind-${list}`}>
          <span>Kind</span>
          <select id={`qa-i-kind-${list}`} value={params.kind || ''} onChange={(e) => set('kind', e.target.value)}>
            <option value="">Any kind</option>
            {L.kinds.map((k) => (
              <option key={k} value={k}>
                {KINDS[k]}
              </option>
            ))}
          </select>
        </label>
        <label className="field qa-filter" htmlFor={`qa-i-area-${list}`}>
          <span>Area</span>
          <select id={`qa-i-area-${list}`} value={params.area || ''} onChange={(e) => set('area', e.target.value)}>
            <option value="">Any area</option>
            {areas.map((a) => (
              <option key={a.id} value={a.id}>
                {a.title}
              </option>
            ))}
          </select>
        </label>
        {list === 'defects' && (
          <label className="field qa-filter" htmlFor="qa-i-sev">
            <span>Severity</span>
            <select id="qa-i-sev" value={params.sev || ''} onChange={(e) => set('sev', e.target.value)}>
              <option value="">Any severity</option>
              {SEVERITY.map((s) => (
                <option key={s} value={s}>
                  {s[0].toUpperCase() + s.slice(1)}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      <Section title={`${items.length} ${list === 'defects' ? (items.length === 1 ? 'defect' : 'defects') : items.length === 1 ? 'entry' : 'entries'}`} id={`qa-i-${list}`} sub={counts?.total ? `All ${list}: ${Object.entries(L.statuses).filter(([k]) => counts[k]).map(([k, [, l]]) => `${counts[k]} ${l.toLowerCase()}`).join(' · ')} (of ${counts.total})` : null}>
        {d === undefined ? (
          <Loading label="Loading…" />
        ) : d.error ? (
          <div className="cc-section-body">
            <LoadError what={L.title.toLowerCase()} onRetry={reload} />
          </div>
        ) : items.length ? (
          <ul className="cc-list">
            {items.map((i) => (
              <li key={i.id} className="qa-pick-row">
                <input type="checkbox" className="qa-tree-check" checked={picked.has(i.id)} onChange={(e) => setPicked((s) => toggleSelection(s, [i.id], e.target.checked))} aria-label={`Select ${i.title}`} />
                <Link to={{ view: 'qa', item: i.id, list: list === 'backlog' ? 'backlog' : null }} go={go} className="cc-item" data-item={i.id} data-item-status={i.status}>
                  <span className="cc-item-main">
                    <span className="cc-item-title">{i.title}</span>
                    <span className="cc-item-sub">
                      {KINDS[i.kind] || i.kind} · {i.area ? areaName(areas, i.area) : 'No area'} · {stamp(i.createdAt)}
                      {qa.arr(i.testIds).length ? ` · ${i.testIds.length} linked ${i.testIds.length === 1 ? 'test' : 'tests'}` : ''}
                    </span>
                  </span>
                  <span className="cc-item-meta">
                    {i.severity && <Severity s={i.severity} />}
                    {i.priority && PRIORITY[i.priority] && (
                      <Badge tone="neutral" plain>
                        {PRIORITY[i.priority]}
                      </Badge>
                    )}
                    <ItemStatus item={i} />
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <Empty title={list === 'defects' ? 'No defects recorded.' : 'The backlog is empty.'}>{list === 'defects' ? 'Failed results and manual observations can be recorded as defects.' : 'Use “Note an idea” on any QA screen.'}</Empty>
        )}
      </Section>
      {picked.size > 0 && (
        <div className="qa-selbar" role="region" aria-label="Selected items">
          <span>
            <b>{picked.size}</b> selected
          </span>
          <button type="button" className="btn btn-quiet btn-sm" onClick={buildPrompt}>
            Claude Code prompt for selected
          </button>
          <button type="button" className="btn btn-quiet btn-sm" onClick={() => (setPicked(new Set()), setPrompt(null))}>
            Clear selection
          </button>
        </div>
      )}
      {prompt && (
        <Section title="Claude Code prompt" id="qa-i-prompt" sub="Built from the recorded evidence. Copying it doesn’t start or authorize any work.">
          <div className="cc-section-body">{prompt.loading ? <Loading label="Building the prompt…" /> : prompt.error ? <p className="form-error" role="alert">{prompt.error}</p> : <CopyBlock text={prompt.text} />}</div>
        </Section>
      )}
    </div>
  )
}

// ---------- one item ----------
function StatusControl({ item, onChanged }) {
  const defect = isDefect(item.kind)
  const choices = defect ? DEFECT_CHOICES : Object.keys(BACKLOG_STATUS)
  const [status, setStatus] = useState(choices.includes(item.status) ? item.status : choices[0])
  const [note, setNote] = useState('')
  const save = useSaveState()
  const submit = (e) => {
    e.preventDefault()
    if (status === item.status && !note.trim()) return save.run(async () => false)
    save.run(async () => {
      const r = await qa.updateItem(item.id, 'status', { status, note: note.trim() || undefined })
      if (!r.ok) return { error: r.error }
      setNote('')
      onChanged()
      return { saved: `Status: ${statusMap(item.kind)[status]?.[1] || status}.` }
    })
  }
  return (
    <form className="stack" onSubmit={submit} data-item-status-form>
      <div className="field-row">
        <label className="field" htmlFor="qa-it-status">
          <span>Status</span>
          <select id="qa-it-status" value={status} onChange={(e) => setStatus(e.target.value)}>
            {choices.map((s) => (
              <option key={s} value={s}>
                {statusMap(item.kind)[s][1]}
              </option>
            ))}
            {defect && item.status === 'verified' && (
              <option value="verified" disabled>
                {DEFECT_STATUS.verified[1]}
              </option>
            )}
          </select>
        </label>
        <label className="field" htmlFor="qa-it-note">
          <span>
            Note <em>optional</em>
          </span>
          <input id="qa-it-note" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
        </label>
      </div>
      <p className="cc-status-line">{defect ? 'Verified is set only by a passing retest recorded after the fix.' : 'Moving an entry is your decision. Nothing starts automatically.'}</p>
      <div className="cc-actions">
        <button type="submit" className="btn btn-quiet btn-sm" disabled={save.pending}>
          {save.pending ? 'Saving…' : 'Save status'}
        </button>
        <SaveStatus save={save} />
      </div>
    </form>
  )
}

function LinkRefs({ item, onChanged }) {
  const refs = item.refs || {}
  const [f, setF] = useState({ pr: refs.pr || '', commit: refs.commit || '', release: refs.release || '' })
  const [err, setErr] = useState('')
  const save = useSaveState()
  const submit = (e) => {
    e.preventDefault()
    const pr = String(f.pr).replace(/^#/, '').trim()
    if (pr && !/^\d{1,6}$/.test(pr)) return setErr('Use the PR number, e.g. 190.')
    if (f.commit.trim() && !/^[0-9a-f]{7,40}$/i.test(f.commit.trim())) return setErr('Use a commit id (7 to 40 letters and digits).')
    setErr('')
    save.run(async () => {
      const r = await qa.updateItem(item.id, 'link', { pr: pr ? Number(pr) : null, commit: f.commit.trim() || null, release: f.release.trim() || null })
      if (!r.ok) return { error: r.error }
      onChanged()
      return { saved: 'Links saved.' }
    })
  }
  return (
    <form className="stack" onSubmit={submit} noValidate data-item-links>
      <div className="field-row">
        <label className="field" htmlFor="qa-it-pr">
          <span>Pull request</span>
          <input id="qa-it-pr" inputMode="numeric" value={f.pr} onChange={(e) => setF({ ...f, pr: e.target.value })} placeholder="190" aria-invalid={err ? 'true' : undefined} />
        </label>
        <label className="field" htmlFor="qa-it-commit">
          <span>Fix commit</span>
          <input id="qa-it-commit" value={f.commit} onChange={(e) => setF({ ...f, commit: e.target.value })} placeholder="8ea75f9" />
        </label>
        <label className="field" htmlFor="qa-it-release">
          <span>Release</span>
          <input id="qa-it-release" value={f.release} onChange={(e) => setF({ ...f, release: e.target.value })} placeholder="Deployment or commit" />
        </label>
      </div>
      {err && (
        <p className="form-error" role="alert">
          {err}
        </p>
      )}
      <div className="cc-actions">
        <button type="submit" className="btn btn-quiet btn-sm" disabled={save.pending}>
          {save.pending ? 'Saving…' : 'Save links'}
        </button>
        <SaveStatus save={save} />
      </div>
    </form>
  )
}

const EVENT = { created: 'Recorded', status: 'Status changed', link: 'Links changed', note: 'Note', retest: 'Retest result', evidence: 'Evidence attached', verified: 'Verified by retest' }

export function ItemDetail({ id, go }) {
  const [d, reload] = useLoad(() => qa.getItem(id), [id])
  const [openPlan, plan] = usePlan(go)
  const [prompt, setPrompt] = useState(null)
  const areas = useAreas()
  if (d === undefined) return <Loading label="Loading…" />
  if (d.error) return d.status === 404 ? <Empty title="Not found.">It may have been removed.</Empty> : <LoadError what="this item" onRetry={reload} />
  const i = d.item || d
  const defect = isDefect(i.kind)
  const list = defect ? 'defects' : 'backlog'
  const tests = qa.arr(i.testIds)
  const retests = qa.arr(d.events).filter((e) => e.type === 'retest' || e.type === 'verified')
  const testInfo = Object.fromEntries(qa.arr(d.tests).map((t) => [t.id, t]))
  const events = qa.arr(d.events)
  const refresh = () => reload(true)
  const showPrompt = async () => {
    setPrompt({ loading: true })
    const r = await qa.getPrompt(i.id)
    setPrompt(r.ok ? { text: r.data.prompt || '', basedOn: r.data.basedOn } : { error: r.error })
  }
  return (
    <div className="cc-main" data-qa-item={i.id} data-item-kind={i.kind} data-item-status={i.status}>
      <PageHead go={go} crumbs={[...crumbs, [LISTS[list].title, { view: 'qa', tab: list }]]} title={i.title}>
        {i.severity && <Severity s={i.severity} />}
        <ItemStatus item={i} />
      </PageHead>
      {plan}
      <Facts
        items={[
          ['Kind', KINDS[i.kind] || i.kind],
          ['Area', i.area ? areaName(areas, i.area) : 'Not set'],
          i.feature && ['Feature', i.feature],
          i.priority && ['Priority', PRIORITY[i.priority] || i.priority],
          i.customerImpact && ['Customer impact', i.customerImpact],
          ['Recorded', `${stamp(i.createdAt)}${i.createdBy ? ` by ${i.createdBy}` : ''}`],
          i.refs?.pr && ['Pull request', `#${i.refs.pr}`],
          i.refs?.commit && ['Fix commit', <span key="c" className="cc-code">{sha(i.refs.commit)}</span>],
          i.refs?.release && ['Release', i.refs.release],
        ]}
      />
      {(i.description || i.expected || i.actual || i.steps) && (
        <div className="qa-do">
          {i.description && (
            <div className="cc-callout">
              <span className="cc-label">Description</span>
              <span className="qa-text">{i.description}</span>
            </div>
          )}
          {i.steps && (
            <div className="cc-callout">
              <span className="cc-label">Steps to reproduce</span>
              <span className="qa-text">{i.steps}</span>
            </div>
          )}
          {i.expected && (
            <div className="cc-callout">
              <span className="cc-label">Expected</span>
              <span className="qa-text">{i.expected}</span>
            </div>
          )}
          {i.actual && (
            <div className="cc-callout">
              <span className="cc-label">Actual</span>
              <span className="qa-text">{i.actual}</span>
            </div>
          )}
        </div>
      )}
      {defect && (
        <Section title="Retest" id="qa-it-retest" sub="A pass recorded after the fix marks this defect verified. A failure keeps it open; every result is kept.">
          <div className="cc-section-body">
            {tests.length ? (
              <div className="cc-actions">
                <button type="button" className="btn btn-primary btn-sm" onClick={() => openPlan({ tests, itemId: i.id }, `Retest: ${i.title}`)} data-retest>
                  Retest {tests.length === 1 ? 'the linked test' : `${tests.length} linked tests`}
                </button>
              </div>
            ) : (
              <p className="cc-status-line">No test is linked, so it can’t be retested automatically. Link a test, or record a manual result on a test page.</p>
            )}
            {retests.length > 0 && (
              <ul className="cc-list" data-retest-results>
                {retests.map((e, k) => (
                  <li key={e.detail?.result || k} className="cc-item qa-row" data-result={e.detail?.status || (e.type === 'verified' ? 'pass' : '')}>
                    <span className="cc-item-main">
                      <span className="cc-item-title">{e.type === 'verified' ? 'Verified by a passing retest' : 'Retest result'}</span>
                      <span className="cc-item-sub">
                        {stamp(e.at)}
                        {e.detail?.revision ? ` · release ${sha(e.detail.revision)}` : ''}
                        {e.detail?.afterFix === false ? ' · before the fix, does not count' : ''}
                      </span>
                    </span>
                    <span className="cc-item-meta">{e.detail?.status && <ResultPill s={e.detail.status} />}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Section>
      )}
      <div className="cc-grid-2">
        <Section title="Status" id="qa-it-st">
          <div className="cc-section-body">
            <StatusControl item={i} onChanged={refresh} />
          </div>
        </Section>
        <Section title="Pull request and release" id="qa-it-links">
          <div className="cc-section-body">
            <LinkRefs item={i} onChanged={refresh} />
          </div>
        </Section>
      </div>
      <Section title="Linked tests" id="qa-it-tests">
        {tests.length ? (
          <ul className="cc-list">
            {tests.map((t) => (
              <li key={t}>
                <Link to={{ view: 'qa', test: t }} go={go} className="cc-item">
                  <span className="cc-item-main">
                    <span className="cc-item-title">{testInfo[t]?.title || t}</span>
                    {testInfo[t]?.lastPass && <span className="cc-item-sub">Last passed {stamp(testInfo[t].lastPass.at)}</span>}
                  </span>
                  <span className="cc-item-meta">{testInfo[t] && <TestStatus s={testInfo[t].status} />}</span>
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <Empty title="No test linked." />
        )}
      </Section>
      <Section title="Evidence" id="qa-it-ev">
        <div className="cc-section-body">
          <EvidenceList items={d.evidence} />
          <EvidenceUpload ownerKind="item" ownerId={i.id} onAdded={refresh} />
        </div>
      </Section>
      <Section title="Claude Code prompt" id="qa-it-prompt" sub="Built from this record and its evidence. Copying it doesn’t start or authorize any work.">
        <div className="cc-section-body">
          {!prompt ? (
            <div>
              <button type="button" className="btn btn-quiet btn-sm" onClick={showPrompt} data-show-prompt>
                Show prompt
              </button>
            </div>
          ) : prompt.loading ? (
            <Loading label="Building the prompt…" />
          ) : prompt.error ? (
            <p className="form-error" role="alert">
              {prompt.error}
            </p>
          ) : (
            <CopyBlock text={prompt.text} id="qa-it-prompt-text" />
          )}
        </div>
      </Section>
      <Section title="History" id="qa-it-hist" sub="Every change is kept, oldest first.">
        <div className="cc-section-body">
          {events.length ? (
            <ol className="cc-timeline" data-item-history>
              {events.map((e, k) => (
                <li key={e.id || k}>
                  <time>{stamp(e.at)}</time>
                  <span>
                    {EVENT[e.type] || e.type}
                    {e.to && e.type !== 'retest' ? `: ${e.from ? `${statusMap(i.kind)[e.from]?.[1] || e.from} → ` : ''}${statusMap(i.kind)[e.to]?.[1] || e.to}` : ''}
                    {e.detail?.status ? `: ${RESULT[e.detail.status]?.[1] || e.detail.status}` : ''}
                    {e.detail?.text || e.detail?.note ? ` · ${e.detail.text || e.detail.note}` : ''}
                    {e.detail?.pr ? ` · PR #${e.detail.pr}` : ''}
                    {e.actor ? ` · ${String(e.actor).startsWith('system:') ? 'automatic' : e.actor}` : ''}
                  </span>
                </li>
              ))}
            </ol>
          ) : (
            <p className="cc-status-line">No changes since it was recorded.</p>
          )}
        </div>
      </Section>
    </div>
  )
}
