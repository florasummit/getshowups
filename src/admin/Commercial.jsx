// Admin → Growth → Pipeline | Partners (GET /api/platform/commercial; writes: POST /api/platform/partners, audited).
// Pipeline: every real business with its channel, source, partner or closing rep, payment, setup and invitation state,
// and totals by channel and rep. Collected revenue, commission owed, cost per customer and retention exist only in live
// billing; in test mode they read "Unavailable" with the reason, never 0. Test businesses are left out (count shown).
// Partners: GetShowUps' own partner records (no login for partners): the agreement versions, and per partner its
// onboarding (status, checklist), details, acceptances, versioned terms and payouts recorded after paying outside
// GetShowUps. Terms are typed field by field with no defaults; nothing is paid from here; nothing accrues while the
// referral program is off.
import { useEffect, useMemo, useState } from 'react'
import { api } from '../lib/api.js'
import { ConfirmInline, EmptyState, LoadError, Loading, Pill, SaveStatus } from '../dashboard/ui.jsx'
import { useSaveState } from '../dashboard/ui-hooks.js'
import { humanDate, money, plural } from '../lib/format.js'

const CHANNEL = { self_serve: 'Self-serve', founder: 'Founder', sales_rep: 'Sales rep', partner: 'Partner', unrecorded: 'Not recorded' }
const PAYMENT = { confirmed: ['Paid', 'ok'], test: ['Test mode', 'warn'], pending: ['Payment pending', 'warn'], ended: ['Ended', 'neutral'], not_billed: ['Not billed', 'neutral'] }
const SETUP = { live: ['Set up', 'ok'], invited: ['Waiting for owner', 'warn'], calendar: ['Setting up', 'info'], hours: ['Setting up', 'info'], suspended: ['Suspended', 'bad'] }
const INVITE = { claimed: ['Claimed', 'ok'], pending: ['Invitation pending', 'warn'], none: ['No owner yet', 'neutral'] }
const REFUSAL = { unknown_code: 'unknown code', not_active: 'partner not active', no_terms: 'partner had no terms in effect', self_referral: 'self-referral refused', outside_window: 'outside the partner’s window' }
const day = (t) => humanDate(t, { weekday: false })
const usd = (c) => money(c)

function useCommercial() {
  const [r, setR] = useState(undefined)
  const load = () => api('/api/platform/commercial').then(({ status, data }) => setR(status === 200 ? data : null))
  useEffect(() => {
    load()
  }, [])
  return [r, load, () => setR(undefined)]
}

function Cell({ v, unit, why }) {
  if (v == null) return <td className="com-na" title={why}>Unavailable</td>
  return <td className="com-num">{unit === 'cents' ? usd(v) : unit === 'percent' ? `${Math.round(v * 100)}%` : v.toLocaleString('en-US')}</td>
}

function Totals({ groups, live, label, keyName }) {
  const why = live ? 'Needs a live paying customer in this group.' : 'Billing is in test mode: nothing is revenue yet.'
  return (
    <div className="com-table-wrap" tabIndex={0} role="region" aria-label={`${label} (scrolls sideways)`}>
      <table className="com-table" data-com-totals={keyName}>
        <thead>
          <tr>
            <th scope="col">{label}</th>
            <th scope="col">Businesses</th>
            <th scope="col">Payment pending</th>
            <th scope="col">Paid</th>
            <th scope="col">Invitation pending</th>
            <th scope="col">Claimed</th>
            <th scope="col">Set up</th>
            <th scope="col">Active</th>
            <th scope="col">Collected</th>
            <th scope="col">Commission owed</th>
            <th scope="col">Cost per customer</th>
            <th scope="col">Retention</th>
          </tr>
        </thead>
        <tbody>
          {groups.map((g) => (
            <tr key={g.key} data-com-group={g.key}>
              <th scope="row">{keyName === 'channel' ? CHANNEL[g.key] || g.key : g.key}</th>
              <td className="com-num">{g.businesses}</td>
              <td className="com-num">{g.paymentPending}</td>
              <td className="com-num">{g.paymentConfirmed}</td>
              <td className="com-num">{g.invitationPending}</td>
              <td className="com-num">{g.claimed}</td>
              <td className="com-num">{g.setupComplete}</td>
              <td className="com-num">{g.activeSubscriptions}</td>
              <Cell v={g.revenueCents} unit="cents" why={why} />
              <Cell v={g.commissionCents} unit="cents" why={why} />
              <Cell v={g.acquisitionCostCents} unit="cents" why={live ? 'Needs commission owed and an active customer in this group.' : why} />
              <Cell v={g.retention} unit="percent" why={why} />
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function Pipeline() {
  const [r, load, reset] = useCommercial()
  const [filter, setFilter] = useState('all')
  const [q, setQ] = useState('')
  const p = r?.pipeline
  const shown = useMemo(() => (p ? p.rows.filter((x) => (filter === 'all' || x.channel === filter) && (!q || x.name.toLowerCase().includes(q.toLowerCase()))) : []), [p, filter, q])
  if (r === undefined) return <Loading what="the pipeline" />
  if (r === null)
    return (
      <LoadError
        what="the pipeline"
        onRetry={() => {
          reset()
          load()
        }}
      />
    )
  const live = p.billingMode === 'live'
  return (
    <section className="card com" aria-label="Commercial pipeline" data-com-pipeline>
      <p className="fine">
        Billing is {live ? 'live' : 'in test mode, so no business counts as paying and nothing is revenue'} · referral program {p.referralsEnabled ? 'on' : 'off (links and partners can be prepared; no commission accrues)'} · {plural(p.excludedTest, 'test business', 'test businesses')} left out.
        {p.enrollmentsReady ? '' : ' Assisted enrollments are not available yet.'}
      </p>
      {p.enrollmentsReady && Object.keys(p.enrollmentStages || {}).length ? (
        <p className="fine" data-com-enrollments>
          Assisted enrollments:{' '}
          {Object.entries(p.enrollmentStages)
            .map(([s, n]) => `${String(s).replace(/_/g, ' ')} ${n}`)
            .join(' · ')}
        </p>
      ) : null}
      <h2 className="card-title">By channel</h2>
      <Totals groups={p.byChannel} live={live} label="Channel" keyName="channel" />
      {p.byRep.length ? (
        <>
          <h2 className="card-title">By closing rep</h2>
          <Totals groups={p.byRep} live={live} label="Rep" keyName="rep" />
        </>
      ) : null}
      <h2 className="card-title">Businesses</h2>
      {p.rows.length === 0 ? (
        <EmptyState title="No businesses yet">Each business appears here when it is created, with how it came in and how far it has got.</EmptyState>
      ) : (
        <>
          <div className="acq-bar">
            <div className="fchips" role="group" aria-label="Show channel">
              {['all', ...Object.keys(CHANNEL)].map((k) => (
                <button key={k} type="button" className="fchip" aria-pressed={filter === k} onClick={() => setFilter(k)} data-com-filter={k}>
                  {k === 'all' ? 'All' : CHANNEL[k]}
                </button>
              ))}
            </div>
            {p.rows.length > 20 ? <input className="search" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a business" aria-label="Find a business" /> : null}
          </div>
          {shown.length === 0 ? <p className="fine">No business matches.</p> : null}
          <ul className="rows" data-com-rows>
            {shown.map((x) => {
              const [pl, pt] = PAYMENT[x.payment] || [x.payment, 'neutral']
              const [sl, st] = SETUP[x.setup] || ['Setting up', 'info']
              const [il, it] = INVITE[x.invitation]
              return (
                <li key={x.id} className="row" data-com-row={x.id}>
                  <div className="row-main">
                    <p className="row-title">
                      {x.name} <Pill tone="info">{CHANNEL[x.channel] || x.channel}</Pill> <Pill tone={pt}>{pl}</Pill> <Pill tone={st}>{sl}</Pill> <Pill tone={it}>{il}</Pill>
                    </p>
                    <p className="row-sub">
                      Created {day(x.createdAt)} · source {x.source}
                      {x.partner ? ` · partner ${x.partner.name}` : ''}
                      {x.partnerRefusal ? ` · referral not counted (${REFUSAL[x.partnerRefusal] || 'refused'})` : ''}
                      {x.rep ? ` · rep ${x.rep}` : ''}
                      {x.enrollmentStage ? ` · enrollment: ${String(x.enrollmentStage).replace(/_/g, ' ')}` : ''}
                    </p>
                  </div>
                  {x.collectedRevenueCents == null ? null : <strong className="growth-value">{usd(x.collectedRevenueCents)}</strong>}
                </li>
              )
            })}
          </ul>
          <p className="fine">{live ? 'The amount on the right is money collected (live payments only).' : 'Money collected appears here once billing is live.'} “Not recorded” = created before channels were recorded.</p>
        </>
      )}
    </section>
  )
}

// ---------- Partners ----------
// Field-level messages for refused input (shown next to the field, the typed value stays).
const FIELD_ERRORS = {
  invalid_terms_type: ['type', 'Choose a percentage or a fixed amount.'],
  invalid_terms_value: ['value', 'Enter a percentage above 0 and up to 100 (two decimals at most), or a whole fixed amount in dollars.'],
  invalid_terms_currency: ['currency', 'Enter the three-letter currency, for example usd.'],
  invalid_terms_recurring: ['recurring', 'Choose how long the commission runs (1 to 120 months for a set period).'],
  invalid_terms_window: ['windowDays', 'Enter the attribution window in whole days, from 1 to 3650.'],
  invalid_effective_date: ['effectiveFrom', 'Enter a date, or leave it empty for today.'],
  effective_before_previous: ['effectiveFrom', 'Choose a date on or after the current version’s start.'],
  effective_before_accrual: ['effectiveFrom', 'Choose a date after this partner’s latest commission: earned commissions are never recalculated.'],
  invalid_name: ['name', 'Enter the partner’s name (up to 80 characters).'],
  invalid_email: ['contactEmail', 'Enter a valid email address, or leave it empty.'],
  invalid_title: ['title', 'Enter a title.'],
  invalid_version_label: ['versionLabel', 'Enter a version label, for example 2027-01.'],
  version_label_taken: ['versionLabel', 'That version label is already used. Choose a new one.'],
  agreement_empty: ['body', 'Paste the agreement text or give a link to it.'],
  invalid_url: ['url', 'Enter a full https:// link.'],
  unknown_agreement: ['agreementId', 'Choose an agreement version.'],
  invalid_accepted_date: ['acceptedAt', 'Enter the date it was accepted (not in the future).'],
  invalid_paid_on: ['paidOn', 'Enter the date it was paid (not in the future).'],
  invalid_method: ['methodLabel', 'Say how it was paid, for example Bank transfer or PayPal.'],
  invalid_amount: ['amount', 'Enter an amount above $0.'],
  invalid_currency: ['currency', 'Enter the three-letter currency, for example usd.'],
  invalid_period: ['periodTo', 'The period must end on or after it starts.'],
}
// Whole-form messages.
const FORM_ERRORS = {
  sensitive_number: 'Bank and card numbers are never stored here. Describe it in words (for example “PayPal, on file with finance”) and leave the numbers out.',
  already_accepted: 'That acceptance is already recorded.',
  already_settled: 'One of those commissions has already been paid. Refresh to see the current list.',
  over_balance: 'That is more than this partner is owed right now. Nothing was recorded.',
  amount_mismatch: 'The amount must equal the selected commissions.',
  unknown_accrual: 'Choose commissions from the list.',
  nothing_owed_on_accrual: 'A selected commission was fully refunded, so nothing is owed on it.',
  mixed_currency: 'Choose commissions in one currency.',
  already_reversed: 'That payout was already reversed.',
  partner_ended: 'This partnership has ended; its terms can no longer change.',
  terms_required: 'Set commission terms first.',
  no_agreement: 'Add the partner agreement first (above).',
  agreement_not_accepted: 'Record that the partner accepted the current agreement first.',
  invalid_transition: 'That change isn’t possible from the current status.',
  conflict: 'Someone else changed this partner just now. Refresh and try again.',
  not_ready: 'Partners can’t be saved until the database is updated.',
}
const STATUS = { invited: ['Invited', 'info'], onboarding: ['Onboarding', 'info'], active: ['Active', 'ok'], paused: ['Paused', 'warn'], ended: ['Ended', 'neutral'] }
const MOVE_LABEL = (from, to) => (to === 'onboarding' ? 'Start onboarding' : to === 'active' ? (from === 'paused' ? 'Resume' : 'Activate') : to === 'paused' ? 'Pause' : 'End partnership')
const CHECK = [
  ['contactDetails', 'Contact details recorded'],
  ['terms', 'Commission terms set'],
  ['agreement', 'Current agreement accepted'],
  ['payoutDetails', 'Payout details recorded'],
]
const EMPTY_TERMS = { type: '', value: '', currency: '', recurring: '', months: '', windowDays: '' }
const termsBody = (t) => ({
  type: t.type,
  value: t.type === 'fixed' ? Math.round(Number(t.value) * 100) : Number(t.value),
  ...(t.type === 'fixed' ? { currency: t.currency.trim().toLowerCase() } : {}),
  recurring: t.recurring === 'months' ? `months:${t.months}` : t.recurring,
  windowDays: Number(t.windowDays),
})
const anyTerms = (t) => Object.values(t).some((v) => String(v).trim() !== '')
const today = () => new Date().toISOString().slice(0, 10)
function termsText(t) {
  if (!t) return 'No terms in effect: nothing accrues.'
  const amount = t.type === 'percent' ? `${t.value}% of each collected payment (tax excluded)` : `${usd(t.value)} ${t.currency.toUpperCase()} per collected payment (at most the payment)`
  const run = t.recurring === 'once' ? 'first payment only' : t.recurring === 'lifetime' ? 'every payment while subscribed' : `payments in the first ${plural(Number(t.recurring.split(':')[1]), 'month')}`
  return `${amount}, ${run}; referral counts if the business is created within ${plural(t.windowDays, 'day')} of the first visit.`
}
const owedText = (balances) =>
  Object.entries(balances || {})
    .map(([cur, b]) => `${b.owedCents < 0 ? `overpaid ${usd(-b.owedCents)}` : `${usd(b.owedCents)} owed`} ${cur.toUpperCase()} (earned ${usd(b.earnedCents)}, paid ${usd(b.paidCents)})`)
    .join(' · ')

function Field({ scope, name, label, errors, children, optional = false }) {
  return (
    <label className="field">
      <span>
        {label} {optional ? <em>optional</em> : null}
      </span>
      {children}
      {errors[name] ? (
        <span className="field-error" id={`err-${scope}-${name}`}>
          {errors[name]}
        </span>
      ) : null}
    </label>
  )
}
const inv = (scope, errors, name) => (errors[name] ? { 'aria-invalid': true, 'aria-describedby': `err-${scope}-${name}` } : {})

function TermsFields({ scope, t, set, errors }) {
  const on = (k) => (e) => set({ ...t, [k]: e.target.value })
  const f = (name, label, input, optional) => (
    <Field scope={scope} name={name} label={label} errors={errors} optional={optional}>
      {input}
    </Field>
  )
  return (
    <div className="acq-edit com-terms">
      {f(
        'type',
        'Commission',
        <select value={t.type} onChange={on('type')} {...inv(scope, errors, 'type')} data-terms="type">
          <option value="">Choose…</option>
          <option value="percent">Percentage of collected payments</option>
          <option value="fixed">Fixed amount per collected payment</option>
        </select>,
      )}
      {f('value', t.type === 'fixed' ? 'Amount ($)' : 'Percentage (%)', <input value={t.value} onChange={on('value')} inputMode="decimal" {...inv(scope, errors, 'value')} data-terms="value" />)}
      {t.type === 'fixed' ? f('currency', 'Currency', <input value={t.currency} onChange={on('currency')} maxLength={3} placeholder="usd" autoCapitalize="none" {...inv(scope, errors, 'currency')} data-terms="currency" />) : null}
      {f(
        'recurring',
        'Runs for',
        <select value={t.recurring} onChange={on('recurring')} {...inv(scope, errors, 'recurring')} data-terms="recurring">
          <option value="">Choose…</option>
          <option value="once">First payment only</option>
          <option value="months">A set number of months</option>
          <option value="lifetime">Every payment while subscribed</option>
        </select>,
      )}
      {t.recurring === 'months' ? f('months', 'Months', <input value={t.months} onChange={on('months')} inputMode="numeric" data-terms="months" />) : null}
      {f('windowDays', 'Attribution window (days)', <input value={t.windowDays} onChange={on('windowDays')} inputMode="numeric" {...inv(scope, errors, 'windowDays')} data-terms="windowDays" />)}
    </div>
  )
}

async function post(body) {
  const { status, data } = await api('/api/platform/partners', { method: 'POST', body })
  return status === 200 ? data : { error: data?.error || 'storage_error' }
}
// Maps a refusal onto the field it concerns (or the form), and returns what the save state shows.
const failure = (error, setErrors) => {
  const known = FIELD_ERRORS[error]
  if (known) {
    setErrors({ [known[0]]: known[1] })
    return { error: 'Check the highlighted field.' }
  }
  return { error: FORM_ERRORS[error] || 'Something went wrong. Please try again.' }
}
// One small form: its own save state and field errors.
function useForm() {
  const save = useSaveState()
  const [errors, setErrors] = useState({})
  const run = (fn) => {
    setErrors({})
    return save.run(async () => {
      const r = await fn()
      return r?.error ? failure(r.error, setErrors) : r
    })
  }
  return { save, errors, run }
}

function Agreements({ ps, onSaved }) {
  const { save, errors, run } = useForm()
  const [open, setOpen] = useState(!ps.agreements.length)
  const [a, setA] = useState({ title: ps.agreements[0]?.title || '', versionLabel: '', body: '', url: '' })
  const current = ps.agreements[0]
  const on = (k) => (e) => setA({ ...a, [k]: e.target.value })
  const submit = (e) => {
    e.preventDefault()
    run(async () => {
      const r = await post({ action: 'agreement', ...a })
      if (r.error) return r
      setA({ ...a, versionLabel: '', body: '', url: '' })
      setOpen(false)
      onSaved()
      return { saved: `Added agreement version ${r.agreement.versionLabel}. Partners need to accept it before they can be activated or resumed.` }
    })
  }
  return (
    <div className="com-block" data-agreements>
      <h2 className="card-title">Partner agreement</h2>
      {current ? (
        <p className="row-sub" data-agreement-current>
          Current: <strong>{current.title}</strong> · version {current.versionLabel} · added {day(current.createdAt)}
          {current.url ? (
            <>
              {' '}
              ·{' '}
              <a href={current.url} target="_blank" rel="noreferrer noopener">
                open
              </a>
            </>
          ) : null}
        </p>
      ) : (
        <p className="fine">No agreement yet. Add one: a partner can be activated only after accepting the current version.</p>
      )}
      {current?.body ? (
        <details className="com-details">
          <summary>Read the text</summary>
          <p className="com-agreement-text">{current.body}</p>
        </details>
      ) : null}
      {current ? (
        <p className="fine" data-not-accepted>
          {ps.notAccepted.length ? `Not accepted yet: ${ps.notAccepted.map((p) => p.name).join(', ')}.` : 'Every partner has accepted the current version.'}
        </p>
      ) : null}
      {ps.agreements.length > 1 ? (
        <details className="com-details">
          <summary>Earlier versions ({ps.agreements.length - 1})</summary>
          <ul className="com-list">
            {ps.agreements.slice(1).map((g) => (
              <li key={g.id}>
                {g.title} · version {g.versionLabel} · added {day(g.createdAt)}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {open ? (
        <form className="com-new" onSubmit={submit} noValidate data-agreement-form>
          <div className="acq-edit">
            <Field scope="agr" name="title" label="Title" errors={errors}>
              <input value={a.title} onChange={on('title')} maxLength={120} {...inv('agr', errors, 'title')} data-agreement="title" />
            </Field>
            <Field scope="agr" name="versionLabel" label="Version label" errors={errors}>
              <input value={a.versionLabel} onChange={on('versionLabel')} maxLength={40} placeholder="2027-01" {...inv('agr', errors, 'versionLabel')} data-agreement="versionLabel" />
            </Field>
            <Field scope="agr" name="url" label="Link to the document" errors={errors} optional>
              <input value={a.url} onChange={on('url')} inputMode="url" placeholder="https://…" {...inv('agr', errors, 'url')} data-agreement="url" />
            </Field>
          </div>
          <Field scope="agr" name="body" label="Agreement text" errors={errors} optional>
            <textarea value={a.body} onChange={on('body')} rows={4} maxLength={20000} {...inv('agr', errors, 'body')} data-agreement="body" />
          </Field>
          <div className="acq-tools">
            <button type="submit" className="btn btn-primary" disabled={save.pending} data-agreement-save>
              {save.pending ? 'Adding…' : 'Add agreement version'}
            </button>
            {current ? (
              <button type="button" className="btn btn-quiet" onClick={() => setOpen(false)}>
                Cancel
              </button>
            ) : null}
            <SaveStatus save={save} />
          </div>
        </form>
      ) : (
        <div className="acq-tools">
          <button type="button" className="btn btn-sm btn-quiet" onClick={() => setOpen(true)} data-agreement-new>
            Add a new version
          </button>
          <SaveStatus save={save} />
        </div>
      )}
    </div>
  )
}

function NewPartner({ onSaved }) {
  const { save, errors, run } = useForm()
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [payout, setPayout] = useState('')
  const [t, setT] = useState(EMPTY_TERMS)
  const submit = (e) => {
    e.preventDefault()
    run(async () => {
      if (!name.trim()) return { error: 'invalid_name' }
      const r = await post({ action: 'create', name, contactEmail: email.trim() || null, payoutReference: payout.trim() || null, terms: anyTerms(t) ? termsBody(t) : null })
      if (r.error) return r
      setName('')
      setEmail('')
      setPayout('')
      setT(EMPTY_TERMS)
      onSaved()
      return { saved: `Added ${r.partner.name} as invited. Open it below to finish onboarding.` }
    })
  }
  return (
    <form className="com-new" onSubmit={submit} noValidate data-com-new>
      <h2 className="card-title">Add a partner</h2>
      <div className="acq-edit">
        <Field scope="new" name="name" label="Name" errors={errors}>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} {...inv('new', errors, 'name')} data-partner-name />
        </Field>
        <Field scope="new" name="contactEmail" label="Contact email" errors={errors} optional>
          <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" autoComplete="off" {...inv('new', errors, 'contactEmail')} data-partner-email />
        </Field>
        <Field scope="new" name="payoutReference" label="Payout details (words only, no account numbers)" errors={errors} optional>
          <input value={payout} onChange={(e) => setPayout(e.target.value)} maxLength={200} autoComplete="off" data-partner-payout />
        </Field>
      </div>
      <p className="fine">Commission terms (optional now; nothing accrues until the partner is active). No value is filled in for you.</p>
      <TermsFields scope="new" t={t} set={setT} errors={errors} />
      <div className="acq-tools">
        <button type="submit" className="btn btn-primary" disabled={save.pending} data-partner-create>
          {save.pending ? 'Adding…' : 'Add partner'}
        </button>
        <SaveStatus save={save} />
      </div>
    </form>
  )
}

function Copy({ text }) {
  const [done, setDone] = useState('')
  return (
    <span className="acq-copy">
      <button
        type="button"
        className="btn btn-sm btn-quiet"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(text)
            setDone('Copied')
          } catch {
            setDone('manual')
          }
        }}
        data-partner-copy
      >
        {done === 'Copied' ? 'Copied' : 'Copy link'}
      </button>
      {done === 'manual' ? <input readOnly value={text} aria-label="Referral link: select and copy" onFocus={(e) => e.target.select()} autoFocus /> : null}
    </span>
  )
}

const totals = (m) =>
  Object.entries(m || {})
    .map(([cur, v]) => `${usd(v.owedCents)} ${cur.toUpperCase()} (accrued ${usd(v.accruedCents)}, reversed ${usd(v.reversedCents)})`)
    .join(' · ')

function Onboarding({ p, onSaved }) {
  const { save, run } = useForm()
  const [ending, setEnding] = useState(false)
  const move = (to, confirm = false) =>
    run(async () => {
      const r = await post({ action: 'status', id: p.id, to, confirm })
      if (r.error) return r
      setEnding(false)
      onSaved()
      return { saved: to === 'active' ? `${p.name} is active: new referrals now count and commissions accrue (while the program is on).` : to === 'paused' ? `Paused ${p.name}: new referrals and commissions stop.` : to === 'ended' ? `Ended the partnership with ${p.name}. What is owed stays payable.` : `${p.name} is onboarding.` }
    })
  const blockers = p.checklist.blockers
  return (
    <section className="com-section" aria-label="Onboarding" data-partner-onboarding>
      <h3 className="com-h">Onboarding</h3>
      <ul className="com-check">
        {CHECK.map(([k, label]) => (
          <li key={k} data-check={k} data-done={p.checklist.items[k] ? 'yes' : 'no'}>
            <Pill tone={p.checklist.items[k] ? 'ok' : 'neutral'}>{p.checklist.items[k] ? 'Done' : 'To do'}</Pill> {label}
          </li>
        ))}
      </ul>
      {p.moves.includes('active') && blockers.length ? <p className="fine" data-activate-blocked>To activate: {blockers.map((b) => FORM_ERRORS[b]).join(' ')}</p> : null}
      <div className="acq-tools">
        {p.moves
          .filter((to) => to !== 'ended')
          .map((to) => (
            <button key={to} type="button" className={`btn btn-sm ${to === 'active' ? 'btn-primary' : 'btn-quiet'}`} disabled={save.pending || (to === 'active' && blockers.length > 0)} onClick={() => move(to)} data-move={to}>
              {MOVE_LABEL(p.status, to)}
            </button>
          ))}
        {p.moves.includes('ended') && !ending ? (
          <button type="button" className="btn btn-sm btn-quiet" onClick={() => setEnding(true)} data-move="ended">
            End partnership
          </button>
        ) : null}
        <SaveStatus save={save} />
      </div>
      {ending ? <ConfirmInline question={`End the partnership with ${p.name}?`} detail="It can’t be reactivated. New referrals and commissions stop; what is owed stays payable." confirmLabel="End partnership" busy={save.pending} onConfirm={() => move('ended', true)} onCancel={() => setEnding(false)} /> : null}
    </section>
  )
}

function Details({ p, onSaved }) {
  const { save, errors, run } = useForm()
  const [d, setD] = useState({ name: p.name, contactEmail: p.contactEmail || '', payoutReference: p.payoutReference || '' })
  const on = (k) => (e) => setD({ ...d, [k]: e.target.value })
  const scope = `det-${p.id}`
  const submit = (e) => {
    e.preventDefault()
    run(async () => {
      const r = await post({ action: 'details', id: p.id, name: d.name, contactEmail: d.contactEmail.trim() || null, payoutReference: d.payoutReference.trim() || null })
      if (r.error) return r
      onSaved()
      return { saved: 'Details saved.' }
    })
  }
  return (
    <form className="com-section com-edit" onSubmit={submit} noValidate aria-label="Details" data-partner-details>
      <h3 className="com-h">Details</h3>
      <div className="acq-edit">
        <Field scope={scope} name="name" label="Name" errors={errors}>
          <input value={d.name} onChange={on('name')} maxLength={80} {...inv(scope, errors, 'name')} />
        </Field>
        <Field scope={scope} name="contactEmail" label="Contact email" errors={errors} optional>
          <input value={d.contactEmail} onChange={on('contactEmail')} type="email" autoComplete="off" {...inv(scope, errors, 'contactEmail')} />
        </Field>
        <Field scope={scope} name="payoutReference" label="Payout details (words only, no account numbers)" errors={errors} optional>
          <input value={d.payoutReference} onChange={on('payoutReference')} maxLength={200} autoComplete="off" data-details="payoutReference" />
        </Field>
      </div>
      <div className="acq-tools">
        <button type="submit" className="btn btn-sm btn-primary" disabled={save.pending} data-details-save>
          Save details
        </button>
        <SaveStatus save={save} />
      </div>
    </form>
  )
}

function Acceptance({ p, agreements, onSaved }) {
  const { save, errors, run } = useForm()
  const [f, setF] = useState({ agreementId: agreements[0]?.id ? String(agreements[0].id) : '', acceptedAt: today(), evidence: '' })
  const on = (k) => (e) => setF({ ...f, [k]: e.target.value })
  const scope = `acc-${p.id}`
  const submit = (e) => {
    e.preventDefault()
    run(async () => {
      const r = await post({ action: 'accept', id: p.id, agreementId: Number(f.agreementId), acceptedAt: f.acceptedAt, evidence: f.evidence.trim() || null })
      if (r.error) return r
      setF({ ...f, evidence: '' })
      onSaved()
      return { saved: 'Acceptance recorded.' }
    })
  }
  return (
    <section className="com-section" aria-label="Agreement" data-partner-agreement>
      <h3 className="com-h">Agreement</h3>
      {p.acceptances.length ? (
        <ul className="com-list" data-acceptances>
          {p.acceptances.map((a) => (
            <li key={a.agreementId}>
              Accepted version {a.versionLabel} on {day(a.acceptedAt)} (recorded by {a.recordedBy}){a.evidence ? ` · ${a.evidence}` : ''}
            </li>
          ))}
        </ul>
      ) : (
        <p className="fine">No acceptance recorded yet.</p>
      )}
      {agreements.length ? (
        <form className="com-edit" onSubmit={submit} noValidate data-accept-form>
          <div className="acq-edit">
            <Field scope={scope} name="agreementId" label="Version accepted" errors={errors}>
              <select value={f.agreementId} onChange={on('agreementId')} {...inv(scope, errors, 'agreementId')} data-accept="agreementId">
                {agreements.map((g, i) => (
                  <option key={g.id} value={g.id}>
                    {g.versionLabel}
                    {i === 0 ? ' (current)' : ''}
                  </option>
                ))}
              </select>
            </Field>
            <Field scope={scope} name="acceptedAt" label="Accepted on" errors={errors}>
              <input type="date" value={f.acceptedAt} onChange={on('acceptedAt')} {...inv(scope, errors, 'acceptedAt')} data-accept="acceptedAt" />
            </Field>
            <Field scope={scope} name="evidence" label="Evidence note" errors={errors} optional>
              <input value={f.evidence} onChange={on('evidence')} maxLength={500} placeholder="Signed copy in the shared drive" data-accept="evidence" />
            </Field>
          </div>
          <div className="acq-tools">
            <button type="submit" className="btn btn-sm btn-primary" disabled={save.pending} data-accept-save>
              Record acceptance
            </button>
            <SaveStatus save={save} />
          </div>
          <p className="fine">Partners have no sign-in: you record what they accepted and how you know.</p>
        </form>
      ) : null}
    </section>
  )
}

function Terms({ p, onSaved }) {
  const { save, errors, run } = useForm()
  const [open, setOpen] = useState(false)
  const [t, setT] = useState(EMPTY_TERMS)
  const [from, setFrom] = useState('')
  const scope = `terms-${p.id}`
  const submit = (e) => {
    e.preventDefault()
    run(async () => {
      const r = await post({ action: 'terms', id: p.id, terms: termsBody(t), effectiveFrom: from || null })
      if (r.error) return r
      setOpen(false)
      setT(EMPTY_TERMS)
      setFrom('')
      onSaved()
      return { saved: `Saved terms version ${r.version}. It applies to businesses referred from its start date; earlier referrals keep their terms.` }
    })
  }
  return (
    <section className="com-section" aria-label="Commission terms" data-partner-terms-section>
      <h3 className="com-h">Commission terms</h3>
      <p className="row-sub" data-partner-terms>
        {p.termsVersion ? `Version ${p.termsVersion} in effect: ` : ''}
        {termsText(p.terms)}
      </p>
      {p.termsHistory.length ? (
        <ul className="com-list" data-terms-history>
          {p.termsHistory.map((h) => (
            <li key={h.id} data-terms-version={h.version}>
              Version {h.version} · from {day(h.effectiveFrom)} {h.inEffect ? <Pill tone="ok">In effect</Pill> : h.scheduled ? <Pill tone="info">Scheduled</Pill> : null} · {termsText(h.terms)}
            </li>
          ))}
        </ul>
      ) : null}
      {p.status !== 'ended' ? (
        open ? (
          <form className="com-edit" onSubmit={submit} noValidate>
            <TermsFields scope={scope} t={t} set={setT} errors={errors} />
            <div className="acq-edit">
              <Field scope={scope} name="effectiveFrom" label="Starts on (empty = today)" errors={errors} optional>
                <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} {...inv(scope, errors, 'effectiveFrom')} data-terms="effectiveFrom" />
              </Field>
            </div>
            <div className="acq-tools">
              <button type="submit" className="btn btn-sm btn-primary" disabled={save.pending} data-terms-save>
                Save as a new version
              </button>
              <button type="button" className="btn btn-sm btn-quiet" onClick={() => setOpen(false)}>
                Cancel
              </button>
              <SaveStatus save={save} />
            </div>
          </form>
        ) : (
          <div className="acq-tools">
            <button type="button" className="btn btn-sm btn-quiet" onClick={() => setOpen(true)} data-partner-edit>
              {p.termsHistory.length ? 'New terms version' : 'Set terms'}
            </button>
            <SaveStatus save={save} />
          </div>
        )
      ) : null}
    </section>
  )
}

function Payouts({ p, live, onSaved }) {
  const { save, errors, run } = useForm()
  const rev = useSaveState()
  const po = p.payouts
  const [mode, setMode] = useState('items')
  const [picked, setPicked] = useState([])
  const [f, setF] = useState({ amount: '', currency: 'usd', paidOn: today(), methodLabel: '', externalReference: '', periodFrom: '', periodTo: '', note: '' })
  const [reversing, setReversing] = useState('')
  const on = (k) => (e) => setF({ ...f, [k]: e.target.value })
  const scope = `pay-${p.id}`
  const selected = po.unsettled.filter((u) => picked.includes(u.ledgerId))
  const submit = (e) => {
    e.preventDefault()
    run(async () => {
      if (mode === 'items' && !selected.length) return { error: 'unknown_accrual' }
      const base = { action: 'payout', id: p.id, paidOn: f.paidOn, methodLabel: f.methodLabel, externalReference: f.externalReference || null, periodFrom: f.periodFrom || null, periodTo: f.periodTo || null, note: f.note || null }
      const r = await post(mode === 'items' ? { ...base, accrualIds: selected.map((u) => u.ledgerId) } : { ...base, amountCents: Math.round(Number(f.amount) * 100), currency: f.currency.trim().toLowerCase() })
      if (r.error) return r
      setPicked([])
      setF({ ...f, amount: '', externalReference: '', note: '' })
      onSaved()
      return { saved: `Recorded a payout of ${usd(r.payout.amountCents)} ${r.payout.currency.toUpperCase()}. Nothing was sent: this records a payment you made yourself.` }
    })
  }
  const reverse = (id) =>
    rev.run(async () => {
      const r = await post({ action: 'payout_reverse', id: p.id, payoutId: id, confirm: true })
      if (r.error) return { error: FORM_ERRORS[r.error] || 'Something went wrong. Please try again.' }
      setReversing('')
      onSaved()
      return { saved: 'Payout reversed. What it settled is owed again.' }
    })
  return (
    <section className="com-section" aria-label="Payouts" data-partner-payouts>
      <h3 className="com-h">Payouts</h3>
      <p className="row-sub" data-payout-balance>
        {live ? owedText(po.balances) || 'Nothing earned yet.' : 'Live billing isn’t on, so nothing is owed yet. Test-mode commissions are never payable.'}
      </p>
      {live ? (
        <form className="com-edit" onSubmit={submit} noValidate data-payout-form>
          <div className="fchips" role="group" aria-label="What this payout covers">
            <button type="button" className="fchip" aria-pressed={mode === 'items'} onClick={() => setMode('items')} data-payout-mode="items">
              Specific commissions
            </button>
            <button type="button" className="fchip" aria-pressed={mode === 'amount'} onClick={() => setMode('amount')} data-payout-mode="amount">
              An amount on account
            </button>
          </div>
          {mode === 'items' ? (
            po.unsettled.length ? (
              <ul className="com-list" data-unsettled>
                {po.unsettled.map((u) => (
                  <li key={u.ledgerId}>
                    <label className="com-pick">
                      <input type="checkbox" checked={picked.includes(u.ledgerId)} onChange={(e) => setPicked(e.target.checked ? [...picked, u.ledgerId] : picked.filter((x) => x !== u.ledgerId))} data-unsettled-pick={u.ledgerId} />
                      {usd(u.netCents)} {u.currency.toUpperCase()} · {u.customer} · {day(u.at)}
                    </label>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="fine">No unpaid commissions.</p>
            )
          ) : (
            <div className="acq-edit">
              <Field scope={scope} name="amount" label="Amount ($)" errors={errors}>
                <input value={f.amount} onChange={on('amount')} inputMode="decimal" {...inv(scope, errors, 'amount')} data-payout="amount" />
              </Field>
              <Field scope={scope} name="currency" label="Currency" errors={errors}>
                <input value={f.currency} onChange={on('currency')} maxLength={3} {...inv(scope, errors, 'currency')} />
              </Field>
            </div>
          )}
          <div className="acq-edit">
            <Field scope={scope} name="paidOn" label="Paid on" errors={errors}>
              <input type="date" value={f.paidOn} onChange={on('paidOn')} {...inv(scope, errors, 'paidOn')} data-payout="paidOn" />
            </Field>
            <Field scope={scope} name="methodLabel" label="How it was paid" errors={errors}>
              <input value={f.methodLabel} onChange={on('methodLabel')} maxLength={60} placeholder="Bank transfer" {...inv(scope, errors, 'methodLabel')} data-payout="methodLabel" />
            </Field>
            <Field scope={scope} name="externalReference" label="Your reference" errors={errors} optional>
              <input value={f.externalReference} onChange={on('externalReference')} maxLength={120} data-payout="externalReference" />
            </Field>
            <Field scope={scope} name="periodFrom" label="Period from" errors={errors} optional>
              <input type="date" value={f.periodFrom} onChange={on('periodFrom')} />
            </Field>
            <Field scope={scope} name="periodTo" label="Period to" errors={errors} optional>
              <input type="date" value={f.periodTo} onChange={on('periodTo')} {...inv(scope, errors, 'periodTo')} />
            </Field>
          </div>
          <div className="acq-tools">
            <button type="submit" className="btn btn-sm btn-primary" disabled={save.pending} data-payout-save>
              {mode === 'items' && selected.length ? `Record payout of ${usd(selected.reduce((n, u) => n + u.netCents, 0))}` : 'Record payout'}
            </button>
            <SaveStatus save={save} />
          </div>
          <p className="fine">Pay the partner yourself first. This records the payment; GetShowUps never sends money.</p>
        </form>
      ) : null}
      {po.history.length ? (
        <ul className="rows" data-payout-history>
          {po.history.map((h) => (
            <li key={h.id} className="row row--wrap" data-payout={h.id} data-payout-kind={h.kind}>
              <div className="row-main">
                <p className="row-title">
                  {h.kind === 'payout' ? 'Paid' : 'Reversal'} {usd(h.kind === 'payout' ? h.amountCents : -h.amountCents)} {h.currency.toUpperCase()} {h.reversedBy ? <Pill tone="neutral">Reversed</Pill> : null}
                </p>
                <p className="row-sub">
                  {h.kind === 'payout' ? `${day(h.paidOn)} · ${h.methodLabel}${h.externalReference ? ` · ${h.externalReference}` : ''}${h.settles.length ? ` · settles ${plural(h.settles.length, 'commission')}` : ' · on account'}${h.periodFrom ? ` · period ${day(h.periodFrom)} – ${day(h.periodTo ?? h.periodFrom)}` : ''}` : `recorded ${day(h.createdAt)}${h.note ? ` · ${h.note}` : ''}`} · by {h.recordedBy}
                </p>
                {h.kind === 'payout' && !h.reversedBy ? (
                  reversing === h.id ? (
                    <ConfirmInline question={`Reverse this ${usd(h.amountCents)} payout?`} detail="Use this only for a payout recorded by mistake. It stays in the history as reversed, and what it settled is owed again." confirmLabel="Reverse payout" busy={rev.pending} onConfirm={() => reverse(h.id)} onCancel={() => setReversing('')} />
                  ) : (
                    <div className="acq-tools">
                      <button type="button" className="btn btn-sm btn-quiet" onClick={() => setReversing(h.id)} data-payout-reverse>
                        Reverse…
                      </button>
                    </div>
                  )
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      <SaveStatus save={rev} />
    </section>
  )
}

function PartnerRow({ p, ps, onSaved }) {
  const [open, setOpen] = useState(false)
  const [sl, st] = STATUS[p.status] || [p.status, 'neutral']
  const done = Object.values(p.checklist.items).filter(Boolean).length
  return (
    <li className="row row--wrap com-partner" data-partner={p.id} data-status={p.status}>
      <div className="row-main">
        <p className="row-title">
          {p.name} <Pill tone={st}>{sl}</Pill> {p.status !== 'active' && p.status !== 'ended' ? <Pill tone="neutral">{`${done} of 4 onboarding steps`}</Pill> : null}
        </p>
        <p className="row-sub">
          Code <code>{p.code}</code> · {p.contactEmail || 'no contact email'} · added {day(p.createdAt)}
        </p>
        <p className="row-sub" data-partner-owed>
          Commission owed: {ps.live ? totals(p.liability) || usd(0) : 'unavailable while billing is in test mode'}
          {Object.keys(p.testMode || {}).length ? ` · test mode, never owed: ${totals(p.testMode)}` : ''}
        </p>
        <div className="acq-tools">
          <Copy text={p.link} />
          <button type="button" className="btn btn-sm btn-quiet" onClick={() => setOpen((v) => !v)} aria-expanded={open} data-partner-open>
            {open ? 'Close' : 'Manage'}
          </button>
        </div>
        {open ? (
          <div className="com-panel">
            <Onboarding p={p} onSaved={onSaved} />
            <Details p={p} onSaved={onSaved} />
            <Acceptance p={p} agreements={ps.agreements} onSaved={onSaved} />
            <Terms p={p} onSaved={onSaved} />
            <Payouts p={p} live={ps.live} onSaved={onSaved} />
            <section className="com-section" aria-label="Referred businesses">
              <h3 className="com-h">Referred businesses</h3>
              <p className="row-sub">{p.referred.length ? p.referred.map((x) => `${x.name}${x.testBusiness ? ' (test)' : ''}${x.commissionEndedAt ? ' (subscription ended)' : ''}`).join(', ') : 'None yet.'}</p>
            </section>
          </div>
        ) : null}
      </div>
    </li>
  )
}

export function Partners() {
  const [r, load, reset] = useCommercial()
  if (r === undefined) return <Loading what="partners" />
  if (r === null)
    return (
      <LoadError
        what="partners"
        onRetry={() => {
          reset()
          load()
        }}
      />
    )
  const ps = r.partners
  const on = r.pipeline.referralsEnabled
  return (
    <section className="card com" aria-label="Referral partners" data-com-partners>
      <p className="fine" data-referrals={on ? 'on' : 'off'}>
        {on ? 'The referral program is on: commissions accrue from collected payments for active partners.' : 'The referral program is off: you can prepare partners, agreements and links; no commission accrues.'} Partners have no sign-in and see nothing. Payouts are recorded here after you pay; nothing is paid from here.
      </p>
      {!ps.ready ? (
        <p className="fine">Partners will be available after the next database update.</p>
      ) : (
        <>
          <Agreements ps={ps} onSaved={load} />
          <NewPartner onSaved={load} />
          <h2 className="card-title">Partners</h2>
          {ps.partners.length === 0 ? (
            <EmptyState title="No partners yet">Add a partner above to get a referral link to share with them.</EmptyState>
          ) : (
            <ul className="rows" data-partner-list>
              {ps.partners.map((p) => (
                <PartnerRow key={p.id} p={p} ps={ps} onSaved={load} />
              ))}
            </ul>
          )}
          <h2 className="card-title">Commission ledger</h2>
          {ps.ledger.length === 0 ? (
            <p className="fine">No commission recorded yet. Entries appear when a referred business pays, and reversals when a payment is refunded or disputed.</p>
          ) : (
            <ul className="rows" data-ledger>
              {ps.ledger.map((e) => (
                <li key={e.id} className="row" data-ledger-entry={e.kind}>
                  <div className="row-main">
                    <p className="row-title">
                      {e.kind === 'accrual' ? 'Accrued' : 'Reversed'} · {ps.partners.find((p) => p.id === e.partnerId)?.name || 'Partner'} {e.livemode ? null : <Pill tone="warn">Test mode</Pill>}
                    </p>
                    <p className="row-sub">
                      {e.customer} · {day(e.at)} · from {usd(e.basisCents)} collected{e.rule?.version ? ` · terms version ${e.rule.version}` : ''}
                    </p>
                  </div>
                  <strong className="growth-value">{usd(e.amountCents)}</strong>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  )
}
