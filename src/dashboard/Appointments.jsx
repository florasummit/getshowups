// Appointments: who to mark, what's coming up, past results (always correctable), and people who
// haven't booked yet. Test bookings are tagged and never counted.
import { useState } from 'react'
import { api, fmt } from '../lib/api.js'

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
              · <a href={`tel:${a.phone}`}>{a.phone}</a>
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

function ReportedValue({ a, onDone }) {
  const [editing, setEditing] = useState(false)
  const [amount, setAmount] = useState(a.valueCents != null ? String(a.valueCents / 100) : '')
  const [error, setError] = useState('')
  const save = async (e) => {
    e.preventDefault()
    const cents = amount.trim() === '' ? null : Math.round(Number(amount) * 100)
    if (cents !== null && (!Number.isFinite(cents) || cents < 0)) return setError('Enter an amount like 250')
    const { status } = await record({ id: a.id, outcome: 'showed', work: a.work ?? undefined, valueCents: cents })
    if (status === 200) {
      setEditing(false)
      onDone()
    } else setError('Couldn’t save. Try again.')
  }
  if (!editing)
    return (
      <button type="button" className="link-btn" onClick={() => setEditing(true)}>
        {a.valueCents != null ? money(a.valueCents) : 'Add job value'}
      </button>
    )
  return (
    <form className="value-form" onSubmit={save}>
      <input aria-label="Job value in dollars" inputMode="decimal" placeholder="$" value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus />
      <button className="btn btn-sm btn-primary">Save</button>
      {error && <span className="fine">{error}</span>}
    </form>
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
              <Appointment key={a.id} a={a} tz={tz} />
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
                    {l.status === 'unqualified' && <span className="tag">Outside service area</span>}
                  </p>
                  <p className="row-sub">
                    <a href={`tel:${l.phone}`}>{l.phone}</a> · <a href={`mailto:${l.email}`}>{l.email}</a>
                  </p>
                  {l.address && <p className="row-sub">{l.address}</p>}
                  <p className="row-note">{l.need}</p>
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
