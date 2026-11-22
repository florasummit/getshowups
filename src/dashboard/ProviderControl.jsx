import { useState } from 'react'
import { Pill } from './ui.jsx'
import { BLOCKER, dashboardOps, STATE, traits } from './provider-control.js'

// The admin-only AI voice provider control: Select → Test now (dry run on the customer page) → Review checklist →
// Activate → Confirm, with rollback. ONE component for both places it appears: the business dashboard (a platform
// admin who is a member; `ops` = the dashboard route, confirmation = a dialog) and the Admin Console
// (/admin/voice-providers; `ops` = the platform route, `business` set, confirmation = the business id typed back, so
// the selected business is unmistakable before anything changes). The server checks the platform-admin list on every
// action in both cases; this never renders for owners. Switching is checked, explained, confirmed, audited, reversible.
// Typed confirmation (console only): the admin types the business id back before a switch or a rollback.
function TypedConfirm({ business, title, lines, action, busy, onConfirm, onCancel }) {
  const [typed, setTyped] = useState('')
  const ok = typed.trim().toLowerCase() === business.id
  return (
    <div className="rx-confirm ui-callout ui-callout--warn" role="group" aria-label="Confirm the change" data-confirm-business={business.id}>
      <p>
        <strong>{title}</strong>
      </p>
      <p className="rx-confirm-business">
        Business: <strong>{business.name}</strong> <code>{business.id}</code> <Pill tone={business.test ? 'warn' : 'bad'}>{business.test ? 'Test business' : 'Live business: real customers'}</Pill>
      </p>
      {lines?.length > 0 && (
        <ul className="fine">
          {lines.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
      )}
      <label className="field">
        <span>Type the business id to confirm</span>
        <input type="text" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} aria-label="Type the business id to confirm" placeholder={business.id} />
      </label>
      <div className="ui-form-actions">
        <button type="button" className="btn btn-primary btn-sm" disabled={!ok || busy} onClick={() => onConfirm(typed.trim().toLowerCase())} data-confirm-action>
          {action}
        </button>
        <button type="button" className="btn btn-quiet btn-sm" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </div>
  )
}

export default function ProviderControl({ providers, reload, ops = dashboardOps, business = null, open = false }) {
  const [target, setTarget] = useState('')
  const [voiceId, setVoiceId] = useState('')
  const [useDefault, setUseDefault] = useState(false)
  const [catalog, setCatalog] = useState(null)
  const [check, setCheck] = useState(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [confirming, setConfirming] = useState(null) // 'switch' | 'rollback' (console: typed confirmation)
  const current = providers.providers.find((p) => p.id === providers.current)
  const targetName = providers.providers.find((p) => p.id === target)?.name || target
  const pick = (next) => {
    setTarget(next)
    setCheck(null)
    setVoiceId('')
    setCatalog(null)
    setConfirming(null)
    if (next) ops.catalog(next).then(({ status, data }) => setCatalog(status === 200 ? data : { voices: [] }))
  }
  const post = async (fn, body) => {
    setBusy(true)
    setMsg('')
    const r = await fn(body)
    setBusy(false)
    return r
  }
  const run = async () => {
    const { status, data } = await post(ops.check, { provider: target, voiceId, useDefaultVoice: useDefault })
    setCheck(status === 200 ? data.check : null)
    if (status !== 200) setMsg(`Couldn’t check (${data?.error || status}).`)
  }
  const applySwitch = async (confirmCustomer) => {
    const { status, data } = await post(ops.switch, { provider: target, voiceId, useDefaultVoice: useDefault, confirm: true, version: providers.version, ...(confirmCustomer ? { confirmCustomer } : {}) })
    setConfirming(null)
    if (status === 200) {
      setMsg(`Activated ${targetName}${business ? ` for ${business.name}` : ''}. New voice sessions use this provider; the previous one is kept for rollback.`)
      setTarget('')
      reload()
    } else {
      setMsg(data?.error === 'stale' ? 'Changed elsewhere; reloaded.' : data?.error === 'blocked' ? 'Blocked by a prerequisite; see the checklist.' : data?.error === 'confirm_customer_mismatch' ? 'The typed business id did not match; nothing changed.' : `Not switched (${data?.error || status}).`)
      if (data?.check) setCheck(data.check)
      if (data?.error === 'stale') reload()
    }
  }
  const doSwitch = () => {
    if (!check?.ok) return
    if (business) return setConfirming('switch')
    if (!window.confirm(`Activate ${check.provider} for this business's customers?\n\n${check.consequences.join('\n')}`)) return
    applySwitch()
  }
  const applyRollback = async (confirmCustomer) => {
    const { status, data } = await post(ops.rollback, { confirm: true, version: providers.version, ...(confirmCustomer ? { confirmCustomer } : {}) })
    setConfirming(null)
    setMsg(status === 200 ? 'Rolled back.' : data?.error === 'confirm_customer_mismatch' ? 'The typed business id did not match; nothing changed.' : `Not rolled back (${data?.error || status}).`)
    if (status === 200 || data?.error === 'stale') reload()
  }
  const rollback = () => {
    if (!providers.previous) return
    if (business) return setConfirming('rollback')
    if (!window.confirm(`Roll back to ${providers.previous.provider}${providers.previous.voiceName ? ` with voice "${providers.previous.voiceName}"` : ''}?`)) return
    applyRollback()
  }
  return (
    <details className="ui-group ui-group--advanced rx-provider" data-provider-control open={open || undefined}>
      <summary>
        AI voice provider (admin) <Pill tone="neutral">{current?.name || providers.current}</Pill>
      </summary>
      <p className="ui-hint">
        Owners never see this. Select a provider → Test it on this business (a dry-run session on the customer page) → Review the checklist → Activate → Confirm. A provider is “ready” only after a
        finished test session here with audio both ways and the booking tools; no provider has phone routing.
      </p>
      <table className="rx-provider-table">
        <thead>
          <tr>
            <th scope="col">Provider</th>
            <th scope="col">Status</th>
            <th scope="col">Configured</th>
            <th scope="col">Phone calls</th>
            <th scope="col">Verified here</th>
            <th scope="col">Blockers</th>
          </tr>
        </thead>
        <tbody>
          {providers.providers.map((p) => (
            <tr key={p.id} aria-current={p.id === providers.current || undefined} data-provider-row={p.id} data-provider-state={p.state}>
              <th scope="row">
                {p.name} {p.id === target && p.id !== providers.current && <Pill tone="neutral">Selected for testing</Pill>}
              </th>
              <td>
                <Pill tone={(STATE[p.state] || STATE.not_configured)[0]}>{(STATE[p.state] || STATE.not_configured)[1]}</Pill>
              </td>
              <td>
                <Pill tone={p.configured ? 'ok' : 'neutral'}>{p.configured ? 'Yes' : 'No'}</Pill>
              </td>
              <td>
                <Pill tone="neutral">{p.phone ? 'Supported' : 'Not supported'}</Pill>
              </td>
              <td className="fine">
                {p.evidence?.ok ? `Yes (${p.evidence.sessions} session${p.evidence.sessions === 1 ? '' : 's'})` : p.evidence?.sessions ? `Partly: missing ${p.evidence.missing.join(', ')}` : 'No'}
              </td>
              <td className="fine">{p.blockers.map((b) => BLOCKER[b] || b).join(', ') || '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="rx-provider-switch">
        <label className="field">
          <span>Switch to</span>
          <select value={target} onChange={(e) => pick(e.target.value)} aria-label="Provider to switch to" disabled={Boolean(confirming)}>
            <option value="">Select a provider…</option>
            {providers.providers
              .filter((p) => p.id !== providers.current)
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {p.state === 'ready' ? ' (ready)' : p.state === 'needs_test' ? ' (needs a test)' : p.configured ? '' : ' (not configured)'}
                </option>
              ))}
          </select>
        </label>
        {target && (
          <>
            <label className="field">
              <span>Voice on the new provider</span>
              <select value={voiceId} onChange={(e) => setVoiceId(e.target.value)} disabled={useDefault || Boolean(confirming)} aria-label="Replacement voice">
                <option value="">{catalog ? 'Choose a voice…' : 'Loading…'}</option>
                {(catalog?.voices || []).map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name}
                    {traits(v).length ? ` (${traits(v).join(', ')})` : ''}
                  </option>
                ))}
              </select>
            </label>
            <label className="check">
              <input type="checkbox" checked={useDefault} onChange={(e) => setUseDefault(e.target.checked)} disabled={Boolean(confirming)} />
              <span>Use the provider’s default voice (explicit; a voice is never substituted silently)</span>
            </label>
            <div className="ui-form-actions">
              {providers.providers.find((p) => p.id === target)?.testUrl ? (
                <a className="btn btn-quiet btn-sm" href={`${providers.providers.find((p) => p.id === target).testUrl}${voiceId && !useDefault ? `&voice=${encodeURIComponent(voiceId)}` : ''}`} target="_blank" rel="noreferrer" data-test-now>
                  Test now (dry run, new tab)
                </a>
              ) : (
                <span className="fine">{providers.testBusiness ? 'Test sessions need a configured provider.' : 'Test sessions run on admin-marked test businesses only (mark this business as a test business in /admin to test here).'}</span>
              )}
              <button type="button" className="btn btn-quiet btn-sm" onClick={run} disabled={busy || Boolean(confirming)}>
                Review checklist
              </button>
              <button type="button" className="btn btn-primary btn-sm" onClick={doSwitch} disabled={busy || !check?.ok || Boolean(confirming)} data-activate>
                Activate…
              </button>
            </div>
          </>
        )}
        {check && (
          <div className="rx-check" aria-label="Switching checklist">
            <ul>
              {check.checks.map((c) => (
                <li key={c.id} className={c.ok ? '' : 'ui-step--miss'}>
                  <Pill tone={c.ok ? 'ok' : 'bad'}>{c.ok ? 'OK' : 'Blocked'}</Pill> {c.note}
                </li>
              ))}
            </ul>
            <p className="fine">
              <strong>What switching does:</strong>
            </p>
            <ul className="fine">
              {check.consequences.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          </div>
        )}
        {confirming === 'switch' && business && check && (
          <TypedConfirm business={business} title={`Activate ${targetName} for this business's customers?`} lines={check.consequences} action={`Activate ${targetName} for ${business.name}`} busy={busy} onConfirm={applySwitch} onCancel={() => setConfirming(null)} />
        )}
        {providers.previous && (
          <p className="fine">
            Previous: {providers.previous.provider}
            {providers.previous.voiceName ? ` · ${providers.previous.voiceName}` : ''}.{' '}
            <button type="button" className="link-btn" onClick={rollback} disabled={busy || Boolean(confirming)}>
              Roll back
            </button>
          </p>
        )}
        {confirming === 'rollback' && business && providers.previous && (
          <TypedConfirm business={business} title={`Roll back to ${providers.previous.provider}${providers.previous.voiceName ? ` with voice "${providers.previous.voiceName}"` : ''}?`} lines={['New voice sessions use the previous provider and voice; sessions in progress stay on the provider they started with.']} action={`Roll back ${business.name}`} busy={busy} onConfirm={applyRollback} onCancel={() => setConfirming(null)} />
        )}
        <span className="fine" role="status">
          {msg}
        </span>
      </div>
    </details>
  )
}
