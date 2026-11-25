// Platform controls: closing requests and deletions in one place, and per-business sessions, restrictions and costs.
// Every write asks for a reason and a confirmation; the server records both.
import { useCallback, useEffect, useState } from 'react'
import { api, whenFull } from '../lib/api.js'

const STEP = { lockout: 'turning services off', ads: 'pausing ads', billing: 'ending billing', integrations: 'disconnecting', data: 'erasing data', verify: 'verifying', done: 'done' }
const STATE = { completed: ['ok', 'Completed'], failed: ['bad', 'Needs a look'], scheduled: ['', 'Scheduled'], running: ['', 'Running'] }
const ERR = { not_available_yet: 'Not available until migration 0041 is applied.', not_scheduled: 'Its recovery window is over.', not_requested: 'Already handled.', reason_required: 'Write a reason (at least 5 characters).', being_deleted: 'This business is being closed or deleted.' }
const adminError = (code) => ERR[code] || 'That didn’t work. Nothing was changed.'

// One consequential action: opens, asks why, confirms.
export function ReasonAction({ label, confirm, text, danger = false, onRun }) {
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [state, setState] = useState({})
  const run = async (e) => {
    e.preventDefault()
    setState({ busy: true })
    const error = await onRun(reason)
    if (error) return setState({ error: adminError(error) })
    setState({})
    setOpen(false)
    setReason('')
  }
  if (!open)
    return (
      <button type="button" className="btn btn-sm btn-quiet" onClick={() => setOpen(true)}>
        {label}
      </button>
    )
  return (
    <form className="stack" onSubmit={run} aria-label={label}>
      {text && <p className="fine">{text}</p>}
      <label className="field">
        <span>Reason (kept in the audit log; no customer details)</span>
        <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} required minLength={5} autoFocus />
      </label>
      {state.error && (
        <p className="form-error" role="alert">
          {state.error}
        </p>
      )}
      <div className="row-actions">
        <button type="button" className="btn btn-sm btn-quiet" onClick={() => setOpen(false)}>
          Cancel
        </button>
        <button type="submit" className={`btn btn-sm ${danger ? 'btn-danger' : 'btn-primary'}`} disabled={state.busy || reason.trim().length < 5}>
          {confirm}
        </button>
      </div>
    </form>
  )
}

const post = async (body) => {
  const { status, data } = await api('/api/platform/controls', { method: 'POST', body: { ...body, confirm: true } })
  return status === 200 ? null : data.error || 'failed'
}

export function Closures({ onOpen }) {
  const [d, setD] = useState(null)
  const load = useCallback(() => api('/api/platform/controls').then(({ status, data }) => setD(status === 200 ? data : { error: true })), [])
  useEffect(() => {
    load()
  }, [load])
  if (!d) return null
  const run = (body) => async (reason) => {
    const e = await post({ ...body, reason })
    if (!e) load()
    return e
  }
  return (
    <section className="card" aria-labelledby="closures-title" data-closures>
      <h2 className="card-title" id="closures-title">
        Closing and deletion
      </h2>
      {d.error ? (
        <p className="form-error">Couldn’t load this.</p>
      ) : (
        <>
          <p className="fine">
            Permanent deletion is {d.deletionEnabled ? 'on' : 'off: owners can ask to close, and you handle it'}.{d.deletionEnabled && (d.recoveryDays ? ` Recovery window: ${d.recoveryDays} days.` : ' No recovery window.')}
          </p>
          {!d.requests.length && !d.deletions.length && <p className="empty">No requests.</p>}
          <ul className="rows">
            {d.requests.map((r) => (
              <li key={`r-${r.customer}`} className="row" data-closure={r.customer}>
                <div className="row-main">
                  <p className="row-title">
                    <button type="button" className="link-btn" onClick={() => onOpen(r.customer)}>
                      {r.name || r.customer}
                    </button>{' '}
                    <span className="tag tag--bad">Asked to close</span>
                  </p>
                  <p className="row-sub">{whenFull(r.at)}</p>
                  <ReasonAction label="Mark handled" confirm="Mark handled" text="Records that you dealt with the request. It doesn’t delete anything." onRun={run({ action: 'resolve_closure', customer: r.customer })} />
                </div>
              </li>
            ))}
            {d.deletions.map((x) => (
              <li key={x.customer} className="row" data-deletion-row={x.state}>
                <div className="row-main">
                  <p className="row-title">
                    <button type="button" className="link-btn" onClick={() => onOpen(x.customer)}>
                      {x.state === 'completed' ? x.customer : x.name || x.customer}
                    </button>{' '}
                    <span className={`tag ${STATE[x.state][0] ? `tag--${STATE[x.state][0]}` : ''}`}>{STATE[x.state][1]}</span>
                  </p>
                  <p className="row-sub">
                    {x.state === 'completed' && `Deleted ${whenFull(x.completedAt)}`}
                    {x.state === 'scheduled' && `Deletes ${whenFull(x.scheduledFor)}${x.billingError ? ` · the plan couldn’t be ended yet (${x.billingError}); trying again` : ''}${x.adsPending ? ' · some ads couldn’t be paused yet; trying again' : ''}`}
                    {x.state === 'running' && `Step: ${STEP[x.step] || x.step}`}
                    {x.state === 'failed' && `Stopped at ${STEP[x.step] || x.step}: ${x.error} (${x.attempts}×). Retries by itself; open the business for “Retry now”.`}
                  </p>
                  {x.state === 'scheduled' && <ReasonAction label="Undo closing" confirm="Undo closing" text="Puts the business back online. Its plan still ends and its ads stay paused until the owner decides." onRun={run({ action: 'undo_deletion', customer: x.customer })} />}
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  )
}

export function BusinessControls({ id }) {
  const [d, setD] = useState(null)
  const [note, setNote] = useState('')
  const load = useCallback(() => api(`/api/platform/controls?customer=${encodeURIComponent(id)}`).then(({ status, data }) => setD(status === 200 ? data : { error: true })), [id])
  useEffect(() => {
    load()
  }, [load])
  if (!d) return null
  if (d.error) return <p className="form-error">Couldn’t load the controls.</p>
  const on = new Map(d.restrictions.list.map((r) => [r.feature, r]))
  const run = (body, done) => async (reason) => {
    const e = await post({ customer: id, ...body, reason })
    if (!e) {
      setNote(done)
      load()
    }
    return e
  }
  return (
    <section className="card" aria-labelledby="controls-title" data-business-controls>
      <h2 className="card-title" id="controls-title">
        Access and usage
      </h2>
      <dl className="kv">
        <div>
          <dt>Signed in now</dt>
          <dd>
            {d.sessions} {d.sessions === 1 ? 'session' : 'sessions'}
          </dd>
        </div>
        <div>
          <dt>Outside costs, 30 days</dt>
          <dd>{d.costs ? `about $${(d.costs.totalMicros / 1e6).toFixed(2)} (estimate)` : 'unavailable'}</dd>
        </div>
      </dl>
      <ReasonAction label="Sign everyone out" confirm="Sign everyone out" text="Ends every member’s sessions. They can sign in again. Platform administrators keep theirs." onRun={run({ action: 'end_sessions' }, 'Everyone was signed out.')} />
      <p className="fine">Features switched off here stay off for this business only. Turning one back on never overrides a platform switch or plan.</p>
      <ul className="rows">
        {Object.entries(d.features).map(([f, label]) => (
          <li key={f} className="row" data-feature={f}>
            <div className="row-main">
              <p className="row-title">
                {label} <span className={`tag ${on.has(f) ? 'tag--bad' : ''}`}>{on.has(f) ? 'Off for this business' : 'Normal'}</span>
              </p>
              {on.has(f) && <p className="row-sub">{on.get(f).reason}</p>}
              {d.restrictions.ready && (
                <ReasonAction
                  label={on.has(f) ? `Allow ${label}` : `Switch off ${label}`}
                  confirm={on.has(f) ? 'Allow again' : 'Switch off'}
                  danger={!on.has(f)}
                  text={f === 'ads' && !on.has(f) ? 'Running campaigns are paused now. They are never restarted for the owner.' : ''}
                  onRun={run({ action: on.has(f) ? 'unrestrict' : 'restrict', feature: f }, on.has(f) ? `${label} is allowed again.` : `${label} is switched off.`)}
                />
              )}
            </div>
          </li>
        ))}
      </ul>
      {!d.restrictions.ready && <p className="fine">Switching features off needs migration 0041.</p>}
      {note && (
        <p className="fine" role="status">
          {note}
        </p>
      )}
    </section>
  )
}
