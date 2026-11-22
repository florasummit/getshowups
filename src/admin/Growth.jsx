// Admin → Growth: Measure | Simulate | Decide. Measure shows what the records say, each figure labelled live / test /
// estimated / unavailable with its sample and date range (GET /api/platform/growth, the same queries as the admin
// overview). Simulate is a scenario model over editable assumptions (prefilled from measured data when the sample is
// big enough, otherwise labelled assumptions); its price field is for modeling only and never touches Stripe. Decide
// is the server's deterministic recommendation with its sample and evidence strength. Nothing here spends or changes
// anything; nothing here is a forecast.
import { useEffect, useMemo, useState } from 'react'
import { api } from '../lib/api.js'
import { FIELDS, DEFAULTS, normalizeAssumptions, compare, sensitivity } from '../../server/growth-model.js'

const MODES = [
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
  useEffect(() => {
    document.title = 'Growth · GetShowUps'
    api('/api/platform/growth').then(({ status, data }) => setR(status === 200 ? data : { error: true }))
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
      {mode === 'measure' ? <Measure m={r.measure} /> : mode === 'simulate' ? <Simulate baseline={r.baseline} /> : <Decide d={r.decide} />}
    </div>
  )
}
