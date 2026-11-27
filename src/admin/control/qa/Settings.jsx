// QA settings: the QA spending budget for paid AI and voice checks (daily and monthly ceilings, enforced by the
// existing spend guard on the server), whether paid checks may run at all, evidence retention, and the optional
// scheduled read-only production check. Every change needs a reason and a confirmation, and is audited server-side.
import { useState } from 'react'
import { ConfirmInline, SaveStatus } from '../../../dashboard/ui.jsx'
import { useSaveState } from '../../../dashboard/ui-hooks.js'
import * as qa from '../qa-api.js'
import { stamp, usd } from '../qa-lib.js'
import { useLoad } from './hooks.jsx'

const FIELDS = [
  ['paid_evals', 'Paid AI and voice checks', 'switch', 'Off means they never run, whatever the budget.'],
  ['eval_monthly_micros', 'Monthly QA budget', 'money', 'Paid checks stop at this amount each month.'],
  ['eval_daily_micros', 'Daily QA budget', 'money', 'Paid checks stop at this amount each day.'],
  ['evidence_days', 'Keep screenshots and logs for', 'days', 'Results and their history are always kept; only the attached files expire.'],
  ['schedule_production', 'Daily read-only production check', 'switch', 'Runs the production verification once a day. It changes nothing.'],
]
const show = (kind, v) => (v == null ? 'Not set' : kind === 'money' ? usd(Number(v) / 1e6, { free: false }) : kind === 'days' ? `${v} days` : Number(v) ? 'On' : 'Off')

function SettingRow({ k, label, kind, hint, value, max, changed, onSaved }) {
  const [editing, setEditing] = useState(false)
  const [v, setV] = useState(kind === 'money' ? String((Number(value) || 0) / 1e6) : String(value ?? ''))
  const [reason, setReason] = useState('')
  const [asking, setAsking] = useState(false)
  const [err, setErr] = useState('')
  const save = useSaveState()
  const id = `qa-set-${k}`
  const next = kind === 'money' ? Math.round(Number(v) * 1e6) : kind === 'switch' ? (v === '1' ? 1 : 0) : Math.round(Number(v))
  const check = (e) => {
    e.preventDefault()
    if (!Number.isFinite(next) || next < 0) return setErr(kind === 'money' ? 'Use an amount in dollars, e.g. 3.00.' : 'Use a whole number.')
    if (max != null && next > max) return setErr(`The most allowed here is ${show(kind, max)}.`)
    if (!reason.trim()) return setErr('Say why you’re changing it (kept in the audit log).')
    setErr('')
    setAsking(true)
  }
  const confirm = () =>
    save.run(async () => {
      const r = await qa.saveSetting(k, next, reason.trim())
      setAsking(false)
      if (!r.ok) return { error: r.error }
      setEditing(false)
      setReason('')
      onSaved()
      return { saved: `${label}: ${show(kind, next)}.` }
    })
  return (
    <li className="qa-setting" data-setting={k}>
      <div className="qa-setting-row">
        <span className="qa-setting-main">
          <strong>{label}</strong>
          <span className="cc-item-sub">
            {hint}
            {changed ? ` Last changed ${stamp(changed.at)}${changed.by ? ` by ${changed.by}` : ''}.` : ''}
          </span>
        </span>
        <span className="qa-setting-value" data-setting-value>
          {show(kind, value)}
        </span>
        {!editing && (
          <button type="button" className="btn btn-quiet btn-sm" onClick={() => (setV(kind === 'money' ? String((Number(value) || 0) / 1e6) : String(value ?? '')), setEditing(true))} aria-label={`Change ${label}`}>
            Change
          </button>
        )}
      </div>
      {editing && (
        <form className="stack" onSubmit={check} noValidate>
          <div className="field-row">
            <label className="field" htmlFor={`${id}-v`}>
              <span>{kind === 'money' ? 'Amount in dollars' : kind === 'days' ? 'Days' : 'Setting'}</span>
              {kind === 'switch' ? (
                <select id={`${id}-v`} value={v === '1' ? '1' : '0'} onChange={(e) => setV(e.target.value)}>
                  <option value="0">Off</option>
                  <option value="1">On</option>
                </select>
              ) : (
                <input id={`${id}-v`} inputMode="decimal" value={v} onChange={(e) => setV(e.target.value)} aria-invalid={err ? 'true' : undefined} />
              )}
            </label>
            <label className="field" htmlFor={`${id}-r`}>
              <span>Reason</span>
              <input id={`${id}-r`} maxLength={200} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Founder approved $3 for this initiative" />
            </label>
          </div>
          {err && (
            <p className="form-error" role="alert">
              {err}
            </p>
          )}
          {asking ? (
            <ConfirmInline question={`Change ${label.toLowerCase()} from ${show(kind, value)} to ${show(kind, next)}?`} detail={kind === 'money' || k === 'paid_evals' ? 'This changes what paid checks may spend. It is recorded in the audit log.' : 'It is recorded in the audit log.'} confirmLabel="Change it" danger={false} busy={save.pending} onConfirm={confirm} onCancel={() => setAsking(false)} />
          ) : (
            <div className="cc-actions">
              <button type="submit" className="btn btn-primary btn-sm">
                Review change
              </button>
              <button type="button" className="btn btn-quiet btn-sm" onClick={() => setEditing(false)}>
                Cancel
              </button>
            </div>
          )}
        </form>
      )}
      <SaveStatus save={save} />
    </li>
  )
}

export function QaSettings() {
  const [d, reload] = useLoad(qa.getSettings, [])
  return (
    <details className="cc-details" data-qa-settings>
      <summary>QA budget and settings</summary>
      {d === undefined ? (
        <p className="cc-status-line" aria-busy="true">
          Loading settings…
        </p>
      ) : d.error ? (
        <p className="form-error" role="alert">
          Couldn’t load the settings.{' '}
          <button type="button" className="link-btn" onClick={reload}>
            Retry
          </button>
        </p>
      ) : (
        <ul className="qa-settings">
          {FIELDS.map(([k, label, kind, hint]) => (
            <SettingRow key={k} k={k} label={label} kind={kind} hint={hint} value={d.settings?.[k]} max={d.max?.[k]} changed={d.changed?.[k]} onSaved={() => reload(true)} />
          ))}
        </ul>
      )}
    </details>
  )
}
