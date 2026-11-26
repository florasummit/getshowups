// Appointments: who to mark, what's coming up, past results (always correctable), and people who
// haven't booked yet. Test bookings are tagged and never counted.
import { useEffect, useState } from 'react'
import { ConfirmInline, LoadError } from './ui.jsx'
import { api, fmt, phoneText } from '../lib/api.js'
import { plural } from '../lib/format.js'
import { plainPrice } from './owner-lib.js'

const when = (iso, tz) => fmt(iso, tz, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
const money = (cents) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: cents % 100 ? 2 : 0 }).format(cents / 100)
const record = (body) => api('/api/dashboard/outcome', { method: 'POST', body })

// The services list (Settings → Services), read once per page for the suggestion; a failed read just means no suggestion.
let servicesRead = null
const readServices = () => (servicesRead ??= api('/api/dashboard/profile').then(({ status, data }) => (status === 200 ? data.profile?.services || [] : [])))
if (typeof window !== 'undefined') window.addEventListener('gsu:profile', () => (servicesRead = null))
function useServices() {
  const [list, setList] = useState([])
  useEffect(() => {
    let live = true
    readServices().then((x) => live && setList(x))
    return () => {
      live = false
    }
  }, [])
  return list
}
const listedPrice = (services, need) => {
  const want = String(need ?? '').trim().toLowerCase()
  const hit = want && services.find((x) => String(x.name).trim().toLowerCase() === want)
  return hit ? plainPrice(hit.price) : null
}
// An estimate the owner entered stays with its visit while the page is open: undoing an outcome, or changing it, and then
// choosing the same one again puts the amount back instead of losing it (the server clears it with the outcome).
const keptEstimate = new Map()

// `wrap`: what sits beside the details may drop to its own full-width line (a confirmation, the amount step).
export function Appointment({ a, tz, children, compact, wrap }) {
  return (
    <li className={wrap ? 'row row--wrap' : 'row'}>
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
  const mark = async (choice) => {
    setBusy(true)
    // What this visit was worth goes with it again (see keptEstimate); "not sure yet" remembers it for the next choice.
    if (a.valueCents != null) keptEstimate.set(a.id, a.valueCents)
    const worth = choice.outcome === 'showed' ? keptEstimate.get(a.id) : undefined
    const body = worth != null ? { ...choice, valueCents: worth } : choice
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
          Don’t change
        </button>
      )}
      {error && (
        <span className="fine" role="alert">
          {error}
        </span>
      )}
    </div>
  )
}

// Asked in the same step as "it happened": what the visit was worth. Prefilled from the service's listed price when that
// is a plain amount, or from what was entered before; editable; nothing is saved until "Save amount", and "Done" skips it.
function WorthStep({ a, marked, suggested, onSaved }) {
  const start = marked.valueCents ?? suggested
  const [amount, setAmount] = useState(start != null ? String(start / 100) : '')
  const [state, setState] = useState(marked.valueCents != null ? { saved: marked.valueCents } : {})
  const save = async (e) => {
    e.preventDefault()
    const cents = amount.trim() === '' ? null : Math.round(Number(amount.replace(/[$,\s]/g, '')) * 100)
    if (cents !== null && (!Number.isFinite(cents) || cents < 0)) return setState({ error: 'Enter an amount like 250' })
    setState({ busy: true })
    const { status } = await record({ id: a.id, outcome: 'showed', work: marked.work, valueCents: cents })
    if (status !== 200) return setState({ error: 'Couldn’t save the amount. Try again.' })
    if (cents == null) keptEstimate.delete(a.id)
    else keptEstimate.set(a.id, cents)
    setState({ saved: cents })
    onSaved(cents)
  }
  return (
    <form className="worth-step" onSubmit={save} data-worth>
      <label>
        <span>What was it worth? Your estimate, optional</span>
        <span className="worth-step-row">
          <input aria-label="Estimated value in dollars" inputMode="decimal" placeholder="$" value={amount} onChange={(e) => {
              setAmount(e.target.value)
              setState({})
            }}
          />
          <button className="btn btn-sm btn-quiet" disabled={state.busy}>
            Save amount
          </button>
        </span>
      </label>
      {state.saved != null && (
        <span className="fine" role="status">
          Estimate saved: {money(state.saved)}.
        </span>
      )}
      {state.saved == null && start != null && marked.valueCents == null && !state.error && <span className="fine">From this service’s listed price. Change it or leave it out.</span>}
      {state.error && (
        <span className="fine" role="alert">
          {state.error}
        </span>
      )}
    </form>
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
      <button type="button" className="money-item" onClick={() => setEditing(true)} title={`${cents != null ? 'Change' : 'Add'} the ${label.toLowerCase()} amount`}>
        <span className="money-label">{label}</span>{' '}
        {cents != null ? (
          money(cents)
        ) : (
          <>
            <span aria-hidden="true">+ </span>
            {empty}
          </>
        )}
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
      <Amount
        label="Estimated"
        cents={a.valueCents}
        empty="add"
        onSave={async (c) => {
          const { status } = await record({ id: a.id, outcome: 'showed', work: a.work ?? undefined, valueCents: c })
          if (status === 200 && c == null) keptEstimate.delete(a.id)
          else if (status === 200) keptEstimate.set(a.id, c)
          return done(status)
        }}
      />
      {a.invoicedCents !== undefined && <Amount label="Invoiced" cents={a.invoicedCents} empty="add" onSave={async (c) => done(await revenue('invoiced', c))} />}
      {a.paidCents !== undefined && <Amount label="Paid" cents={a.paidCents} empty="add" onSave={async (c) => done(await revenue('paid', c))} />}
    </span>
  )
}

// "Mark as test" changes what is counted, so it says what it does and asks first; taking the mark off is one press.
function TestToggle({ item, onDone }) {
  const [busy, setBusy] = useState(false)
  const [asking, setAsking] = useState(false)
  const [error, setError] = useState(false)
  const toggle = async () => {
    setBusy(true)
    const { status } = await api('/api/dashboard/test-mark', { method: 'POST', body: { leadId: item.leadId, isTest: !item.test } })
    setBusy(false)
    setAsking(false)
    setError(status !== 200)
    if (status === 200) onDone()
  }
  if (asking)
    return (
      <div className="row-confirm">
        <ConfirmInline
          question={`Mark ${item.name} as a test?`}
          detail="For a booking you made yourself to try things out. It stays listed with a Test tag and is left out of your numbers. You can take the mark off again."
          confirmLabel="Mark as test"
          cancelLabel="Don’t mark"
          danger={false}
          busy={busy}
          onConfirm={toggle}
          onCancel={() => setAsking(false)}
        />
      </div>
    )
  return (
    <>
      <button type="button" className="link-btn link-btn--quiet" disabled={busy} onClick={item.test ? toggle : () => setAsking(true)} title={item.test ? 'Count this record again' : 'For a booking you made yourself to try things out: left out of your numbers'}>
        {item.test ? 'Not a test' : 'Mark as test…'}
      </button>
      {error && (
        <span className="fine" role="alert">
          Couldn’t save. Try again.
        </span>
      )}
    </>
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
            {state.copied ? 'Copied' : 'Copy their booking link'}
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
    <Appointment a={a} tz={tz} wrap>
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

// "Did they show up?" with an Undo right after marking, for accidental taps. A visit that happened asks what it was worth
// in the same step (WorthStep).
const SAVED = { no_show: ['No-show', 'Couldn’t visit'], showed: ['Showed up', 'Visited'], completed: ['Job done', 'Job done'], not_completed: ['Visited, not done', 'Visited, not done'] }
function NeedsOutcome({ a, tz, visit, onDone, simple, services }) {
  const [marked, setMarked] = useState(null)
  const [undoError, setUndoError] = useState(false)
  if (marked) {
    return (
      <Appointment a={a} tz={tz} compact wrap>
        <div className="result result--saved">
          <span className="fine" role="status">
            Saved: {SAVED[marked.work || marked.outcome][visit ? 1 : 0]}.
          </span>
          {marked.outcome === 'showed' && <WorthStep a={a} marked={marked} suggested={listedPrice(services, a.need)} onSaved={(valueCents) => setMarked((m) => ({ ...m, valueCents }))} />}
          <span className="result-actions">
            <button
              type="button"
              className="link-btn"
              onClick={async () => {
                const { status } = await record({ id: a.id, outcome: 'clear' })
                if (status === 200) setMarked(null)
                else setUndoError(true)
              }}
            >
              Undo
            </button>
            <button type="button" className="btn btn-sm btn-primary" onClick={onDone}>
              Done
            </button>
          </span>
          {undoError && <span className="fine" role="alert">Couldn’t undo. Try again.</span>}
        </div>
      </Appointment>
    )
  }
  return (
    <Appointment a={a} tz={tz} wrap>
      <OutcomeButtons a={a} visit={visit} onDone={(body) => setMarked(body)} />
      {!simple && <TestToggle item={a} onDone={onDone} />}
    </Appointment>
  )
}

export function OutcomeList({ items, tz, visit, onDone, simple = false }) {
  const services = useServices()
  return (
    <ul className="rows">
      {items.map((a) => (
        <NeedsOutcome key={a.id} a={a} tz={tz} visit={visit} onDone={onDone} simple={simple} services={services} />
      ))}
    </ul>
  )
}

// An upcoming appointment the owner can cancel (Google tells the customer; reminders stop).
const CANCEL_ERRORS = { calendar_unavailable: 'Couldn’t reach Google Calendar. Nothing was changed; please try again.', calendar_access: 'Reconnect Google Calendar in Settings, then try again.', not_cancellable: 'This appointment can no longer be cancelled.', cancel_incomplete: 'It was removed from Google Calendar but not saved here. Press Cancel again to finish.' }
function Upcoming({ a, tz, visit, onCancelled }) {
  const [state, setState] = useState({})
  const what = visit ? 'visit' : 'appointment'
  const cancel = async () => {
    setState({ confirm: true, busy: true })
    const { status, data } = await api('/api/dashboard/appointment-cancel', { method: 'POST', body: { id: a.id, confirm: true } })
    if (status === 200) return onCancelled(a)
    setState({ error: CANCEL_ERRORS[data.error] || 'Couldn’t cancel. Please try again.' })
  }
  return (
    <Appointment a={a} tz={tz} wrap>
      {/* The question takes the full width under the details (beside them it squeezed the name into a narrow column). */}
      <div className={state.confirm ? 'row-confirm' : 'row-actions'} data-cancel={a.id}>
        {state.confirm ? (
          <ConfirmInline
            question={`Cancel ${a.name}’s ${what} on ${when(a.start, tz)}?`}
            detail="It is removed from your Google Calendar, and Google lets the customer know."
            confirmLabel={`Yes, cancel this ${what}`}
            cancelLabel="Keep it"
            busy={state.busy}
            onConfirm={cancel}
            onCancel={() => setState({})}
          />
        ) : (
          <button type="button" className="link-btn" onClick={() => setState({ confirm: true })}>
            Cancel {what}…
          </button>
        )}
        {state.error && (
          <p className="form-error" role="alert">
            {state.error}
          </p>
        )}
      </div>
    </Appointment>
  )
}

export default function Appointments({ me, data, reload, go }) {
  const tz = me.customer.timezone
  const visit = me.customer.appointmentMode === 'at_customer'
  const [cancelled, setCancelled] = useState(null) // the one just cancelled: said in words, since its row disappears
  if (data?.failed) {
    return (
      <>
        <h1 className="title title--page">Appointments</h1>
        <LoadError what="your appointments" onRetry={reload} />
      </>
    )
  }
  if (!data) return <div aria-busy="true" />
  const gone = data.cancelled || []
  const waiting = data.followUp.filter((l) => !l.test).length
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
        {cancelled && (
          <p className="notice-info" role="status" data-cancelled-notice>
            Cancelled: {cancelled.name}, {when(cancelled.start, tz)}. It’s off your Google Calendar, and Google lets them know. You can find it under “Cancelled” below.
          </p>
        )}
        {data.upcoming.length ? (
          <ul className="rows">
            {data.upcoming.map((a) => (
              <Upcoming
                key={a.id}
                a={a}
                tz={tz}
                visit={visit}
                onCancelled={(x) => {
                  setCancelled(x)
                  reload()
                }}
              />
            ))}
          </ul>
        ) : (
          <p className="empty">{data.recent.length || gone.length ? `No upcoming ${visit ? 'visits' : 'appointments'} right now.` : `Nothing booked yet. Share your website or booking link to get your next ${visit ? 'visit' : 'appointment'}.`}</p>
        )}
      </section>
      {(data.recent.length > 0 || gone.length > 0) && (
        <section className="card">
          <h2 className="card-title">Past</h2>
          {data.recent.length > 0 && (
            <>
              <p className="fine">Marked something by mistake? Use “Change”. Every change is saved.</p>
              <ul className="rows">
                {data.recent.map((a) => (
                  <PastResult key={a.id} a={a} tz={tz} visit={visit} onDone={reload} />
                ))}
              </ul>
            </>
          )}
          {gone.length > 0 && (
            <details className="appt-cancelled" data-cancelled-list open={Boolean(cancelled) || undefined}>
              <summary>Cancelled ({gone.length})</summary>
              <p className="fine">Cancelled in the last 90 days, by you or by the customer. They aren’t counted as booked.</p>
              <ul className="rows">
                {gone.map((a) => (
                  <Appointment key={a.id} a={a} tz={tz}>
                    <span className="tag">Cancelled</span>
                  </Appointment>
                ))}
              </ul>
            </details>
          )}
        </section>
      )}
      {data.followUp.length > 0 && (
        <section className="card" id="not-booked">
          <h2 className="card-title">Haven’t booked yet</h2>
          <p className="fine">
            {waiting ? `${plural(waiting, 'person', 'people')} asked in the last 30 days and ${waiting === 1 ? 'hasn’t' : 'haven’t'} booked. ` : ''}Call or email them here, or{' '}
            <button type="button" className="link-btn" onClick={() => go?.('followups')}>
              write to them in Follow-ups
            </button>
            .
          </p>
          <ul className="rows">
            {data.followUp.map((l) => (
              <li key={l.id} className="row row--wrap" data-unbooked={l.id}>
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
                    {l.phone && (
                      <>
                        <a href={`tel:${l.phone}`}>{phoneText(l.phone)}</a> ·{' '}
                      </>
                    )}
                    <a href={`mailto:${l.email}`}>{l.email}</a>
                  </p>
                  {l.address && <p className="row-sub">{l.address}</p>}
                  <p className="row-note">{l.need}</p>
                  {l.coverage && <CoverageAnswer l={l} onDone={reload} />}
                </div>
                <div className="row-actions" data-follow-up>
                  {l.phone && (
                    <a className="btn btn-sm btn-quiet" href={`tel:${l.phone}`}>
                      Call<span className="sr-only"> {l.name}</span>
                    </a>
                  )}
                  {l.email && (
                    <a className="btn btn-sm btn-quiet" href={`mailto:${l.email}`}>
                      Email<span className="sr-only"> {l.name}</span>
                    </a>
                  )}
                  <TestToggle item={l} onDone={reload} />
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
