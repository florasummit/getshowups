// Admin → Growth: Measure | Simulate | Decide. Measure shows what the records say, each figure labelled live / test /
// estimated / unavailable with its sample and date range (GET /api/platform/growth, the same queries as the admin
// overview). Simulate is a scenario model over editable assumptions (prefilled from measured data when the sample is
// big enough, otherwise labelled assumptions); its price field is for modeling only and never touches Stripe. Decide
// is the server's deterministic recommendation with its sample and evidence strength. Nothing here spends or changes
// anything; nothing here is a forecast. Activities is the prepared acquisition plan by tracking code: results are
// measured from the link's code, status and cost are what the founder records after acting (POST
// /api/platform/acquisition, audited). Recording never sends, publishes or spends anything.
import { useEffect, useMemo, useState } from 'react'
import { api } from '../lib/api.js'
import { FIELDS, DEFAULTS, normalizeAssumptions, compare, sensitivity } from '../../server/growth-model.js'

const MODES = [
  ['activities', 'Activities'],
  ['measure', 'Measure'],
  ['simulate', 'Simulate'],
  ['decide', 'Decide'],
]
const KIND = { live: ['Live', 'ok'], test: ['Test mode', 'neutral'], estimated: ['Estimate', 'info'], unavailable: ['Unavailable', 'neutral'] }
const money = (c) => (c == null || !Number.isFinite(c) ? '—' : `$${(Math.round(c) / 100).toLocaleString('en-US', { maximumFractionDigits: 0 })}`)
const n1 = (v) => (v == null || !Number.isFinite(v) ? '—' : v.toLocaleString('en-US', { maximumFractionDigits: 1 }))
const pctOf = (v) => (v == null ? '—' : `${Math.round(v * 100)}%`)
const value = (it) => (it.value == null ? '—' : it.unit === 'cents' ? money(it.value) : it.unit === 'percent' ? `${Math.round(it.value)}%` : String(it.value))
const day = (iso) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })

function Measure({ m }) {
  return (
    <section className="card" aria-label="Measured" data-growth-measure>
      <p className="fine">
        {day(m.range.from)} – {day(m.range.to)} ({m.range.days} days) · billing {m.billingMode === 'live' ? 'live' : 'in Stripe test mode (nothing is revenue)'} · {m.customers.total} customer{m.customers.total === 1 ? '' : 's'} · test businesses and test leads excluded.
      </p>
      <ul className="rows">
        {m.items.map((it) => (
          <li key={it.key} className="row" data-measure={it.key} data-kind={it.kind}>
            <div className="row-main">
              <p className="row-title">
                {it.label} <span className={`tag tag--${KIND[it.kind][1]}`}>{KIND[it.kind][0]}</span>
              </p>
              <p className="row-sub">
                {it.n != null ? `Sample ${it.n}. ` : ''}
                {it.note || ''}
              </p>
            </div>
            <strong className="growth-value">{value(it)}</strong>
          </li>
        ))}
      </ul>
    </section>
  )
}

function Field({ k, v, source, onChange }) {
  const f = FIELDS[k]
  const display = f.kind === 'rate' ? Math.round(v * 100) : f.kind === 'money' ? v / 100 : v
  const parse = (x) => (f.kind === 'rate' ? Number(x) / 100 : f.kind === 'money' ? Number(x) * 100 : Number(x))
  return (
    <label className="field" data-sim-field={k}>
      <span>
        {f.label} <em>({f.kind === 'rate' ? '%' : f.kind === 'money' ? '$' : 'number'})</em> <span className={`tag ${source === 'assumption' ? '' : 'tag--ok'}`}>{source === 'assumption' ? 'assumption' : source}</span>
      </span>
      <input type="number" inputMode="decimal" min={f.kind === 'rate' ? 0 : f.min / (f.kind === 'money' ? 100 : 1)} max={f.kind === 'rate' ? 100 : f.max / (f.kind === 'money' ? 100 : 1)} step={f.kind === 'rate' ? 1 : f.kind === 'money' ? 1 : f.step} value={Number.isFinite(display) ? Math.round(display * 100) / 100 : ''} onChange={(e) => onChange(parse(e.target.value))} />
    </label>
  )
}

function Simulate({ baseline }) {
  const base = useMemo(() => normalizeAssumptions(baseline?.assumptions || DEFAULTS), [baseline])
  const sources = baseline?.sources || {}
  const [scenario, setScenario] = useState(base) // Simulate mounts after the baseline has loaded; Reset returns to it
  const r = useMemo(() => compare(base, normalizeAssumptions(scenario)), [base, scenario])
  const sens = useMemo(() => sensitivity(normalizeAssumptions(scenario)), [scenario])
  const set = (k, v) => setScenario((s) => ({ ...s, [k]: v }))
  const measuredCount = Object.values(sources).filter((s) => s === 'measured').length
  return (
    <div className="stack-lg" data-growth-simulate>
      <section className="card">
        <h2 className="card-title">Assumptions</h2>
        <p className="fine">
          {measuredCount ? `${measuredCount} prefilled from measured data (30 days, when the sample is big enough); the rest are editable assumptions.` : 'No measured rate has a big enough sample yet: every field is an editable assumption.'} The price is for modeling only and never changes Stripe or what customers pay.
        </p>
        <div className="sim-grid">
          {Object.keys(FIELDS).map((k) => (
            <Field key={k} k={k} v={scenario[k]} source={sources[k] || 'assumption'} onChange={(v) => set(k, v)} />
          ))}
        </div>
        <button type="button" className="link-btn" onClick={() => setScenario(base)} data-sim-reset>
          Reset to baseline
        </button>
      </section>
      <section className="card" aria-label="Scenario results">
        <h2 className="card-title">Baseline vs scenario</h2>
        <table className="sim-table" data-sim-results>
          <thead>
            <tr>
              <th>Per month</th>
              <th>Baseline</th>
              <th>Scenario</th>
            </tr>
          </thead>
          <tbody>
            {[
              ['Qualified leads', n1(r.baseline.monthly.qualified), n1(r.scenario.monthly.qualified)],
              ['Consultations booked', n1(r.baseline.monthly.booked), n1(r.scenario.monthly.booked)],
              ['Consultations attended', n1(r.baseline.monthly.attended), n1(r.scenario.monthly.attended)],
              ['New customers', n1(r.baseline.monthly.newCustomers), n1(r.scenario.monthly.newCustomers)],
              ['New MRR', money(r.baseline.monthly.newMrrCents), money(r.scenario.monthly.newMrrCents)],
              ['Acquisition spend', money(r.baseline.monthly.spendCents ?? base.spendPerMonthCents), money(normalizeAssumptions(scenario).spendPerMonthCents)],
              ['Cost per new customer', money(r.baseline.monthly.cacCents), money(r.scenario.monthly.cacCents)],
              ['Payback (months)', n1(r.baseline.monthly.paybackMonths), n1(r.scenario.monthly.paybackMonths)],
              [`MRR after ${normalizeAssumptions(scenario).months} months (existing ${money(base.existingMrrCents)})`, money(r.baseline.endMrrCents), money(r.scenario.endMrrCents)],
            ].map(([k, a, b]) => (
              <tr key={k}>
                <th scope="row">{k}</th>
                <td>{a}</td>
                <td data-sim-scenario={k}>{b}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="fine">
          Scenario minus baseline: {n1(r.delta.newCustomersPerMonth)} new customers per month, {money(r.delta.endMrrCents)} MRR at the end, {money(r.delta.totalSpendCents)} total spend. Changed: {r.changed.length ? r.changed.map((k) => FIELDS[k].label).join(', ') : 'nothing'}.
        </p>
      </section>
      <section className="card" aria-label="Sensitivity">
        <h2 className="card-title">Which rate matters most</h2>
        <ul className="rows">
          {sens.map((s) => (
            <li key={s.key} className="row">
              <div className="row-main">
                <p className="row-title">{s.label}</p>
                <p className="row-sub">
                  +10 points → {n1(s.up)} new customers per month ({s.upDelta >= 0 ? '+' : ''}
                  {n1(s.upDelta)}); −10 points → {n1(s.down)} ({n1(s.downDelta)}).
                </p>
              </div>
            </li>
          ))}
        </ul>
        <p className="fine" data-sim-limits>
          Limitations: a straight-line funnel with constant rates and churn; no seasonality, no lead quality by channel, no ramp-up; spend buys nothing by itself (lead volume is an input). Not a forecast and not advice: arithmetic over the assumptions above.
        </p>
      </section>
    </div>
  )
}

const STATUS = { prepared: ['Prepared', ''], approved: ['Approved', 'info'], sent: ['Sent', 'ok'], followed_up: ['Followed up', 'ok'], replied: ['Replied', 'ok'], declined: ['Said no', 'neutral'] }
const ACQ_ERR = { not_ready: 'Status tracking isn’t set up yet (database update 0044).', invalid_label: 'Use a company or place name, without an email address or phone number.', invalid_cost: 'Enter a cost between $0 and $100,000.', invalid_code: 'Use lowercase letters, numbers and dashes (2–32 characters).' }
const cell = (r, k) => (r == null || r[k] == null ? '—' : k === 'revenueCents' ? money(r[k]) : String(r[k]))
const RESULT_COLS = [
  ['prospects', 'Prospects'],
  ['qualified', 'Qualified'],
  ['consultationsBooked', 'Demos booked'],
  ['consultationsAttended', 'Attended'],
  ['businessesCreated', 'Signed up'],
  ['paying', 'Paying'],
  ['revenueCents', 'Paid revenue'],
]

function Copy({ text, label }) {
  const [done, setDone] = useState(false)
  return (
    <button
      type="button"
      className="link-btn"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text)
          setDone(true)
          setTimeout(() => setDone(false), 1500)
        } catch {
          window.prompt('Copy this link', text)
        }
      }}
    >
      {done ? 'Copied' : label}
    </button>
  )
}

function CodeRow({ c, canSave, save }) {
  const [label, setLabel] = useState(c.label)
  const [cost, setCost] = useState(c.costCents ? String(c.costCents / 100) : '')
  return (
    <li className="row acq-code" data-acq-code={c.code} data-status={c.status}>
      <div className="row-main">
        <p className="row-title">
          <code>{c.code}</code> {c.label ? `· ${c.label} ` : ''}
          <span className={`tag tag--${STATUS[c.status][1]}`}>{STATUS[c.status][0]}</span> {c.followUpDue ? <span className="tag tag--bad">Follow-up due</span> : null}
        </p>
        <p className="row-sub">
          {c.sentAt ? `Sent ${day(c.sentAt)}. ` : ''}
          {c.followedUpAt ? `Followed up ${day(c.followedUpAt)}. ` : ''}
          {c.repliedAt ? `${c.status === 'declined' ? 'Said no' : 'Replied'} ${day(c.repliedAt)}. ` : ''}
          {c.results ? RESULT_COLS.map(([k, l]) => `${l} ${cell(c.results, k)}`).join(' · ') : 'Results unavailable.'}
        </p>
        <p className="row-sub acq-tools">
          <Copy text={c.links.book} label="Copy booking link" /> <Copy text={c.links.chat} label="Copy chat link" />
        </p>
        {canSave ? (
          <div className="acq-edit">
            <label>
              <span>Status</span>
              <select value={c.status} onChange={(e) => save(c.code, { status: e.target.value })} aria-label={`Status of ${c.code}`}>
                {Object.entries(STATUS).map(([v, [l]]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
            </label>
            <details className="acq-more">
              <summary>Name and cost</summary>
              <div className="acq-edit">
                <label>
                  <span>Who or where (optional)</span>
                  <input value={label} maxLength={60} onChange={(e) => setLabel(e.target.value)} onBlur={() => label.trim() !== c.label && save(c.code, { label })} aria-label={`Label of ${c.code}`} />
                </label>
                <label>
                  <span>What it cost you ($)</span>
                  <input type="number" inputMode="decimal" min="0" step="1" value={cost} onChange={(e) => setCost(e.target.value)} onBlur={() => Math.round(Number(cost || 0) * 100) !== c.costCents && save(c.code, { costCents: Math.round(Number(cost || 0) * 100) })} aria-label={`Cost of ${c.code}`} />
                </label>
              </div>
            </details>
          </div>
        ) : null}
      </div>
    </li>
  )
}

function Activities({ a, reload }) {
  const [msg, setMsg] = useState(null)
  const [adding, setAdding] = useState({})
  if (!a) return <p className="form-error">Activities are unavailable.</p>
  const save = async (code, change, activity) => {
    setMsg(null)
    const { status, data } = await api('/api/platform/acquisition', { method: 'POST', body: { code, ...change, ...(activity ? { activity } : {}) } })
    if (status !== 200) return setMsg(ACQ_ERR[data?.error] || 'Couldn’t save that. Try again.')
    await reload()
  }
  const t = a.totals
  return (
    <div className="stack-lg" data-growth-activities>
      <section className="card" aria-label="Acquisition summary">
        <p className="fine">
          Results are measured from each link’s tracking code{a.days ? ` (last ${a.days} days)` : ''}; test leads are left out. Status and cost are what you record after you act. Recording here never sends a message, publishes anything or spends money.
          {a.live === false ? ' Billing is in Stripe test mode, so nobody counts as paying and no revenue is shown.' : ''}
        </p>
        <ul className="rows">
          <li className="row" data-acq-total="outreach">
            <div className="row-main">
              <p className="row-title">Outreach</p>
              <p className="row-sub">
                {t.codes} tracking codes · {t.approved} approved, not sent · {t.sent} sent · {t.replied} replied · {t.declined} said no{t.followUpsDue ? ` · ${t.followUpsDue} follow-up${t.followUpsDue === 1 ? '' : 's'} due` : ''}
              </p>
            </div>
          </li>
          <li className="row" data-acq-total="results">
            <div className="row-main">
              <p className="row-title">
                From these activities <span className={`tag tag--${t.results ? 'ok' : 'neutral'}`}>{t.results ? 'Measured' : 'Unavailable'}</span>
              </p>
              <p className="row-sub">{t.results ? RESULT_COLS.map(([k, l]) => `${l} ${cell(t.results, k)}`).join(' · ') : 'The GetShowUps sales business is not set up, so prospects can’t be counted.'}</p>
            </div>
          </li>
          <li className="row" data-acq-total="cost">
            <div className="row-main">
              <p className="row-title">Cost</p>
              <p className="row-sub">
                Recorded by you: {money(t.recordedCostCents)} (your own entries) · Ad spend measured by the platforms: {t.adSpendCents == null ? 'none synced' : money(t.adSpendCents)} · Cost per paying customer: {t.costPerPayingCents == null ? 'unavailable until a prospect pays in live billing' : money(t.costPerPayingCents)}
              </p>
            </div>
          </li>
        </ul>
        {!a.available ? <p className="fine" data-acq-notready>Status and cost can’t be saved until database update 0044 is applied. Links and results already work.</p> : null}
        {msg ? <p className="form-error" role="alert">{msg}</p> : null}
      </section>
      {a.activities.map((act) => (
        <section key={act.key} className="card" data-acq-activity={act.key}>
          <h2 className="card-title">
            {act.n}. {act.title}
          </h2>
          <p className="fine">
            {act.channel}
            {act.paid ? ' · needs your budget approval; nothing is spent from here' : ''}
            {act.derived === 'followUp' ? ` · ${t.followUpsDue ? `${t.followUpsDue} due now (marked below)` : 'none due'}: a sent code with no reply after 4 days is marked “Follow-up due”.` : ''}
            {act.derived === 'destination' ? ' · results are counted on the activity whose link brought the visitor.' : ''}
          </p>
          {act.codes.length ? (
            <ul className="rows">
              {act.codes.map((c) => (
                <CodeRow key={`${c.code}:${c.status}:${c.label}:${c.costCents}`} c={c} canSave={a.available} save={save} />
              ))}
            </ul>
          ) : null}
          {a.available && !act.derived ? (
            <form
              className="acq-add"
              onSubmit={(e) => {
                e.preventDefault()
                const code = (adding[act.key] || '').trim().toLowerCase()
                if (code) save(code, { status: 'prepared' }, act.key).then(() => setAdding((x) => ({ ...x, [act.key]: '' })))
              }}
            >
              <input value={adding[act.key] || ''} onChange={(e) => setAdding((x) => ({ ...x, [act.key]: e.target.value }))} placeholder="new code, e.g. out-06" maxLength={32} aria-label={`New tracking code for ${act.title}`} />
              <button type="submit" className="link-btn">
                Add a tracking code
              </button>
            </form>
          ) : null}
        </section>
      ))}
      {a.other?.length ? (
        <section className="card" data-acq-other>
          <h2 className="card-title">Other sources</h2>
          <p className="fine">Prospects who did not arrive through a tracking code above (homepage buttons, a typed address, an ad campaign).</p>
          <ul className="rows">
            {a.other.map((o) => (
              <li key={`${o.source}|${o.campaign}`} className="row">
                <div className="row-main">
                  <p className="row-title">
                    {o.source}
                    {o.campaign ? ` (${o.campaign})` : ''}
                  </p>
                  <p className="row-sub">{RESULT_COLS.map(([k, l]) => `${l} ${cell(o, k)}`).join(' · ')}</p>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  )
}

function Decide({ d }) {
  const sample = d.sample ? Object.entries(d.sample).map(([k, v]) => (typeof v === 'object' ? `${FIELDS[k]?.label || k}: ${v.num} of ${v.den}${v.rate != null ? ` (${pctOf(v.rate)}, threshold ${pctOf(v.threshold)})` : ''}` : `${k}: ${v}`)).join(' · ') : ''
  return (
    <section className="card" data-growth-decide data-bottleneck={d.bottleneck || 'none'}>
      <h2 className="card-title">{d.title}</h2>
      <p>{d.why}</p>
      <dl className="kv">
        <div>
          <dt>Experiment</dt>
          <dd>{d.experiment}</dd>
        </div>
        <div>
          <dt>Estimated upside</dt>
          <dd>{d.upside ? `+${n1(d.upside.newCustomersPerMonth)} new customers and ${money(d.upside.newMrrCentsPerMonth)} new MRR per month if this rate improves by ${d.upside.ratePoints} points (${d.upside.note})` : 'Not estimated: there is no reliable rate to move yet.'}</dd>
        </div>
        <div>
          <dt>Cost</dt>
          <dd>{d.cost}</dd>
        </div>
        <div>
          <dt>Effort</dt>
          <dd>{d.effort}</dd>
        </div>
        <div>
          <dt>Evidence</dt>
          <dd>
            <span className={`tag ${d.evidence === 'strong' ? 'tag--ok' : d.evidence === 'insufficient' ? 'tag--bad' : ''}`}>{d.evidence}</span> {sample}
          </dd>
        </div>
      </dl>
      <p className="fine">Nothing runs by itself: no spend, no campaign change, no message is sent from here.</p>
    </section>
  )
}

export default function Growth() {
  const [mode, setMode] = useState('measure')
  const [r, setR] = useState(null)
  const load = () => api('/api/platform/growth').then(({ status, data }) => setR(status === 200 ? data : { error: true }))
  useEffect(() => {
    load()
  }, [])
  if (!r) return <p className="fine">Loading…</p>
  if (r.error) return <p className="form-error">Couldn’t load Growth.</p>
  return (
    <div className="enter growth">
      <div className="page-head">
        <h1 className="title title--page">Growth</h1>
      </div>
      <div className="seg" role="tablist" aria-label="Growth modes">
        {MODES.map(([v, label]) => (
          <button key={v} type="button" role="tab" aria-selected={mode === v} className={mode === v ? 'seg-on' : ''} onClick={() => setMode(v)} data-growth-mode={v}>
            {label}
          </button>
        ))}
      </div>
      {mode === 'activities' ? <Activities a={r.acquisition} reload={load} /> : mode === 'measure' ? <Measure m={r.measure} /> : mode === 'simulate' ? <Simulate baseline={r.baseline} /> : <Decide d={r.decide} />}
    </div>
  )
}
