// Global default AI voice provider (/admin/voice-providers, top section). The default every business without an explicit
// provider of its own follows. Change: choose a provider → Review (platform checks + every inherited business through its
// own checklist, with blockers by name) → choose "all at once" (only when nobody is blocked) or a staged rollout (blocked
// businesses are pinned to today's provider, by name) → type the provider id → Change. Rollback likewise. Nothing here
// changes a business's explicit override or a session in progress; the server checks the platform-admin list on
// every action and never activates an unverified business.
import { useState } from 'react'
import { api } from '../lib/api.js'
import { Badge, Facts, Section } from './control/ui.jsx'
import { when } from './control/lib.js'
import { BLOCKER } from '../dashboard/provider-control.js'

const STATUS = { switch: ['ok', 'Switches now (verified)'], pinned: ['warn', 'Stays (pinned, unverified)'], override: ['neutral', 'Untouched (explicit override)'] }
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 'es'}`

export default function GlobalProvider({ global, reload }) {
  const [target, setTarget] = useState('')
  const [check, setCheck] = useState(null)
  const [mode, setMode] = useState('staged')
  const [confirming, setConfirming] = useState(null) // 'switch' | 'rollback'
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const cur = global.current
  const targetName = global.providers.find((p) => p.id === target)?.name || target
  const post = async (body) => {
    setBusy(true)
    setMsg('')
    const r = await api('/api/platform/voice-provider', { method: 'POST', body })
    setBusy(false)
    return r
  }
  const pick = (p) => {
    setTarget(p)
    setCheck(null)
    setConfirming(null)
    setTyped('')
  }
  const review = async () => {
    const { status, data } = await post({ action: 'global_check', provider: target })
    setCheck(status === 200 ? data.check : null)
    if (status !== 200) setMsg(`Couldn’t check (${data?.error || status}).`)
    else setMode(data.check.counts.pinned > 0 ? 'staged' : 'all')
  }
  const doSwitch = async () => {
    const { status, data } = await post({ action: 'global_switch', provider: target, confirmProvider: typed.trim().toLowerCase(), mode, confirm: true, version: cur.version })
    setConfirming(null)
    setTyped('')
    if (status === 200) {
      setMsg(`Global default is now ${targetName}: ${data.applied.switched} switched, ${data.applied.pinned} pinned, ${data.applied.overrides} overrides untouched. The previous default is kept for rollback.`)
      setTarget('')
      setCheck(null)
      reload()
    } else {
      setMsg(data?.error === 'stale' ? 'Changed elsewhere; reloaded.' : data?.error === 'blocked' ? (data.reason === 'unverified_businesses' ? 'Some businesses are not verified: choose the staged rollout or verify them first.' : 'Blocked by a platform check; see the checklist.') : data?.error === 'confirm_provider_mismatch' ? 'The typed provider did not match; nothing changed.' : `Not changed (${data?.error || status}).`)
      if (data?.check) setCheck(data.check)
      if (data?.error === 'stale') reload()
    }
  }
  const doRollback = async () => {
    const { status, data } = await post({ action: 'global_rollback', confirmProvider: typed.trim().toLowerCase(), confirm: true, version: cur.version })
    setConfirming(null)
    setTyped('')
    if (status === 200) {
      const k = data.undone.kept.length
      setMsg(`Rolled back: ${data.undone.unpinned} business${data.undone.unpinned === 1 ? '' : 'es'} follow the default again, ${data.undone.moved} moved back${k ? `, ${k} kept where they are (${data.undone.kept.map((x) => `${x.id}: ${x.reason}`).join(', ')})` : ''}.`)
      reload()
    } else {
      setMsg(data?.error === 'confirm_provider_mismatch' ? 'The typed provider did not match; nothing changed.' : data?.error === 'stale' ? 'Changed elsewhere; reloaded.' : `Not rolled back (${data?.error || status}).`)
      if (data?.error === 'stale') reload()
    }
  }
  const typedOk = confirming === 'switch' ? typed.trim().toLowerCase() === target : typed.trim().toLowerCase() === (cur.previous || '')
  return (
    <Section title="Global voice provider" id="vp-global" sub="The provider every business without an explicit provider of its own uses for customer-facing browser voice. A change is checked business by business and never activates an unverified business." data-global-provider={cur.provider}>
      <div className="cc-section-body">
        {!global.ready && <p className="cc-callout">Global default storage is not available yet (migration 0036). Every business follows Retell; nothing can be changed here.</p>}
        <Facts
          items={[
            ['Current global default', `${cur.name}${cur.version ? ` (version ${cur.version}, set ${when(cur.setAt)}${cur.mode ? `, ${cur.mode}` : ''})` : ' (initial default, never changed)'}`],
            ['Businesses following it', `${global.counts.inherited} of ${global.counts.total}`],
            ['Businesses with an explicit override', String(global.counts.overrides)],
            cur.version ? ['Pinned by the current version', String(cur.pinned)] : null,
            ['Previous default', cur.previous ? global.providers.find((p) => p.id === cur.previous)?.name || cur.previous : '—'],
          ]}
        />
        {global.ready && (
          <div className="rx-provider-switch">
            <label className="field">
              <span>Change the global default to</span>
              <select value={target} onChange={(e) => pick(e.target.value)} aria-label="Global provider" disabled={busy || Boolean(confirming)} data-global-target>
                <option value="">Select a provider…</option>
                {global.providers
                  .filter((p) => p.id !== cur.provider)
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                      {!p.configured ? ' (not configured)' : !p.enabled ? ' (switched off)' : ''}
                    </option>
                  ))}
              </select>
            </label>
            {target && (
              <div className="ui-form-actions">
                <button type="button" className="btn btn-quiet btn-sm" onClick={review} disabled={busy || Boolean(confirming)} data-global-review>
                  Review all businesses
                </button>
                <button type="button" className="btn btn-primary btn-sm" onClick={() => setConfirming('switch')} disabled={busy || !check?.ok || Boolean(confirming) || (mode === 'all' && check.counts.pinned > 0)} data-global-change>
                  Change default…
                </button>
              </div>
            )}
            {check && (
              <div className="rx-check" aria-label="Global checklist" data-global-check={check.ok ? 'ok' : 'blocked'}>
                <ul>
                  {check.checks.map((c) => (
                    <li key={c.id} className={c.ok ? '' : 'ui-step--miss'}>
                      <Badge tone={c.ok ? 'ok' : 'bad'}>{c.ok ? 'OK' : 'Blocked'}</Badge> {c.note}
                    </li>
                  ))}
                </ul>
                {check.ok && (
                  <>
                    <p className="fine">
                      <strong>
                        {plural(check.counts.switch, 'business')} switch now · {plural(check.counts.pinned, 'business')} stay pinned (unverified) · {plural(check.counts.overrides, 'business')} with an explicit override untouched.
                      </strong>
                    </p>
                    <table className="vp-history" data-global-businesses>
                      <thead>
                        <tr>
                          <th scope="col">Business</th>
                          <th scope="col">Today</th>
                          <th scope="col">After the change</th>
                          <th scope="col">Blockers</th>
                        </tr>
                      </thead>
                      <tbody>
                        {check.businesses.map((b) => (
                          <tr key={b.id} data-global-business={b.id} data-global-status={b.status}>
                            <td>
                              {b.name} <code>{b.id}</code> {b.test ? <Badge tone="neutral">Test</Badge> : null}
                              {!b.receptionist && <span className="fine"> · receptionist off</span>}
                            </td>
                            <td>
                              {global.providers.find((p) => p.id === b.provider)?.name || b.provider} ({b.inherited ? 'global' : 'override'})
                            </td>
                            <td>
                              <Badge tone={STATUS[b.status][0]}>{STATUS[b.status][1]}</Badge>
                            </td>
                            <td className="fine">{b.blockers.map((x) => BLOCKER[x] || x).join(', ') || '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <fieldset className="ui-group" disabled={busy || Boolean(confirming)}>
                      <legend>How to apply it</legend>
                      <label className="check">
                        <input type="radio" name="global-mode" checked={mode === 'all'} onChange={() => setMode('all')} disabled={check.counts.pinned > 0} />
                        <span>All at once{check.counts.pinned > 0 ? ` (not possible: ${plural(check.counts.pinned, 'business')} not verified)` : ''}</span>
                      </label>
                      <label className="check">
                        <input type="radio" name="global-mode" checked={mode === 'staged'} onChange={() => setMode('staged')} />
                        <span>Staged rollout: verified businesses switch now; unverified ones are pinned to today’s provider (an explicit override, listed above) until tested and activated one by one; businesses created later follow the new default.</span>
                      </label>
                    </fieldset>
                    <p className="fine">
                      <strong>What changing the default does:</strong>
                    </p>
                    <ul className="fine">
                      {check.consequences.map((c) => (
                        <li key={c}>{c}</li>
                      ))}
                    </ul>
                  </>
                )}
              </div>
            )}
            {confirming && (
              <div className="rx-confirm ui-callout ui-callout--warn" role="group" aria-label="Confirm the global change" data-global-confirm={confirming}>
                <p>
                  <strong>{confirming === 'switch' ? `Change the global default to ${targetName} (${mode === 'all' ? 'all businesses at once' : 'staged rollout'})?` : `Roll the global default back to ${global.providers.find((p) => p.id === cur.previous)?.name || cur.previous}?`}</strong>
                </p>
                <p className="fine">{confirming === 'switch' ? `${plural(check?.counts.switch || 0, 'business')} switch now; ${plural(check?.counts.pinned || 0, 'business')} are pinned; ${plural(check?.counts.overrides || 0, 'business')} with an override are untouched. Sessions in progress are not interrupted.` : `Businesses pinned by version ${cur.version} follow the default again and rows it moved go back, unless they were changed since (reported). Sessions in progress are not interrupted.`}</p>
                <label className="field">
                  <span>Type the provider id to confirm ({confirming === 'switch' ? target : cur.previous})</span>
                  <input type="text" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} aria-label="Type the provider id to confirm" placeholder={confirming === 'switch' ? target : cur.previous} />
                </label>
                <div className="ui-form-actions">
                  <button type="button" className="btn btn-primary btn-sm" disabled={!typedOk || busy} onClick={confirming === 'switch' ? doSwitch : doRollback} data-global-confirm-action>
                    {confirming === 'switch' ? `Change the default to ${targetName}` : 'Roll back the default'}
                  </button>
                  <button type="button" className="btn btn-quiet btn-sm" onClick={() => setConfirming(null)} disabled={busy}>
                    Cancel
                  </button>
                </div>
              </div>
            )}
            {cur.canRollBack && !confirming && (
              <p className="fine">
                Previous default: {global.providers.find((p) => p.id === cur.previous)?.name || cur.previous}.{' '}
                <button type="button" className="link-btn" onClick={() => setConfirming('rollback')} disabled={busy} data-global-rollback>
                  Roll back
                </button>
              </p>
            )}
            <span className="fine" role="status" data-global-status>
              {msg}
            </span>
          </div>
        )}
      </div>
    </Section>
  )
}
