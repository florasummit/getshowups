// Appointments: who to mark, what's coming up, past results (always correctable), and people who
// haven't booked yet. Test bookings are tagged and never counted.
import { useState } from 'react'
import { api, fmt, phoneText } from '../lib/api.js'

const when = (iso, tz) => fmt(iso, tz, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
const money = (cents) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: cents % 100 ? 2 : 0 }).format(cents / 100)
const record = (body) => api('/api/dashboard/outcome', { method: 'POST', body })

export function Appointment({ a, tz, children, compact }) {
  return (
    <li className="row">
      <div className="row-main">
        <p className="row-title">
          {a.name}
          {a.test && <span className="tag">Test</span>}
          {a.status === 'booked' && a.confirmed && <span className="tag tag--ok">Confirmed</span>}
        </p>
        <p className="row-sub">
          {when(a.start, tz)}
          {!compact && (
            <>
              {' '}
              · <a href={`tel:${a.phone}`}>{phoneText(a.phone)}</a>
            </>
          )}
        </p>
        {!compact && a.address && <p className="row-sub">{a.address}</p>}
        {!compact && <p className="row-note">{a.need}</p>}
      </div>
      {children}
    </li>
  )
}

const choicesFor = (visit) =>
  visit
    ? [
        ['Couldn’t visit', { outcome: 'no_show' }],
        ['Visited, not done', { outcome: 'showed', work: 'not_completed' }],
        ['Job done', { outcome: 'showed', work: 'completed' }],
      ]
    : [
        ['No-show', { outcome: 'no_show' }],
        ['Showed up', { outcome: 'showed' }],
      ]

function resultLabel(a, visit) {
  if (a.status === 'no_show') return [visit ? 'Couldn’t visit' : 'No-show', 'tag--bad']
  if (!visit) return ['Showed up', 'tag--ok']
  if (a.work === 'completed') return ['Job done', 'tag--ok']
  if (a.work === 'not_completed') return ['Visited, not done', '']
  return ['Visited', '']
}

// Buttons to record (or change) what happened. Every choice can be changed again later.
function OutcomeButtons({ a, visit, onDone, current, onCancel }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const mark = async (body) => {
    setBusy(true)
    const { status } = await record({ id: a.id, ...body })
    setBusy(false)
    if (status === 200) onDone(body)
    else setError('Couldn’t save. Try again.')
  }
  const isCurrent = (body) => current && body.outcome === current.status && (body.work ?? null) === (current.work ?? null)
  return (
    <div className="row-actions">
      {choicesFor(visit).map(([label, body], i, list) => (
        <button key={label} type="button" className={`btn btn-sm ${i === list.length - 1 ? 'btn-primary' : 'btn-quiet'}`} disabled={busy || isCurrent(body)} onClick={() => mark(body)}>
          {label}
        </button>
      ))}
      {current && (
        <button type="button" className="link-btn" disabled={busy} onClick={() => mark({ outcome: 'clear' })}>
          Not sure yet
        </button>
      )}
      {onCancel && (
        <button type="button" className="link-btn" onClick={onCancel}>
          Cancel
        </button>
      )}
      {error && <span className="fine">{error}</span>}
    </div>
  )
}

// One amount, edited in place. Empty clears it. onSave(cents|null) → status code.
function Amount({ label, cents, empty, onSave }) {
  const [editing, setEditing] = useState(false)
  const [amount, setAmount] = useState(cents != null ? String(cents / 100) : '')
  const [error, setError] = useState('')
  const save = async (e) => {
    e.preventDefault()
    const next = amount.trim() === '' ? null : Math.round(Number(amount.replace(/[$,\s]/g, '')) * 100)
    if (next !== null && (!Number.isFinite(next) || next < 0)) return setError('Enter an amount like 250')
    const status = await onSave(next)
    if (status === 200) {
      setEditing(false)
      setError('')
    } else setError('Couldn’t save. Try again.')
  }
  if (!editing)
    return (
      <button type="button" className="link-btn money-item" onClick={() => setEditing(true)}>
        <span className="money-label">{label}</span> {cents != null ? money(cents) : empty}
      </button>
    )
  return (
    <form className="value-form" onSubmit={save}>
      <input aria-label={`${label} in dollars`} inputMode="decimal" placeholder="$" value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus />
      <button className="btn btn-sm btn-primary">Save</button>
      <button type="button" className="link-btn" onClick={() => setEditing(false)}>
        Cancel
      </button>
      {error && <span className="fine">{error}</span>}
    </form>
  )
}

// Money for a visit that happened, kept apart: what the job is worth (estimate) vs. what was billed vs. what was paid.
// Invoiced/paid appear once recording them is available (server/revenue.js); an estimate is never shown as paid.
function ReportedValue({ a, onDone }) {
  const revenue = async (kind, cents) => (await api('/api/dashboard/revenue', { method: 'POST', body: { appointmentId: a.id, kind, amountCents: cents } })).status
  const done = (status) => (status === 200 && onDone(), status)
  return (
    <span className="money-line" role="group" aria-label="Job money">
      <Amount label="Estimated" cents={a.valueCents} empty="add" onSave={async (c) => done((await record({ id: a.id, outcome: 'showed', work: a.work ?? undefined, valueCents: c })).status)} />
      {a.invoicedCents !== undefined && <Amount label="Invoiced" cents={a.invoicedCents} empty="add" onSave={async (c) => done(await revenue('invoiced', c))} />}
      {a.paidCents !== undefined && <Amount label="Paid" cents={a.paidCents} empty="add" onSave={async (c) => done(await revenue('paid', c))} />}
    </span>
  )
}

function TestToggle({ item, onDone }) {
  const [busy, setBusy] = useState(false)
  const toggle = async () => {
    setBusy(true)
    await api('/api/dashboard/test-mark', { method: 'POST', body: { leadId: item.leadId, isTest: !item.test } })
    setBusy(false)
    onDone()
  }
  return (
    <button type="button" className="link-btn link-btn--quiet" disabled={busy} onClick={toggle}>
      {item.test ? 'Not a test' : 'Mark as test'}
    </button>
  )
}

// A service-area request: the lead is outside the listed ZIPs (or the ZIP couldn't be verified). The owner answers;
// approving lets the SAME lead book (they're sent their link; the owner can copy it too). Never changes the ZIP list.
function CoverageAnswer({ l, onDone }) {
  const [state, setState] = useState({})
  const c = l.coverage
  const decide = async (decision) => {
    setState({ busy: decision })
    const { status, data } = await api('/api/dashboard/coverage', { method: 'POST', body: { leadId: l.leadId, decision } })
    if (status !== 200) return setState({ error: 'Couldn’t save that. Please try again.' })
    setState({ link: data.bookingUrl })
    if (!data.unchanged) onDone()
  }
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(state.link)
      setState((s) => ({ ...s, copied: true }))
    } catch {
      setState((s) => ({ ...s, copied: false }))
    }
  }
  const where = c.check === 'outside' ? `ZIP ${c.zip} isn’t on your service list.` : c.zip ? `We couldn’t verify ZIP ${c.zip}.` : 'They didn’t give a valid ZIP.'
  return (
    <div className="coverage" role="group" aria-label="Service area request">
      {c.status === 'pending' && (
        <>
          <p className="coverage-q">
            {where} Can you serve them?
          </p>
          <div className="coverage-actions">
            <button type="button" className="btn btn-primary btn-sm" disabled={Boolean(state.busy)} onClick={() => decide('approve')}>
              We serve this area
            </button>
            <button type="button" className="btn btn-quiet btn-sm" disabled={Boolean(state.busy)} onClick={() => decide('decline')}>
              We can’t serve this area
            </button>
          </div>
          <p className="fine">Your service ZIP list doesn’t change. Change it in Settings if you want to serve this ZIP for everyone.</p>
        </>
      )}
      {c.status === 'approved' && (
        <p className="coverage-q">
          You said you serve this area. They can now pick a time with their own booking link, which is emailed to them when your automatic messages are on.
        </p>
      )}
      {c.status === 'approved' && !state.link && (
        <div className="coverage-actions">
          <button type="button" className="btn btn-quiet btn-sm" disabled={Boolean(state.busy)} onClick={() => decide('approve')}>
            Show their booking link
          </button>
        </div>
      )}
      {c.status === 'declined' && (
        <>
          <p className="coverage-q">You said you can’t serve this area. They can’t book; you can still contact them.</p>
          <div className="coverage-actions">
            <button type="button" className="btn btn-quiet btn-sm" disabled={Boolean(state.busy)} onClick={() => decide('approve')}>
              Changed your mind? We serve this area
            </button>
          </div>
        </>
      )}
      {state.link && (
        <div className="coverage-link">
          <input readOnly value={state.link} aria-label="Their booking link" onFocus={(e) => e.target.select()} />
          <button type="button" className="btn btn-quiet btn-sm" onClick={copy}>
            {state.copied ? 'Copied' : 'Copy link'}
          </button>
        </div>
      )}
      {state.error && (
        <p className="form-error" role="alert">
          {state.error}
        </p>
      )}
    </div>
  )
}

// A past appointment's result, with "Change" to correct it.
function PastResult({ a, tz, visit, onDone }) {
  const [changing, setChanging] = useState(false)
  const [label, tone] = resultLabel(a, visit)
  return (
    <Appointment a={a} tz={tz}>
      {changing ? (
        <OutcomeButtons a={a} visit={visit} current={a} onCancel={() => setChanging(false)} onDone={() => {
            setChanging(false)
            onDone()
          }} />
      ) : (
        <div className="result">
          <span className={`tag ${tone}`}>{label}</span>
          <button type="button" className="link-btn" onClick={() => setChanging(true)}>
            Change
          </button>
          {a.status === 'showed' && <ReportedValue a={a} onDone={onDone} />}
          <TestToggle item={a} onDone={onDone} />
        </div>
      )}
    </Appointment>
  )
}

// "Did they show up?" with an Undo right after marking, for accidental taps.
function NeedsOutcome({ a, tz, visit, onDone, simple }) {
  const [marked, setMarked] = useState(null)
  if (marked) {
    return (
      <Appointment a={a} tz={tz} compact>
        <div className="result">
          <span className="fine">Saved.</span>
          <button
            type="button"
            className="link-btn"
            onClick={async () => {
              await record({ id: a.id, outcome: 'clear' })
              setMarked(null)
            }}
          >
            Undo
          </button>
          <button type="button" className="link-btn" onClick={onDone}>
            Done
          </button>
        </div>
      </Appointment>
    )
  }
  return (
    <Appointment a={a} tz={tz}>
      <OutcomeButtons a={a} visit={visit} onDone={(body) => setMarked(body)} />
      {!simple && <TestToggle item={a} onDone={onDone} />}
    </Appointment>
  )
}

export function OutcomeList({ items, tz, visit, onDone, simple = false }) {
  return (
    <ul className="rows">
      {items.map((a) => (
        <NeedsOutcome key={a.id} a={a} tz={tz} visit={visit} onDone={onDone} simple={simple} />
      ))}
    </ul>
  )
}

// An upcoming appointment the owner can cancel (Google tells the customer; reminders stop).
const CANCEL_ERRORS = { calendar_unavailable: 'Couldn’t reach Google Calendar. Nothing was changed; please try again.', calendar_access: 'Reconnect Google Calendar in Settings, then try again.', not_cancellable: 'This appointment can no longer be cancelled.', cancel_incomplete: 'It was removed from Google Calendar but not saved here. Press Cancel again to finish.' }
function Upcoming({ a, tz, onDone }) {
  const [state, setState] = useState({})
  const cancel = async () => {
    setState({ busy: true })
    const { status, data } = await api('/api/dashboard/appointment-cancel', { method: 'POST', body: { id: a.id, confirm: true } })
    if (status === 200) return onDone()
    setState({ error: CANCEL_ERRORS[data.error] || 'Couldn’t cancel. Please try again.' })
  }
  return (
    <Appointment a={a} tz={tz}>
      <div className="row-actions" data-cancel={a.id}>
        {state.confirm ? (
          <>
            <button type="button" className="btn btn-sm btn-quiet" disabled={state.busy} onClick={() => setState({})}>
              Keep
            </button>
            <button type="button" className="btn btn-sm btn-danger" disabled={state.busy} onClick={cancel}>
              Confirm: cancel
            </button>
          </>
        ) : (
          <button type="button" className="link-btn" onClick={() => setState({ confirm: true })}>
            Cancel…
          </button>
        )}
        {state.confirm && !state.error && <p className="fine">Removes it from your Google Calendar; Google lets the customer know.</p>}
        {state.error && (
          <p className="form-error" role="alert">
            {state.error}
          </p>
        )}
      </div>
    </Appointment>
  )
}

export default function Appointments({ me, data, reload }) {
  const tz = me.customer.timezone
  const visit = me.customer.appointmentMode === 'at_customer'
  if (!data) return <div aria-busy="true" />
  return (
    <div className="enter">
      <h1 className="title title--page">Appointments</h1>
      {data.needsOutcome.length > 0 && (
        <section className="card">
          <h2 className="card-title">{visit ? 'How did these visits go?' : 'Did they show up?'}</h2>
          <OutcomeList items={data.needsOutcome} tz={tz} visit={visit} onDone={reload} />
        </section>
      )}
      <section className="card">
        <h2 className="card-title">Upcoming</h2>
        {data.upcoming.length ? (
          <ul className="rows">
            {data.upcoming.map((a) => (
              <Upcoming key={a.id} a={a} tz={tz} onDone={reload} />
            ))}
          </ul>
        ) : (
          <p className="empty">Nothing booked yet. Share your website or booking link to get your next {visit ? 'visit' : 'appointment'}.</p>
        )}
      </section>
      {data.recent.length > 0 && (
        <section className="card">
          <h2 className="card-title">Past</h2>
          <p className="fine">Marked something by mistake? Use “Change”. Every change is saved.</p>
          <ul className="rows">
            {data.recent.map((a) => (
              <PastResult key={a.id} a={a} tz={tz} visit={visit} onDone={reload} />
            ))}
          </ul>
        </section>
      )}
      {data.followUp.length > 0 && (
        <section className="card">
          <h2 className="card-title">Haven’t booked yet</h2>
          <ul className="rows">
            {data.followUp.map((l) => (
              <li key={l.id} className="row">
                <div className="row-main">
                  <p className="row-title">
                    {l.name}
                    {l.test && <span className="tag">Test</span>}
                    {l.coverage?.status === 'pending' && <span className="tag tag--warn">Coverage review needed</span>}
                    {l.coverage?.status === 'approved' && <span className="tag tag--ok">Area approved</span>}
                    {l.coverage?.status === 'declined' && <span className="tag">Area declined</span>}
                    {!l.coverage && l.status === 'unqualified' && <span className="tag">Outside service area</span>}
                  </p>
                  <p className="row-sub">
                    <a href={`tel:${l.phone}`}>{phoneText(l.phone)}</a> · <a href={`mailto:${l.email}`}>{l.email}</a>
                  </p>
                  {l.address && <p className="row-sub">{l.address}</p>}
                  <p className="row-note">{l.need}</p>
                  {l.coverage && <CoverageAnswer l={l} onDone={reload} />}
                </div>
                <TestToggle item={l} onDone={reload} />
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
