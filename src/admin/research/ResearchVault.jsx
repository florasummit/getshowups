// Research Vault screen (/admin/research-vault). Not linked anywhere; the server authorizes every request and answers 404
// otherwise, which this page shows as "Not found". No formulas or research logic live here: models are evaluated on the
// server (POST evaluate) and this page only draws the points it gets back.
import { useCallback, useEffect, useRef, useState } from 'react'
import { api, noIndex } from '../../lib/api.js'
import { Pill, TabBar } from '../../dashboard/ui.jsx'
import { usePageTitle } from '../../dashboard/ui-hooks.js'
import '../../app.css'
import './research.css'

const URL_ = '/api/research/vault'
const TABS = [
  ['overview', 'Overview', '/admin/research-vault'],
  ['models', 'Models', '/admin/research-vault/models'],
  ['records', 'Records', '/admin/research-vault/records'],
  ['experiments', 'Experiments', '/admin/research-vault/experiments'],
  ['decisions', 'Decisions', '/admin/research-vault/decisions'],
  ['data', 'Data', '/admin/research-vault/data'],
]
const tabFor = (p) => TABS.find(([, , h]) => h !== '/admin/research-vault' && p.startsWith(h))?.[0] || 'overview'
const usd = (c) => (c == null ? '—' : `$${(c / 100).toLocaleString('en-US', { maximumFractionDigits: 0 })}`)
const fmt = (v) => (v == null ? '—' : typeof v === 'number' ? v.toLocaleString('en-US', { maximumFractionDigits: 4 }) : Array.isArray(v) ? v.map(fmt).join(', ') : String(v))
const KIND_TONE = { measured: 'ok', estimated: 'warn', simulated: 'neutral', test: 'neutral', missing: 'bad', unverified: 'warn' }
const ERR = { invalid_record: 'Some required fields are missing: ', stale: 'Changed elsewhere; reload first.', recent_sign_in_required: 'Sign in again (changes need a sign-in from the last 12 hours).', rate_limited: 'Too many requests; wait a minute.' }
const errText = (d) => `${ERR[d?.error] || 'Not saved.'}${d?.fields ? d.fields.join(', ') : ''}`

export default function ResearchVault() {
  const [tab, setTab] = useState(() => tabFor(window.location.pathname))
  const [state, setState] = useState(undefined)
  const load = useCallback(() => api(`${URL_}?view=overview`).then(({ status, data }) => setState(status === 200 ? data : { denied: status })), [])
  usePageTitle('Research')
  useEffect(() => {
    noIndex()
    load()
    const onPop = () => setTab(tabFor(window.location.pathname))
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [load])
  if (state === undefined) return <main className="rv-page" aria-busy="true" />
  if (state.denied) return <main className="rv-page"><h1 className="title">Not found</h1></main>
  const go = (id) => {
    const href = TABS.find(([t]) => t === id)[2]
    window.history.pushState(null, '', href)
    setTab(id)
  }
  return (
    <main className="rv-page" data-research-vault>
      <h1 className="title title--page">Research</h1>
      <p className="fine">Confidential. Deterministic: no AI calls. Every number says whether it is measured, estimated, simulated or missing.</p>
      <TabBar label="Research sections" tabs={TABS} current={tab} onGo={go} />
      {tab === 'overview' && <Overview s={state} reload={load} go={go} />}
      {tab === 'models' && <Models models={state.models} />}
      {tab === 'records' && <Records />}
      {tab === 'experiments' && <Experiments />}
      {tab === 'decisions' && <Decisions />}
      {tab === 'data' && <Data />}
    </main>
  )
}

function Overview({ s, reload, go }) {
  const [scan, setScan] = useState(null)
  const runScan = async () => {
    const { status, data } = await api(URL_, { method: 'POST', body: { action: 'scan' } })
    setScan(status === 200 ? data : { error: errText(data) })
    reload()
  }
  return (
    <>
      <section className="card">
        <h2 className="card-title">Where the research stands</h2>
        <p className="fine">
          {s.counts.total} records · {s.counts.contradicted} contradicted · {s.counts.completedExperiments} completed experiments · {s.counts.recommendations} recommendations. Your role: {s.you.role}.
        </p>
        <p>
          <button type="button" className="btn btn-sm" onClick={runScan}>
            Look for new evidence
          </button>{' '}
          <span className="fine">Compares the last 30 days with the 30 before for GetShowUps-owned businesses; proposes an observation only on enough data.</span>
        </p>
        {scan && <p className="fine" role="status">{scan.error || scan.note}</p>}
      </section>
      <section className="card">
        <h2 className="card-title">Research programs</h2>
        {!s.programs.length && <p className="fine">No programs recorded yet. Import your program list below (kept outside the public code).</p>}
        <ul className="rows" data-programs>
          {s.programs.map((p) => (
            <li key={p.id} className="row">
              <div className="row-main">
                <p className="row-title">
                  {p.id} · {p.title} <Pill tone={p.ready ? 'ok' : 'neutral'}>{p.ready ? 'Has data' : 'Dormant'}</Pill>
                </p>
                <p className="row-sub">{p.question}</p>
                <p className="fine">
                  {p.ready ? `${p.records} records.` : `Waits for ${p.dormantUntil}.`} {p.models.length ? `Model: ${p.models.join(', ')}.` : 'No model yet.'}
                </p>
              </div>
            </li>
          ))}
        </ul>
      </section>
      <section className="card">
        <h2 className="card-title">What is unproven</h2>
        {s.gaps.every((g) => !g.items.length) ? <p className="fine">Nothing unproven is recorded yet (there are few records).</p> : s.gaps.filter((g) => g.items.length).map((g) => <p key={g.gap} className="fine"><strong>{g.gap}:</strong> {g.items.map((i) => i.title).join(' · ')}</p>)}
        <p className="fine">Cross-account research: {s.crossAccount.enabled ? 'on' : `off. ${s.crossAccount.reason}`}</p>
      </section>
      <ImportRecords onDone={reload} />
      {s.topDecisions.length > 0 && (
        <section className="card">
          <h2 className="card-title">Top decisions</h2>
          <DecisionList list={s.topDecisions} />
          <button type="button" className="btn btn-sm btn-quiet" onClick={() => go('decisions')}>
            All decisions
          </button>
        </section>
      )}
    </>
  )
}

// Paste a JSON list of records ([{ kind, record }], at most 50), e.g. the program list from your local file.
function ImportRecords({ onDone }) {
  const [text, setText] = useState('')
  const [msg, setMsg] = useState('')
  const run = async (e) => {
    e.preventDefault()
    let records
    try {
      records = JSON.parse(text)
    } catch {
      setMsg('That is not valid JSON.')
      return
    }
    const { status, data } = await api(URL_, { method: 'POST', body: { action: 'import', records } })
    setMsg(status === 200 ? `Created ${data.created.length}, skipped ${data.skipped.length} already present, refused ${data.refused.length}${data.refused.length ? ` (${data.refused.map((r) => `#${r.index}: ${r.fields.join(', ')}`).join('; ')})` : ''}.` : errText(data))
    if (status === 200) {
      setText('')
      onDone()
    }
  }
  return (
    <section className="card">
      <h2 className="card-title">Import records</h2>
      <form className="form" onSubmit={run} data-import>
        <label className="field">
          <span>JSON list of {'{ kind, record }'} (at most 50)</span>
          <textarea rows={4} value={text} onChange={(e) => setText(e.target.value)} />
        </label>
        <button className="btn btn-sm" type="submit">Import</button>
        {msg && <p className="fine" role="status">{msg}</p>}
      </form>
    </section>
  )
}

// ---------- models ----------
function Chart({ data }) {
  if (!data?.series?.length) return null
  const W = 640
  const H = 280
  const pad = { l: 56, r: 16, t: 12, b: 36 }
  const main = data.series.filter((s) => s.axis !== 'right')
  const pts = main.flatMap((s) => s.points)
  const xs = pts.map((p) => p[0])
  const ys = pts.map((p) => p[1])
  const [x0, x1] = [Math.min(...xs), Math.max(...xs) || 1]
  const [y0, y1] = [Math.min(0, ...ys), Math.max(0, ...ys) || 1]
  const X = (x) => pad.l + ((x - x0) / (x1 - x0 || 1)) * (W - pad.l - pad.r)
  const Y = (y) => H - pad.b - ((y - y0) / (y1 - y0 || 1)) * (H - pad.t - pad.b)
  return (
    <figure className="rv-chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={main.map((s) => s.name).join(', ')}>
        <line x1={pad.l} x2={W - pad.r} y1={Y(0)} y2={Y(0)} className="rv-axis" />
        <line x1={pad.l} x2={pad.l} y1={pad.t} y2={H - pad.b} className="rv-axis" />
        {[y0, (y0 + y1) / 2, y1].map((v) => (
          <text key={v} x={pad.l - 6} y={Y(v) + 4} textAnchor="end" className="rv-tick">{fmt(Math.round(v))}</text>
        ))}
        {[x0, (x0 + x1) / 2, x1].map((v) => (
          <text key={v} x={X(v)} y={H - pad.b + 16} textAnchor="middle" className="rv-tick">{fmt(Math.round(v))}</text>
        ))}
        {main.map((s, i) => (
          <polyline key={s.name} fill="none" className={`rv-line rv-line-${i}`} points={s.points.map((p) => `${X(p[0])},${Y(p[1])}`).join(' ')} />
        ))}
        {(data.markers || []).filter((m) => m.x != null && m.x >= x0 && m.x <= x1).map((m) => (
          <g key={m.label}>
            <line x1={X(m.x)} x2={X(m.x)} y1={pad.t} y2={H - pad.b} className="rv-marker" />
            <text x={X(m.x) + 4} y={pad.t + 12} className="rv-tick">{m.label}</text>
          </g>
        ))}
      </svg>
      <figcaption className="fine">{main.map((s) => s.name).join(' · ')} — x: {data.axes?.x}, y: {data.axes?.y}</figcaption>
    </figure>
  )
}

function Models({ models }) {
  const [id, setId] = useState(models[0]?.id)
  const [m, setM] = useState(null)
  const [params, setParams] = useState({})
  const [out, setOut] = useState(null)
  const [checks, setChecks] = useState(null)
  const timer = useRef(null)
  useEffect(() => {
    if (!id) return
    api(`${URL_}?view=model&id=${encodeURIComponent(id)}`).then(({ status, data }) => {
      if (status !== 200) return
      setM(data)
      setParams(data.model.defaults)
    })
  }, [id])
  useEffect(() => {
    if (!m) return undefined
    clearTimeout(timer.current)
    timer.current = setTimeout(() => api(URL_, { method: 'POST', body: { action: 'evaluate', model: id, params } }).then(({ status, data }) => status === 200 && setOut(data)), 150)
    return () => clearTimeout(timer.current)
  }, [params, m, id])
  const verify = async () => {
    const { status, data } = await api(URL_, { method: 'POST', body: { action: 'verify', model: id, params } })
    if (status === 200) setChecks(data)
  }
  const d = m?.model
  return (
    <section className="card" data-models>
      <label className="field">
        <span>Model</span>
        <select
          value={id}
          onChange={(e) => {
            setChecks(null)
            setId(e.target.value)
          }}
        >
          {models.map((x) => (
            <option key={x.id} value={x.id}>
              {x.id} · {x.title}
            </option>
          ))}
        </select>
      </label>
      {d && (
        <>
          <p className="tags">
            <Pill tone="warn">Empirical: {d.validation}</Pill> <Pill tone="neutral">Derivation: analytical</Pill> <Pill tone="neutral">Formal proof: not verified</Pill>
          </p>
          <p><strong>{d.question}</strong></p>
          <p className="rv-expr" data-expression>{d.expression}</p>
          <div className="rv-studio">
            <div className="rv-sliders">
              {d.params.map((p) => (
                <label key={p.key} className="field">
                  <span>{p.label}: <strong>{fmt(params[p.key])}</strong></span>
                  <input type="range" min={p.min} max={p.max} step={p.step} value={params[p.key] ?? p.min} onChange={(e) => setParams({ ...params, [p.key]: Number(e.target.value) })} aria-label={p.label} />
                </label>
              ))}
            </div>
            <div>
              <Chart data={out} />
              {out?.results && (
                <dl className="kv rv-results" data-results>
                  {Object.entries(out.results).filter(([, v]) => typeof v !== 'object' || Array.isArray(v)).map(([k, v]) => (
                    <div key={k}><dt>{k}</dt><dd>{fmt(v)}</dd></div>
                  ))}
                </dl>
              )}
              {out?.results?.stages && <p className="fine">Gain per +1 point: {out.results.stages.map((s) => `${s.stage} ${fmt(s.valuePerPoint)}`).join(' · ')}</p>}
            </div>
          </div>
          <details className="rv-section" open>
            <summary>Derivation</summary>
            <ol>{d.derivation.map((s) => <li key={s}>{s}</li>)}</ol>
          </details>
          <details className="rv-section">
            <summary>Variables, assumptions, limitations</summary>
            <ul>{d.variables.map((v) => <li key={v.name}><strong>{v.name}</strong>: {v.meaning} [{v.unit}]</li>)}</ul>
            <p className="fine">Domain: {d.domain}</p>
            <ul>{d.assumptions.map((a) => <li key={a}>{a}</li>)}</ul>
            <p className="fine">{d.limitations}</p>
            <p className="fine">References: {d.references.join(' · ')}</p>
          </details>
          <details className="rv-section">
            <summary>Challenge: where it fails</summary>
            <ul>{m.counterexamples.map((c) => <li key={c.case}><strong>{c.case}.</strong> {c.finding}</li>)}</ul>
          </details>
          <p>
            <button type="button" className="btn btn-sm" onClick={verify}>Run the checks at these values</button>
          </p>
          {checks && (
            <ul className="rv-checks" data-checks>
              {checks.checks.map((c) => <li key={c.check}><Pill tone={c.pass ? 'ok' : 'bad'}>{c.pass ? 'passes' : 'fails'}</Pill> {c.check} <span className="fine">({c.kind}; {fmt(c.value)})</span></li>)}
              <li className="fine">Formal: {checks.formal}. Numeric checks test the derivation at these values; they are not a proof.</li>
            </ul>
          )}
        </>
      )}
    </section>
  )
}

// ---------- records ----------
function Records({ only }) {
  const [kind, setKind] = useState(only || '')
  const [list, setList] = useState(null)
  const [kinds, setKinds] = useState(null)
  const [open, setOpen] = useState(null)
  const load = useCallback(() => api(`${URL_}?view=records${kind ? `&kind=${kind}` : ''}`).then(({ status, data }) => {
    if (status === 200) {
      setList(data.records)
      setKinds(data.kinds)
    }
  }), [kind])
  useEffect(() => {
    load()
  }, [load])
  if (!list) return <section className="card" aria-busy="true" />
  return (
    <>
      <section className="card" data-records>
        {!only && (
          <label className="field">
            <span>Kind</span>
            <select value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="">All</option>
              {Object.keys(kinds).map((k) => <option key={k} value={k}>{k}</option>)}
            </select>
          </label>
        )}
        {!list.length ? <p className="fine">No records yet.</p> : (
          <ul className="rows">
            {list.map((r) => (
              <li key={r.id} className="row">
                <button type="button" className="rv-row-btn" onClick={() => setOpen(r.id)}>
                  <span className="row-title">{r.title}</span>
                  <span className="row-sub">{r.kind} · {r.status}{r.program ? ` · ${r.program}` : ''}{r.confidence != null ? ` · confidence ${r.confidence}` : ''} · v{r.version}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
      {open && <RecordDetail id={open} kinds={kinds} reload={load} />}
      <NewRecord kinds={kinds} fixedKind={only} onSaved={load} />
    </>
  )
}

function NewRecord({ kinds, fixedKind, onSaved }) {
  const [kind, setKind] = useState(fixedKind || 'hypothesis')
  const [f, setF] = useState({})
  const [msg, setMsg] = useState('')
  const k = kinds[kind]
  const submit = async (e) => {
    e.preventDefault()
    const body = {}
    for (const t of k.text) if (f[t]) body[t] = f[t]
    for (const l of k.lists) if (f[l]) body[l] = f[l].split('\n').map((x) => x.trim()).filter(Boolean)
    for (const n of k.nums) if (f[n] !== undefined && f[n] !== '') body[n] = Number(f[n])
    const record = { title: f.title || '', status: f.status || k.statuses[0], program: f.program || undefined, confidence: f.confidence === undefined || f.confidence === '' ? undefined : Number(f.confidence), body }
    const { status, data } = await api(URL_, { method: 'POST', body: { action: 'create', kind, record } })
    setMsg(status === 200 ? 'Saved.' : errText(data))
    if (status === 200) {
      setF({})
      onSaved()
    }
  }
  const req = (x) => (k.required.includes(x) || k.needsList.includes(x) ? ' *' : '')
  return (
    <section className="card">
      <h2 className="card-title">New record</h2>
      <form className="form" onSubmit={submit} data-new-record>
        {!fixedKind && (
          <label className="field">
            <span>Kind</span>
            <select value={kind} onChange={(e) => setKind(e.target.value)}>
              {Object.keys(kinds).map((x) => <option key={x} value={x}>{x}</option>)}
            </select>
          </label>
        )}
        <label className="field"><span>Title *</span><input value={f.title || ''} onChange={(e) => setF({ ...f, title: e.target.value })} maxLength={160} /></label>
        <label className="field"><span>Program (e.g. GS-ECO-002)</span><input value={f.program || ''} onChange={(e) => setF({ ...f, program: e.target.value })} /></label>
        {k.text.map((t) => <label key={t} className="field"><span>{t}{req(t)}</span><textarea rows={2} value={f[t] || ''} onChange={(e) => setF({ ...f, [t]: e.target.value })} /></label>)}
        {k.lists.map((l) => <label key={l} className="field"><span>{l}{req(l)} (one per line)</span><textarea rows={2} value={f[l] || ''} onChange={(e) => setF({ ...f, [l]: e.target.value })} /></label>)}
        {k.nums.map((n) => <label key={n} className="field"><span>{n}</span><input inputMode="decimal" value={f[n] ?? ''} onChange={(e) => setF({ ...f, [n]: e.target.value })} /></label>)}
        <label className="field"><span>Confidence (0–1, optional)</span><input inputMode="decimal" value={f.confidence ?? ''} onChange={(e) => setF({ ...f, confidence: e.target.value })} /></label>
        <button className="btn btn-primary btn-sm" type="submit">Save</button>
        {msg && <p className="fine" role="status">{msg}</p>}
      </form>
    </section>
  )
}

function RecordDetail({ id, kinds, reload }) {
  const [r, setR] = useState(null)
  const [upd, setUpd] = useState({ reason: '', status: '', confidence: '' })
  const [lnk, setLnk] = useState({ to: '', relation: 'supports', note: '' })
  const [msg, setMsg] = useState('')
  const load = useCallback(() => api(`${URL_}?view=record&id=${encodeURIComponent(id)}`).then(({ status, data }) => status === 200 && setR(data.record)), [id])
  useEffect(() => {
    load()
  }, [load])
  if (!r) return <section className="card" aria-busy="true" />
  const save = async (e) => {
    e.preventDefault()
    const record = {}
    if (upd.status) record.status = upd.status
    if (upd.confidence !== '') record.confidence = Number(upd.confidence)
    const { status, data } = await api(URL_, { method: 'POST', body: { action: 'update', id, version: r.version, reason: upd.reason, record } })
    setMsg(status === 200 ? `Saved as version ${data.version}.` : errText(data))
    if (status === 200) {
      setUpd({ reason: '', status: '', confidence: '' })
      load()
      reload()
    }
  }
  const addLink = async (e) => {
    e.preventDefault()
    const { status, data } = await api(URL_, { method: 'POST', body: { action: 'link', from: id, to: lnk.to.trim(), relation: lnk.relation, note: lnk.note } })
    setMsg(status === 200 ? 'Linked.' : errText(data))
    if (status === 200) load()
  }
  return (
    <section className="card" data-record={r.id}>
      <h2 className="card-title">{r.title}</h2>
      <p className="fine">{r.kind} · {r.status} · v{r.version} · id {r.id}</p>
      <dl className="kv">{Object.entries(r.body).map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{fmt(v)}</dd></div>)}</dl>
      <h3 className="rv-sub">Links</h3>
      {!r.links.length ? <p className="fine">None.</p> : <ul>{r.links.map((l) => <li key={l.id}>{l.from.title} <strong>{l.relation}</strong> {l.to.title}{l.note ? ` (${l.note})` : ''}</li>)}</ul>}
      <form className="form" onSubmit={addLink}>
        <label className="field"><span>This record … another (paste its id)</span><input value={lnk.to} onChange={(e) => setLnk({ ...lnk, to: e.target.value })} /></label>
        <label className="field"><span>Relation</span><select value={lnk.relation} onChange={(e) => setLnk({ ...lnk, relation: e.target.value })}>{['supports', 'contradicts', 'assumes', 'tests', 'derives', 'informs', 'answers', 'supersedes', 'measures'].map((x) => <option key={x}>{x}</option>)}</select></label>
        <button className="btn btn-sm" type="submit">Link</button>
      </form>
      <h3 className="rv-sub">New version</h3>
      <form className="form" onSubmit={save}>
        <label className="field"><span>Status</span><select value={upd.status} onChange={(e) => setUpd({ ...upd, status: e.target.value })}><option value="">(unchanged)</option>{kinds[r.kind].statuses.map((x) => <option key={x}>{x}</option>)}</select></label>
        <label className="field"><span>Confidence (0–1)</span><input inputMode="decimal" value={upd.confidence} onChange={(e) => setUpd({ ...upd, confidence: e.target.value })} /></label>
        <label className="field"><span>Reason (kept in the history) *</span><input value={upd.reason} onChange={(e) => setUpd({ ...upd, reason: e.target.value })} /></label>
        <button className="btn btn-sm" type="submit">Save new version</button>
      </form>
      {msg && <p className="fine" role="status">{msg}</p>}
      <h3 className="rv-sub">History</h3>
      <ul>{r.versions.map((v) => <li key={v.version} className="fine">v{v.version} · {v.status}{v.confidence != null ? ` · ${v.confidence}` : ''} · {v.reason} · {new Date(v.at).toLocaleString()}</li>)}</ul>
    </section>
  )
}

// ---------- experiments ----------
function Experiments() {
  const [ss, setSs] = useState({ baseline: '0.3', effect: '0.1' })
  const [n, setN] = useState(null)
  const [list, setList] = useState([])
  const [res, setRes] = useState({})
  useEffect(() => {
    api(`${URL_}?view=records&kind=experiment`).then(({ status, data }) => status === 200 && setList(data.records))
  }, [])
  const size = async (e) => {
    e.preventDefault()
    const { data } = await api(URL_, { method: 'POST', body: { action: 'sample_size', baseline: Number(ss.baseline), effect: Number(ss.effect) } })
    setN(data)
  }
  const analyze = async (id) => {
    const { status, data } = await api(URL_, { method: 'POST', body: { action: 'analyze', id } })
    if (status === 200) setRes({ ...res, [id]: data.analysis })
  }
  return (
    <>
      <section className="card">
        <h2 className="card-title">How many cases an experiment needs</h2>
        <form className="form" onSubmit={size} data-sample-size>
          <label className="field"><span>Current rate (e.g. 0.3)</span><input inputMode="decimal" value={ss.baseline} onChange={(e) => setSs({ ...ss, baseline: e.target.value })} /></label>
          <label className="field"><span>Smallest change worth detecting (e.g. 0.1)</span><input inputMode="decimal" value={ss.effect} onChange={(e) => setSs({ ...ss, effect: e.target.value })} /></label>
          <button className="btn btn-sm" type="submit">Calculate</button>
        </form>
        {n && <p className="fine" role="status">{n.ok ? `${n.perArm} per group (${n.total} in total) for 5% false-positive risk and 80% power.` : 'Rates must be between 0 and 1.'}</p>}
      </section>
      <section className="card">
        <h2 className="card-title">Experiments</h2>
        {!list.length ? <p className="fine">None recorded. Create one under Records (kind: experiment); its success criteria and stopping rule are required before it starts.</p> : (
          <ul className="rows">
            {list.map((x) => (
              <li key={x.id} className="row">
                <div className="row-main">
                  <p className="row-title">{x.title} <Pill tone="neutral">{x.status}</Pill></p>
                  <p className="row-sub">Primary outcome: {x.body.primaryOutcome} · planned per group: {fmt(x.body.plannedSample)}</p>
                  <button type="button" className="btn btn-sm btn-quiet" onClick={() => analyze(x.id)}>Analyze recorded counts</button>
                  {res[x.id] && <p className="fine" role="status">{res[x.id].verdict}{res[x.id].pValue != null ? ` · p = ${res[x.id].pValue} · P(treatment better) = ${res[x.id].probTreatmentBetter}` : ''}{res[x.id].note ? ` · ${res[x.id].note}` : ''}{res[x.id].reason ? ` · ${res[x.id].reason}` : ''}</p>}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  )
}

// ---------- decisions ----------
function DecisionList({ list }) {
  return (
    <ul className="rows" data-decisions>
      {list.map((d) => (
        <li key={d.id} className="row">
          <div className="row-main">
            <p className="row-title">{d.title} <Pill tone="neutral">{d.status}</Pill></p>
            <p className="row-sub">{d.body.kpi} · {d.body.action}</p>
            <p className="fine">{d.value ? `Expected net value ${fmt(d.value.low)} to ${fmt(d.value.high)} (mid ${fmt(d.value.mid)})` : 'Not quantified: benefit range, probability and cost are missing'} · evidence: {d.body.validationStatus} · invalidated by: {d.body.invalidatedBy}</p>
          </div>
        </li>
      ))}
    </ul>
  )
}
function Decisions() {
  const [list, setList] = useState(null)
  useEffect(() => {
    api(`${URL_}?view=decisions`).then(({ status, data }) => status === 200 && setList(data.decisions))
  }, [])
  return (
    <section className="card">
      <h2 className="card-title">Decision queue</h2>
      <p className="fine">Ranked by expected net value = probability × benefit − cost, from the numbers recorded on each recommendation. A prediction, never a guaranteed outcome. Add recommendations under Records.</p>
      {!list ? <div aria-busy="true" /> : !list.length ? <p className="fine">No recommendations yet.</p> : <DecisionList list={list} />}
    </section>
  )
}

// ---------- data ----------
function Data() {
  const [o, setO] = useState(null)
  useEffect(() => {
    api(`${URL_}?view=observatory`).then(({ status, data }) => status === 200 && setO(data))
  }, [])
  if (!o) return <section className="card" aria-busy="true" />
  return (
    <>
      <section className="card" data-observatory>
        <h2 className="card-title">GetShowUps itself (the same figures as Admin → Growth)</h2>
        {!o.corporate ? <p className="fine">Unavailable right now.</p> : (
          <ul className="rows">
            {o.corporate.map((i) => (
              <li key={i.key} className="row"><div className="row-main"><p className="row-title">{i.label}: {i.unit === 'cents' ? usd(i.value) : i.unit === 'percent' && i.value != null ? `${Math.round(i.value * 100)}%` : fmt(i.value)} <Pill tone={KIND_TONE[i.dataKind]}>{i.dataKind}</Pill></p>{i.note && <p className="row-sub">{i.note}</p>}</div></li>
            ))}
          </ul>
        )}
        <p className="fine">AI today: {o.aiToday ? `${usd(o.aiToday.platformMicros / 1e4)} of ${usd(o.aiToday.ceilings.platform / 1e4)} (measured)` : 'unavailable'}. Infrastructure: {o.infrastructure.note}</p>
        <p className="fine">Not measured yet: {o.notMeasured.join(' · ')}.</p>
      </section>
      {o.businesses.map((b) => (
        <section key={b.business} className="card" data-business={b.business}>
          <h2 className="card-title">{b.business} (GetShowUps-owned), last {b.days} days</h2>
          {b.error ? <p className="fine">Unreadable.</p> : (
            <>
              <ul>{b.stages.map((s) => <li key={s.name}>{s.name}: {s.x}/{s.n} {s.rate ? `= ${Math.round(s.rate.p * 100)}% (95% range ${Math.round(s.rate.low * 100)}–${Math.round(s.rate.high * 100)}%)` : <Pill tone="neutral">too few cases</Pill>}</li>)}</ul>
              <p className="fine">Provider attendance: <Pill tone="bad">missing</Pill> {b.providerAttendance.note}</p>
              <p className="fine">Spend {usd(b.money.spendCents)} ({b.money.spendKind}) · paid {usd(b.money.paidCents)} ({b.money.paidKind}) · estimated {usd(b.money.estimatedCents)} ({b.money.estimatedKind})</p>
              <h3 className="rv-sub">Where value is lost</h3>
              {!b.accountability.losses.length ? <p className="fine">{b.accountability.recommendation}</p> : <ul>{b.accountability.losses.map((l) => <li key={l.stage}>{l.stage}: {l.count} · possible causes: {l.possibleCauses.join(', ')} · cause: {l.attribution}</li>)}</ul>}
              {b.accountability.warnings.map((w) => <p key={w} className="fine"><strong>{w}</strong></p>)}
            </>
          )}
        </section>
      ))}
      <section className="card"><p className="fine">Customer businesses are not read. {o.crossAccount.reason}</p></section>
    </>
  )
}
