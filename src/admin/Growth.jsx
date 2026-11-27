// Admin → Growth: Activities | Measure | Simulate | Decide. The tab is part of the address (/admin/growth#measure), so
// reload and Back keep it; what was typed in Simulate and the Activities filter survive a tab switch within the visit.
// Activities is the prepared acquisition plan by tracking code: results are measured from the link's code, status and
// cost are what the founder records after acting (POST /api/platform/acquisition, audited). Recording never sends,
// publishes or spends anything. Measure shows what the records say, each figure labelled measured / test mode /
// unavailable (GET /api/platform/growth, the same queries as the admin overview), grouped by whose numbers they are.
// Simulate is a scenario model over editable assumptions (prefilled from measured data when the sample is big enough,
// otherwise labelled assumptions; "Acquisition spend" only ever from GetShowUps' own ad spend); its price field is for
// modeling only and never touches billing. Decide is the server's deterministic recommendation. Nothing here spends or
// changes anything; nothing here is a forecast. Pipeline and Partners (src/admin/Commercial.jsx): the commercial pipeline
// by channel/rep/business and the referral partners with their commission ledger (records only; nothing is paid out).
import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../lib/api.js'
import { LoadError, Loading, Pill, SaveStatus } from '../dashboard/ui.jsx'
import { useSaveState } from '../dashboard/ui-hooks.js'
import { humanDate, money, plural } from '../lib/format.js'
import { sharedFigures } from './figures.js'
import { Partners, Pipeline } from './Commercial.jsx'
import { FIELDS, DEFAULTS, normalizeAssumptions, compare, sensitivity } from '../../server/growth-model.js'

const MODES = [
  ['activities', 'Activities'],
  ['measure', 'Measure'],
  ['simulate', 'Simulate'],
  ['decide', 'Decide'],
  ['pipeline', 'Pipeline'],
  ['partners', 'Partners'],
]
const modeOf = () => (MODES.some(([v]) => v === window.location.hash.slice(1)) ? window.location.hash.slice(1) : 'activities')
const KIND = { live: ['Measured', 'ok'], test: ['Test mode', 'warn'], estimated: ['Estimate', 'info'], unavailable: ['Unavailable', 'neutral'] }
// Whole dollars for modeled and measured amounts ("−$10,266": the minus sign before the dollar sign).
const usd = (c) => (c == null || !Number.isFinite(c) ? '—' : money(Math.round(c / 100) * 100))
const n1 = (v) => (v == null || !Number.isFinite(v) ? '—' : v.toLocaleString('en-US', { maximumFractionDigits: 1 }))
const pctOf = (v) => (v == null ? '—' : `${Math.round(v * 100)}%`)
const value = (it) => (it.value == null ? '—' : it.unit === 'cents' ? usd(it.value) : it.unit === 'percent' ? `${Math.round(it.value)}%` : String(it.value))
const day = (t) => humanDate(t, { weekday: false })

// ---------- Measure ----------
const GROUPS = [
  ['customers', 'Your customers’ results', 'What the businesses on GetShowUps got in the period. Their leads and their ad money, not yours.'],
  ['sales', 'GetShowUps’ own sales funnel', 'GetShowUps selling itself: prospects, consultations, the businesses they became, and what GetShowUps earns.'],
]
function Measure({ m }) {
  // MRR, Paying customers and Retention read exactly as on the Overview (one formatter over the same facts).
  const shared = sharedFigures(m.billing, m.retention30)
  return (
    <section className="card" aria-label="Measured" data-growth-measure>
      <p className="fine">
        {day(m.range.from)} – {day(m.range.to)} ({m.range.days} days) · billing is {m.billingMode === 'live' ? 'live' : 'in test mode (nothing is revenue)'} · {plural(m.customers.total, 'customer')} · test businesses and test leads excluded.
      </p>
      {GROUPS.map(([group, title, sub]) => (
        <div key={group} className="growth-group" data-measure-group={group}>
          <h2 className="card-title">{title}</h2>
          <p className="fine">{sub}</p>
          <ul className="rows">
            {m.items
              .filter((it) => (it.group || 'sales') === group)
              .map((it) => {
                const f = shared[it.key]
                const [label, tone] = f ? [f.status, f.tone] : KIND[it.kind]
                return (
                  <li key={it.key} className="row" data-measure={it.key} data-kind={it.kind} data-figure={f ? it.key : undefined} data-figure-value={f?.value} data-figure-status={f?.status}>
                    <div className="row-main">
                      <p className="row-title">
                        {it.label} <Pill tone={tone}>{label}</Pill>
                      </p>
                      {(f ? f.note || it.note : it.note) ? <p className="row-sub">{f ? f.note || it.note : it.note}</p> : null}
                    </div>
                    <strong className="growth-value">{f ? f.value : value(it)}</strong>
                  </li>
                )
              })}
          </ul>
        </div>
      ))}
    </section>
  )
}

// ---------- Simulate ----------
// What is typed is kept as text (so "150" or an empty field is shown back with its error, never silently replaced);
// a field outside its range is NOT used: the baseline value stands in until it is corrected.
const shown = (k, v) => {
  const f = FIELDS[k]
  const d = f.kind === 'rate' ? v * 100 : f.kind === 'money' ? v / 100 : v
  return String(Math.round(d * 100) / 100)
}
const limits = (k) => {
  const f = FIELDS[k]
  return f.kind === 'rate' ? [0, 100] : f.kind === 'money' ? [f.min / 100, f.max / 100] : [f.min, f.max]
}
const fieldError = (k, text) => {
  const [min, max] = limits(k)
  const v = Number(text)
  if (String(text).trim() === '' || !Number.isFinite(v) || v < min || v > max) return FIELDS[k].kind === 'rate' ? 'Enter a percentage from 0 to 100.' : `Enter a number from ${min.toLocaleString('en-US')} to ${max.toLocaleString('en-US')}.`
  return ''
}
const parsed = (k, text) => (FIELDS[k].kind === 'rate' ? Number(text) / 100 : FIELDS[k].kind === 'money' ? Number(text) * 100 : Number(text))
const SOURCE_HINT = { spendPerMonthCents: 'GetShowUps’ own ad spend, last 30 days' }

function Field({ k, text, source, baseline, onChange }) {
  const f = FIELDS[k]
  const error = fieldError(k, text)
  const [min, max] = limits(k)
  const id = `sim-${k}`
  return (
    <label className="field" data-sim-field={k} data-sim-source={source} data-invalid={error ? '' : undefined}>
      <span>
        {f.label} <em>({f.kind === 'rate' ? '%' : f.kind === 'money' ? '$' : 'number'})</em> <Pill tone={source === 'assumption' ? 'neutral' : 'ok'}>{source === 'assumption' ? 'Assumption' : source === 'measured' ? 'Measured' : 'Listed plan'}</Pill>
      </span>
      <input type="number" inputMode="decimal" min={min} max={max} step={f.kind === 'count' ? f.step : 1} value={text} aria-invalid={error ? true : undefined} aria-describedby={error ? `${id}-err` : undefined} onChange={(e) => onChange(e.target.value)} />
      {error ? (
        <span className="form-error" id={`${id}-err`} role="alert">
          {error} The baseline ({shown(k, baseline)}
          {f.kind === 'rate' ? '%' : ''}) is used until then.
        </span>
      ) : source === 'measured' && SOURCE_HINT[k] ? (
        <span className="fine">{SOURCE_HINT[k]}</span>
      ) : null}
    </label>
  )
}

function Simulate({ baseline, typed, setTyped }) {
  const base = useMemo(() => normalizeAssumptions(baseline?.assumptions || DEFAULTS), [baseline])
  const sources = baseline?.sources || {}
  const text = (k) => typed?.[k] ?? shown(k, base[k])
  const scenario = useMemo(() => normalizeAssumptions(Object.fromEntries(Object.keys(FIELDS).map((k) => [k, typed?.[k] === undefined || fieldError(k, typed[k]) ? base[k] : parsed(k, typed[k])]))), [base, typed])
  const r = useMemo(() => compare(base, scenario), [base, scenario])
  const sens = useMemo(() => sensitivity(scenario), [scenario])
  const measuredCount = Object.values(sources).filter((s) => s === 'measured').length
  return (
    <div className="stack-lg" data-growth-simulate>
      <section className="card">
        <h2 className="card-title">Assumptions</h2>
        <p className="fine">
          {measuredCount ? `${measuredCount} prefilled from measured data (30 days, when the sample is big enough); the rest are editable assumptions.` : 'Nothing measured has a big enough sample yet: every field is an editable assumption.'} “Acquisition spend” is prefilled only from GetShowUps’ own ad spend, never from what your customers spend on their ads. The price is for modeling only and never changes what customers pay.
        </p>
        <div className="sim-grid">
          {Object.keys(FIELDS).map((k) => (
            <Field key={k} k={k} text={text(k)} source={sources[k] || 'assumption'} baseline={base[k]} onChange={(v) => setTyped((t) => ({ ...t, [k]: v }))} />
          ))}
        </div>
        <button type="button" className="link-btn" onClick={() => setTyped(null)} data-sim-reset>
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
              ['New MRR', usd(r.baseline.monthly.newMrrCents), usd(r.scenario.monthly.newMrrCents)],
              ['Acquisition spend', usd(base.spendPerMonthCents), usd(scenario.spendPerMonthCents)],
              ['Cost per new customer', usd(r.baseline.monthly.cacCents), usd(r.scenario.monthly.cacCents)],
              ['Months to earn back that cost (payback)', n1(r.baseline.monthly.paybackMonths), n1(r.scenario.monthly.paybackMonths)],
              [`MRR after ${scenario.months} months (existing ${usd(base.existingMrrCents)})`, usd(r.baseline.endMrrCents), usd(r.scenario.endMrrCents)],
            ].map(([k, a, b]) => (
              <tr key={k}>
                <th scope="row">{k}</th>
                <td>{a}</td>
                <td data-sim-scenario={k}>{b}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="fine" data-sim-payback>
          Payback = the cost of winning one customer ÷ the monthly price: how many months of their subscription pay that cost back. It shows “—” while acquisition spend is $0.
        </p>
        <p className="fine" data-sim-delta>
          Scenario minus baseline: {n1(r.delta.newCustomersPerMonth)} new customers per month, {usd(r.delta.endMrrCents)} MRR at the end, {usd(r.delta.totalSpendCents)} total spend. Changed: {r.changed.length ? r.changed.map((k) => FIELDS[k].label).join(', ') : 'nothing'}.
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

// ---------- Activities ----------
const STATUS = { prepared: ['Prepared', 'neutral'], approved: ['Approved', 'info'], sent: ['Sent', 'ok'], followed_up: ['Followed up', 'ok'], replied: ['Replied', 'ok'], declined: ['Said no', 'neutral'] }
// Something put somewhere (a card, a post, a listing, an ad) is "Live" once it is out; the stored value stays 'sent'.
const isPlacement = (act) => !act.statuses?.includes('replied')
const statusLabel = (status, placement) => (placement && status === 'sent' ? 'Live' : STATUS[status][0])
const STATUS_MEANS = {
  prepared: 'Prepared: the draft is ready. You have not approved it yet.',
  approved: 'Approved: you approved the draft. Nothing has gone out.',
  sent: 'Sent: you sent it yourself. Nothing here sends anything.',
  live: 'Live: you put it out yourself (printed, posted or listed). Nothing here publishes anything.',
  followed_up: 'Followed up: you sent the one follow-up yourself.',
  replied: 'Replied: they answered you.',
  declined: 'Said no: they answered that they are not interested.',
}
const ACQ_ERR = {
  not_ready: 'Status tracking isn’t set up yet (database update 0044).',
  invalid_label: 'Use a company or place name, without an email address or phone number.',
  invalid_cost: 'Enter a cost between $0 and $100,000.',
  invalid_code: 'Use lowercase letters, numbers and dashes (2–32 characters), for example out-06.',
  invalid_activity: 'This activity doesn’t take tracking codes.',
  too_many: 'There are already 300 added codes. Reuse one of them.',
  unknown_code: 'That tracking code no longer exists. Reload the page.',
}
const cell = (r, k) => (r == null || r[k] == null ? '—' : k === 'revenueCents' ? usd(r[k]) : String(r[k]))
const RESULT_COLS = [
  ['prospects', 'Prospects'],
  ['qualified', 'Qualified'],
  ['consultationsBooked', 'Demos booked'],
  ['consultationsAttended', 'Attended'],
  ['businessesCreated', 'Signed up'],
  ['paying', 'Paying'],
  ['revenueCents', 'Paid revenue'],
]
// The one result worth a glance on a closed row: how far the best prospect of this code got.
const keyResult = (r) => {
  if (!r) return 'Results unavailable'
  if (r.paying > 0) return `${plural(r.paying, 'paying customer')}`
  if (r.businessesCreated > 0) return `${r.businessesCreated} signed up`
  if (r.consultationsBooked > 0) return `${plural(r.consultationsBooked, 'demo')} booked`
  return r.prospects > 0 ? plural(r.prospects, 'prospect') : 'No prospects yet'
}
const FILTERS = [
  ['all', 'All', () => true],
  ['action', 'Needs action', (c) => c.status === 'approved' || c.followUpDue],
  ['sent', 'Sent', (c) => c.status === 'sent' || c.status === 'followed_up'],
  ['replied', 'Replied', (c) => c.status === 'replied' || c.status === 'declined'],
]
// Why a copied link would not open, from the sales business's own records (server/acquisition.js linkReadiness).
const LINK_WHY = {
  missing: 'the GetShowUps sales assistant has not been created (Overview, under “GetShowUps sales setup”)',
  not_bookable: 'the GetShowUps sales business needs its calendar connected and its hours confirmed',
  off: 'the sales assistant is switched off (the GetShowUps business’s dashboard, under Receptionist)',
  unknown: 'its setup could not be checked just now, so open the link yourself before you send it',
}
function linkWarnings(state) {
  if (!state) return []
  const bad = [
    ['booking', state.book],
    ['chat', state.chat],
  ].filter(([, s]) => s !== 'ready')
  if (!bad.length) return []
  if (bad.length === 2 && bad[0][1] === bad[1][1]) return [`The booking and chat links will not open yet: ${LINK_WHY[bad[0][1]]}.`]
  return bad.map(([name, s]) => `The ${name} link will not open yet: ${LINK_WHY[s]}.`)
}

function Copy({ text, label }) {
  const [state, setState] = useState('')
  const field = useRef(null)
  useEffect(() => {
    if (state === 'manual') field.current?.select()
  }, [state])
  return (
    <span className="acq-copy">
      <button
        type="button"
        className="btn btn-sm btn-quiet"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(text)
            setState('done')
            setTimeout(() => setState((s) => (s === 'done' ? '' : s)), 1500)
          } catch {
            setState('manual') // the browser refused the clipboard: show the link selected, in the page
          }
        }}
      >
        {state === 'done' ? 'Copied' : label}
      </button>
      {state === 'manual' ? <input ref={field} readOnly value={text} aria-label={`${label}: select and copy`} onFocus={(e) => e.target.select()} /> : null}
    </span>
  )
}

function CodeRow({ c, act, canSave, post, open, toggle, linkState }) {
  const placement = isPlacement(act)
  const save = useSaveState()
  const [label, setLabel] = useState(c.label)
  const [cost, setCost] = useState(c.costCents ? String(c.costCents / 100) : '')
  const last = useRef({}) // what was last sent per field, so Enter followed by blur saves once
  const commit = (field, value, stored) => {
    if (value === stored || last.current[field] === value) return
    last.current[field] = value
    save.run(async () => {
      const r = await post(c.code, { [field]: value })
      if (r.error) last.current[field] = undefined // refused: what was typed stays in the field and can be sent again
      return r
    })
  }
  const commitLabel = () => commit('label', label.trim(), c.label)
  const commitCost = () => commit('costCents', Math.round(Number(cost || 0) * 100), c.costCents)
  const onKey = (e) => {
    if (e.key !== 'Enter') return
    e.preventDefault()
    if (e.currentTarget.dataset.field === 'label') commitLabel()
    else commitCost()
  }
  const statuses = act.statuses?.includes(c.status) ? act.statuses : [...(act.statuses || []), c.status]
  const warnings = linkWarnings(linkState)
  const panel = `acq-panel-${c.code}`
  return (
    <li className="acq-code" data-acq-code={c.code} data-status={c.status} data-open={open ? '' : undefined}>
      <button type="button" className="acq-row" aria-expanded={open} aria-controls={panel} onClick={toggle}>
        <code>{c.code}</code>
        <span className="acq-row-label">{c.label || <span className="acq-none">No name</span>}</span>
        <span className="acq-row-pills">
          <Pill tone={STATUS[c.status][1]}>{statusLabel(c.status, placement)}</Pill>
          {c.followUpDue ? <Pill tone="bad">Follow-up due</Pill> : null}
        </span>
        <span className="acq-row-result">{keyResult(c.results)}</span>
        <span className="acq-row-cost" data-acq-cost>
          {c.costCents ? `Cost ${money(c.costCents)}` : ''}
        </span>
        <span className="acq-row-chev" aria-hidden="true">
          {open ? '▾' : '▸'}
        </span>
      </button>
      {open ? (
        <div className="acq-panel" id={panel}>
          <p className="fine">
            {c.sentAt ? `${placement ? 'Live since' : 'Sent'} ${day(c.sentAt)}. ` : ''}
            {c.followedUpAt ? `Followed up ${day(c.followedUpAt)}. ` : ''}
            {c.repliedAt ? `${c.status === 'declined' ? 'Said no' : 'Replied'} ${day(c.repliedAt)}. ` : ''}
            {c.results ? RESULT_COLS.map(([k, l]) => `${l} ${cell(c.results, k)}`).join(' · ') : 'Results are unavailable until the GetShowUps sales business exists.'}
          </p>
          {canSave ? (
            <>
              <div className="acq-edit">
                <label>
                  <span>Status</span>
                  <select value={c.status} disabled={save.pending} onChange={(e) => save.run(() => post(c.code, { status: e.target.value }))} aria-label={`Status of ${c.code}`}>
                    {statuses.map((v) => (
                      <option key={v} value={v}>
                        {statusLabel(v, placement)}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>Who or where (optional)</span>
                  <input value={label} maxLength={60} onChange={(e) => setLabel(e.target.value)} onBlur={commitLabel} onKeyDown={onKey} data-field="label" aria-label={`Label of ${c.code}`} />
                </label>
                <label>
                  <span>What it cost you ($)</span>
                  <input type="number" inputMode="decimal" min="0" step="1" value={cost} onChange={(e) => setCost(e.target.value)} onBlur={commitCost} onKeyDown={onKey} data-field="cost" aria-label={`Cost of ${c.code}`} />
                </label>
              </div>
              <p className="fine" data-acq-status-means>
                {STATUS_MEANS[placement && c.status === 'sent' ? 'live' : c.status]} Name and cost save when you press Enter or leave the field.
              </p>
              <SaveStatus save={save} />
            </>
          ) : null}
          <div className="acq-tools">
            <Copy text={c.links.book} label="Copy booking link" />
            <Copy text={c.links.chat} label="Copy chat link" />
          </div>
          {warnings.map((w) => (
            <p key={w} className="acq-warn" role="note" data-link-warning>
              {w}
            </p>
          ))}
        </div>
      ) : null}
    </li>
  )
}

function AddCode({ act, all, post, onAdded, onClose }) {
  const save = useSaveState()
  const [code, setCode] = useState('') // stays in the field until it is accepted
  const submit = (e) => {
    e.preventDefault()
    const next = code.trim().toLowerCase()
    if (!next) return save.fail('Type a code first, for example out-06.')
    const taken = all.find((x) => x.code === next)
    const exists = (where) => `“${next}” is already a tracking code${where ? ` in “${where}”` : ''}. Nothing about it was changed. Open it to update it, or choose another code.`
    if (taken) return save.fail(exists(taken.activity))
    save.run(async () => {
      const r = await post(next, { create: true, activity: act.key })
      if (r.code === 'code_exists') return { error: exists('') }
      if (r.error) return r
      setCode('')
      onAdded(next)
      return { saved: `Added ${next}.` }
    })
  }
  return (
    <form className="acq-add" onSubmit={submit} noValidate data-acq-add={act.key}>
      <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="new code, e.g. out-06" maxLength={32} autoFocus autoCapitalize="none" spellCheck={false} aria-label={`New tracking code for ${act.title}`} aria-invalid={save.status === 'error' ? true : undefined} />
      <button type="submit" className="btn btn-sm btn-primary" disabled={save.pending}>
        {save.pending ? 'Adding…' : 'Add a tracking code'}
      </button>
      <button type="button" className="btn btn-sm btn-quiet" onClick={onClose}>
        Close
      </button>
      <SaveStatus save={save} />
    </form>
  )
}

function Activities({ a, reload, ui, setUi }) {
  if (!a) return <LoadError what="the activities" onRetry={reload} />
  const set = (change) => setUi((u) => ({ ...u, ...change }))
  const toggle = (code) => setUi((u) => ({ ...u, open: u.open.includes(code) ? u.open.filter((x) => x !== code) : [...u.open, code] }))
  // One request, one answer for the row that asked: { saved } or { error, code }. The view is read again after a save.
  const post = async (code, change) => {
    const { status, data } = await api('/api/platform/acquisition', { method: 'POST', body: { code, ...change } })
    if (status !== 200) return { error: ACQ_ERR[data?.error] || 'Couldn’t save that. Try again.', code: data?.error }
    await reload()
    return { saved: 'Saved.' }
  }
  const t = a.totals
  const all = a.activities.flatMap((act) => act.codes.map((c) => ({ ...c, activity: act.title })))
  const q = ui.q.trim().toLowerCase()
  const match = FILTERS.find(([id]) => id === ui.filter)[2]
  const visible = (c) => match(c) && (!q || c.code.includes(q) || c.label.toLowerCase().includes(q))
  const narrowed = ui.filter !== 'all' || Boolean(q)
  const acts = a.activities.map((act) => ({ ...act, shown: act.codes.filter(visible) })).filter((act) => !narrowed || act.shown.length)
  const warnings = linkWarnings(a.linkState)
  return (
    <div className="stack-lg" data-growth-activities>
      <section className="card acq-summary" aria-label="Acquisition summary">
        <p className="fine">
          Results are measured from each link’s tracking code{a.days ? ` (last ${a.days} days)` : ''}; test leads are left out. Status and cost are what you record after you act. Recording here never sends a message, publishes anything or spends money.
          {a.live === false ? ' Billing is in test mode, so nobody counts as paying and no revenue is shown.' : ''}
        </p>
        {warnings.map((w) => (
          <p key={w} className="acq-warn" role="note" data-acq-links-warning>
            {w}
          </p>
        ))}
        <ul className="rows">
          <li className="row" data-acq-total="outreach">
            <div className="row-main">
              <p className="row-title">Progress</p>
              <p className="row-sub">
                {plural(t.codes, 'tracking code')} · {t.approved} approved, not sent yet · {t.sent} sent or live so far · {t.replied} replied · {t.declined} said no{t.followUpsDue ? ` · ${plural(t.followUpsDue, 'follow-up')} due` : ''}
              </p>
            </div>
          </li>
          <li className="row" data-acq-total="results">
            <div className="row-main">
              <p className="row-title">
                From these activities <Pill tone={t.results ? 'ok' : 'neutral'}>{t.results ? 'Measured' : 'Unavailable'}</Pill>
              </p>
              <p className="row-sub">{t.results ? RESULT_COLS.map(([k, l]) => `${l} ${cell(t.results, k)}`).join(' · ') : 'The GetShowUps sales business is not set up, so prospects can’t be counted.'}</p>
            </div>
          </li>
          <li className="row" data-acq-total="cost">
            <div className="row-main">
              <p className="row-title">Cost</p>
              <p className="row-sub">
                Recorded by you: {money(t.recordedCostCents)} (your own entries) · Ad spend measured by the platforms: {t.adSpendCents == null ? 'none reported' : money(t.adSpendCents)} · Cost per paying customer: {t.costPerPayingCents == null ? 'unavailable until a prospect pays in live billing' : money(t.costPerPayingCents)}
              </p>
            </div>
          </li>
        </ul>
        {!a.available ? <p className="fine" data-acq-notready>Status and cost can’t be saved until database update 0044 is applied. Links and results already work.</p> : null}
      </section>
      <section className="card acq-plan" aria-label="Activities and tracking codes">
        <div className="acq-bar">
          <div className="fchips" role="group" aria-label="Show tracking codes">
            {FILTERS.map(([id, label, test]) => (
              <button key={id} type="button" className="fchip" aria-pressed={ui.filter === id} onClick={() => set({ filter: id })} data-acq-filter={id}>
                {label} <span className="fchip-count">{all.filter(test).length}</span>
              </button>
            ))}
          </div>
          <input className="search" type="search" value={ui.q} onChange={(e) => set({ q: e.target.value })} placeholder="Find a code or name" aria-label="Find a tracking code" data-acq-find />
        </div>
        <p className="fine" data-acq-legend>
          Open a code to record what you did. Approved = you approved the draft, nothing has gone out · Sent or Live = you sent or published it yourself (a later reply still counts as sent) · Needs action = approved but not sent, or a follow-up is due.
        </p>
        {acts.length ? null : (
          <p className="empty" data-acq-empty>
            No tracking code matches.{' '}
            <button type="button" className="link-btn" onClick={() => set({ filter: 'all', q: '' })}>
              Show all codes
            </button>
          </p>
        )}
        {acts.map((act) => {
          const placement = isPlacement(act)
          const out = act.status.sent + act.status.followed_up + act.status.replied + act.status.declined
          return (
            <section key={act.key} className="acq-act" data-acq-activity={act.key}>
              <header className="acq-act-head">
                <h2 className="acq-act-title">
                  {act.n}. {act.title}
                </h2>
                <p className="acq-act-meta">
                  {act.channel}
                  {act.paid ? ' · needs your budget approval; nothing is spent from here' : ''}
                  {act.derived === 'followUp' ? ` · ${t.followUpsDue ? `${t.followUpsDue} due now (marked on their codes)` : 'none due'}: a sent code with no reply after 4 days is marked “Follow-up due”` : ''}
                  {act.derived === 'destination' ? ' · results are counted on the activity whose link brought the visitor' : ''}
                  {act.codes.length ? ` · ${plural(act.codes.length, 'code')}, ${out} ${placement ? 'live' : 'sent'}` : ''}
                  {act.costCents ? ` · cost ${money(act.costCents)}` : ''}
                </p>
                {a.available && !act.derived && ui.adding !== act.key ? (
                  <button type="button" className="link-btn acq-act-add" onClick={() => set({ adding: act.key })} aria-label={`Add a code to ${act.title}`}>
                    Add a code
                  </button>
                ) : null}
              </header>
              {ui.adding === act.key ? <AddCode act={act} all={all} post={post} onClose={() => set({ adding: '' })} onAdded={(code) => setUi((u) => ({ ...u, filter: 'all', q: '', open: [...u.open, code] }))} /> : null}
              {act.shown.length ? (
                <ul className="acq-rows">
                  {act.shown.map((c) => (
                    <CodeRow key={c.code} c={c} act={act} canSave={a.available} post={post} open={ui.open.includes(c.code)} toggle={() => toggle(c.code)} linkState={a.linkState} />
                  ))}
                </ul>
              ) : null}
            </section>
          )
        })}
      </section>
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

// ---------- Decide ----------
const EVIDENCE = { strong: ['Strong evidence', 'ok'], moderate: ['Moderate evidence', 'info'], weak: ['Weak evidence', 'warn'], insufficient: ['Not enough data yet', 'neutral'] }
function Decide({ d, go }) {
  const sample = Object.entries(d.sample || {})
    .map(([k, v]) => (typeof v === 'object' ? `${FIELDS[k]?.label || k}: ${v.num} of ${v.den}${v.rate != null ? ` (${pctOf(v.rate)}, threshold ${pctOf(v.threshold)})` : ''}` : k === 'leads' ? `${plural(v, 'prospect')} in 30 days` : `${k}: ${v}`))
    .join(' · ')
  const [evidence, tone] = EVIDENCE[d.evidence] || [d.evidence, 'neutral']
  return (
    <section className="card" data-growth-decide data-bottleneck={d.bottleneck || 'none'}>
      <h2 className="card-title">{d.title}</h2>
      <p>{d.why}</p>
      <dl className="kv">
        <div>
          <dt>Experiment</dt>
          <dd data-decide-experiment>
            {d.experiment}{' '}
            {d.activities?.length ? (
              <button type="button" className="link-btn" onClick={() => go('activities')}>
                Open Activities
              </button>
            ) : null}
          </dd>
        </div>
        <div>
          <dt>Estimated upside</dt>
          <dd>{d.upside ? `+${n1(d.upside.newCustomersPerMonth)} new customers and ${usd(d.upside.newMrrCentsPerMonth)} new MRR per month if this rate improves by ${d.upside.ratePoints} points (${d.upside.note})` : 'Not estimated: there is no reliable rate to move yet.'}</dd>
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
            <Pill tone={tone}>{evidence}</Pill> {sample}
          </dd>
        </div>
      </dl>
      <p className="fine">Nothing runs by itself: no spend, no campaign change, no message is sent from here.</p>
    </section>
  )
}

export default function Growth() {
  const [mode, setMode] = useState(modeOf)
  const [r, setR] = useState(undefined)
  // Kept here, above the tabs, so a tab switch within the visit loses nothing that was typed or chosen.
  const [typed, setTyped] = useState(null)
  const [ui, setUi] = useState({ filter: 'all', q: '', open: [], adding: '' })
  const load = () => api('/api/platform/growth').then(({ status, data }) => setR(status === 200 ? data : null))
  useEffect(() => {
    load()
    // Back / Forward (and a hand-edited address) move between tabs: the tab is the address's hash.
    const onMove = () => setMode(modeOf())
    window.addEventListener('popstate', onMove)
    window.addEventListener('hashchange', onMove)
    return () => {
      window.removeEventListener('popstate', onMove)
      window.removeEventListener('hashchange', onMove)
    }
  }, [])
  const go = (v) => {
    if (v === mode) return
    window.history.pushState(null, '', `${window.location.pathname}#${v}`)
    setMode(v)
  }
  return (
    <div className="enter growth">
      <div className="page-head">
        <h1 className="title title--page">Growth</h1>
      </div>
      {r === undefined ? (
        <Loading what="Growth" />
      ) : r === null ? (
        <LoadError
          what="Growth"
          onRetry={() => {
            setR(undefined)
            load()
          }}
        />
      ) : (
        <>
          <div className="seg" role="tablist" aria-label="Growth views">
            {MODES.map(([v, label]) => (
              <button key={v} type="button" role="tab" aria-selected={mode === v} className={mode === v ? 'seg-on' : ''} onClick={() => go(v)} data-growth-mode={v}>
                {label}
              </button>
            ))}
          </div>
          {mode === 'pipeline' ? <Pipeline /> : mode === 'partners' ? <Partners /> : mode === 'activities' ? <Activities a={r.acquisition} reload={load} ui={ui} setUi={setUi} /> : mode === 'measure' ? <Measure m={r.measure} /> : mode === 'simulate' ? <Simulate baseline={r.baseline} typed={typed} setTyped={setTyped} /> : <Decide d={r.decide} go={go} />}
        </>
      )}
    </div>
  )
}
