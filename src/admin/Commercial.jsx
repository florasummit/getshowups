// Admin → Growth → Pipeline | Partners (GET /api/platform/commercial; writes: POST /api/platform/partners, audited).
// Pipeline: every real business with its channel, source, partner or closing rep, payment, setup and invitation state,
// and totals by channel and rep. Collected revenue, commission owed, cost per customer and retention exist only in live
// billing; in test mode they read "Unavailable" with the reason, never 0. Test businesses are left out (count shown).
// Partners: GetShowUps' own partner records. A partner has no login and sees nothing. Terms are typed field by field with
// no defaults; nothing is paid from here, and nothing accrues while the referral program is off.
import { useEffect, useMemo, useState } from 'react'
import { api } from '../lib/api.js'
import { EmptyState, LoadError, Loading, Pill, SaveStatus } from '../dashboard/ui.jsx'
import { useSaveState } from '../dashboard/ui-hooks.js'
import { humanDate, money, plural } from '../lib/format.js'

const CHANNEL = { self_serve: 'Self-serve', founder: 'Founder', sales_rep: 'Sales rep', partner: 'Partner', unrecorded: 'Not recorded' }
const PAYMENT = { confirmed: ['Paid', 'ok'], test: ['Test mode', 'warn'], pending: ['Payment pending', 'warn'], ended: ['Ended', 'neutral'], not_billed: ['Not billed', 'neutral'] }
const SETUP = { live: ['Set up', 'ok'], invited: ['Waiting for owner', 'warn'], calendar: ['Setting up', 'info'], hours: ['Setting up', 'info'], suspended: ['Suspended', 'bad'] }
const INVITE = { claimed: ['Claimed', 'ok'], pending: ['Invitation pending', 'warn'], none: ['No owner yet', 'neutral'] }
const REFUSAL = { unknown_code: 'unknown code', paused: 'partner paused', self_referral: 'self-referral refused', outside_window: 'outside the partner’s window' }
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
const TERM_ERRORS = {
  invalid_terms_type: ['type', 'Choose a percentage or a fixed amount.'],
  invalid_terms_value: ['value', 'Enter a percentage above 0 and up to 100 (two decimals at most), or a whole fixed amount in dollars.'],
  invalid_terms_currency: ['currency', 'Enter the three-letter currency, for example usd.'],
  invalid_terms_recurring: ['recurring', 'Choose how long the commission runs (1 to 120 months for a set period).'],
  invalid_terms_window: ['windowDays', 'Enter the attribution window in whole days, from 1 to 3650.'],
  invalid_name: ['name', 'Enter the partner’s name (up to 80 characters).'],
  invalid_email: ['contactEmail', 'Enter a valid email address, or leave it empty.'],
}
const EMPTY_TERMS = { type: '', value: '', currency: '', recurring: '', months: '', windowDays: '' }
const termsBody = (t) => ({
  type: t.type,
  value: t.type === 'fixed' ? Math.round(Number(t.value) * 100) : Number(t.value),
  ...(t.type === 'fixed' ? { currency: t.currency.trim().toLowerCase() } : {}),
  recurring: t.recurring === 'months' ? `months:${t.months}` : t.recurring,
  windowDays: Number(t.windowDays),
})
const anyTerms = (t) => Object.values(t).some((v) => String(v).trim() !== '')
function termsText(t) {
  if (!t) return 'No terms yet: nothing accrues.'
  const amount = t.type === 'percent' ? `${t.value}% of each collected payment (tax excluded)` : `${usd(t.value)} ${t.currency.toUpperCase()} per collected payment (at most the payment)`
  const run = t.recurring === 'once' ? 'first payment only' : t.recurring === 'lifetime' ? 'every payment while subscribed' : `payments in the first ${plural(Number(t.recurring.split(':')[1]), 'month')}`
  return `${amount}, ${run}; referral counts if the business is created within ${plural(t.windowDays, 'day')} of the first visit.`
}

function Field({ name, label, errors, children, optional = false }) {
  return (
    <label className="field">
      <span>
        {label} {optional ? <em>optional</em> : null}
      </span>
      {children}
      {errors[name] ? (
        <span className="field-error" id={`err-${name}`}>
          {errors[name]}
        </span>
      ) : null}
    </label>
  )
}
const inv = (errors, name) => (errors[name] ? { 'aria-invalid': true, 'aria-describedby': `err-${name}` } : {})

function TermsFields({ t, set, errors }) {
  const on = (k) => (e) => set({ ...t, [k]: e.target.value })
  return (
    <div className="acq-edit com-terms">
      <Field name="type" label="Commission" errors={errors}>
        <select value={t.type} onChange={on('type')} {...inv(errors, 'type')} data-terms="type">
          <option value="">Choose…</option>
          <option value="percent">Percentage of collected payments</option>
          <option value="fixed">Fixed amount per collected payment</option>
        </select>
      </Field>
      <Field name="value" label={t.type === 'fixed' ? 'Amount ($)' : 'Percentage (%)'} errors={errors}>
        <input value={t.value} onChange={on('value')} inputMode="decimal" {...inv(errors, 'value')} data-terms="value" />
      </Field>
      {t.type === 'fixed' ? (
        <Field name="currency" label="Currency" errors={errors}>
          <input value={t.currency} onChange={on('currency')} maxLength={3} placeholder="usd" autoCapitalize="none" {...inv(errors, 'currency')} data-terms="currency" />
        </Field>
      ) : null}
      <Field name="recurring" label="Runs for" errors={errors}>
        <select value={t.recurring} onChange={on('recurring')} {...inv(errors, 'recurring')} data-terms="recurring">
          <option value="">Choose…</option>
          <option value="once">First payment only</option>
          <option value="months">A set number of months</option>
          <option value="lifetime">Every payment while subscribed</option>
        </select>
      </Field>
      {t.recurring === 'months' ? (
        <Field name="recurring" label="Months" errors={{}}>
          <input value={t.months} onChange={on('months')} inputMode="numeric" data-terms="months" />
        </Field>
      ) : null}
      <Field name="windowDays" label="Attribution window (days)" errors={errors}>
        <input value={t.windowDays} onChange={on('windowDays')} inputMode="numeric" {...inv(errors, 'windowDays')} data-terms="windowDays" />
      </Field>
    </div>
  )
}

async function post(body) {
  const { status, data } = await api('/api/platform/partners', { method: 'POST', body })
  return status === 200 ? data : { error: data?.error || 'storage_error' }
}
const failure = (error, setErrors) => {
  const known = TERM_ERRORS[error]
  if (known) {
    setErrors({ [known[0]]: known[1] })
    return { error: 'Check the highlighted field.' }
  }
  return { error: error === 'not_ready' ? 'Partners can’t be saved until the database is updated.' : 'Something went wrong. Please try again.' }
}

function NewPartner({ onSaved }) {
  const save = useSaveState()
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [t, setT] = useState(EMPTY_TERMS)
  const [errors, setErrors] = useState({})
  const submit = (e) => {
    e.preventDefault()
    setErrors({})
    save.run(async () => {
      if (!name.trim()) return failure('invalid_name', setErrors)
      const r = await post({ action: 'create', name, contactEmail: email.trim() || null, terms: anyTerms(t) ? termsBody(t) : null })
      if (r.error) return failure(r.error, setErrors)
      setName('')
      setEmail('')
      setT(EMPTY_TERMS)
      onSaved()
      return { saved: `Added ${r.partner.name}. Its link is in the list below.` }
    })
  }
  return (
    <form className="com-new" onSubmit={submit} noValidate data-com-new>
      <h2 className="card-title">Add a partner</h2>
      <div className="acq-edit">
        <Field name="name" label="Name" errors={errors}>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} {...inv(errors, 'name')} data-partner-name />
        </Field>
        <Field name="contactEmail" label="Contact email" errors={errors} optional>
          <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" autoComplete="off" {...inv(errors, 'contactEmail')} data-partner-email />
        </Field>
      </div>
      <p className="fine">Commission terms (optional now; nothing accrues until they are set). No value is filled in for you.</p>
      <TermsFields t={t} set={setT} errors={errors} />
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

function PartnerRow({ p, live, onSaved }) {
  const save = useSaveState()
  const [editing, setEditing] = useState(false)
  const [t, setT] = useState(EMPTY_TERMS)
  const [errors, setErrors] = useState({})
  const toggle = () =>
    save.run(async () => {
      const r = await post({ action: p.status === 'active' ? 'pause' : 'resume', id: p.id })
      if (r.error) return failure(r.error, setErrors)
      onSaved()
      return { saved: p.status === 'active' ? `Paused ${p.name}: new referrals and commissions stop.` : `Resumed ${p.name}.` }
    })
  const saveTerms = (e) => {
    e.preventDefault()
    setErrors({})
    save.run(async () => {
      const r = await post({ action: 'terms', id: p.id, terms: termsBody(t) })
      if (r.error) return failure(r.error, setErrors)
      setEditing(false)
      onSaved()
      return { saved: `Terms saved for ${p.name}. They apply to payments from now on.` }
    })
  }
  return (
    <li className="row row--wrap com-partner" data-partner={p.id}>
      <div className="row-main">
        <p className="row-title">
          {p.name} <Pill tone={p.status === 'active' ? 'ok' : 'neutral'}>{p.status === 'active' ? 'Active' : 'Paused'}</Pill>
        </p>
        <p className="row-sub">
          Code <code>{p.code}</code> · {p.contactEmail || 'no contact email'} · added {day(p.createdAt)}
        </p>
        <p className="row-sub" data-partner-terms>
          {termsText(p.terms)}
        </p>
        <p className="row-sub" data-partner-owed>
          Commission owed: {live ? totals(p.liability) || usd(0) : 'unavailable while billing is in test mode'}
          {Object.keys(p.testMode || {}).length ? ` · test mode, never owed: ${totals(p.testMode)}` : ''}
        </p>
        <p className="row-sub">
          {p.referred.length ? `Referred: ${p.referred.map((x) => `${x.name}${x.testBusiness ? ' (test)' : ''}${x.commissionEndedAt ? ' (subscription ended)' : ''}`).join(', ')}` : 'No referred businesses yet.'}
        </p>
        <div className="acq-tools">
          <Copy text={p.link} />
          <button type="button" className="btn btn-sm btn-quiet" onClick={toggle} disabled={save.pending} data-partner-toggle>
            {p.status === 'active' ? 'Pause' : 'Resume'}
          </button>
          <button type="button" className="btn btn-sm btn-quiet" onClick={() => setEditing((v) => !v)} aria-expanded={editing} data-partner-edit>
            {p.terms ? 'Change terms' : 'Set terms'}
          </button>
          <SaveStatus save={save} />
        </div>
        {editing ? (
          <form onSubmit={saveTerms} noValidate className="com-edit">
            <TermsFields t={t} set={setT} errors={errors} />
            <button type="submit" className="btn btn-sm btn-primary" disabled={save.pending} data-terms-save>
              Save terms
            </button>
          </form>
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
        {on ? 'The referral program is on: commissions accrue from collected payments.' : 'The referral program is off: you can prepare partners and links; no commission accrues.'} Partners have no sign-in and see nothing. Nothing is paid out from here.
      </p>
      {!ps.ready ? (
        <p className="fine">Partners will be available after the next database update.</p>
      ) : (
        <>
          <NewPartner onSaved={load} />
          <h2 className="card-title">Partners</h2>
          {ps.partners.length === 0 ? (
            <EmptyState title="No partners yet">Add a partner above to get a referral link to share with them.</EmptyState>
          ) : (
            <ul className="rows" data-partner-list>
              {ps.partners.map((p) => (
                <PartnerRow key={p.id} p={p} live={ps.live} onSaved={load} />
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
                      {e.customer} · {day(e.at)} · from {usd(e.basisCents)} collected
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
