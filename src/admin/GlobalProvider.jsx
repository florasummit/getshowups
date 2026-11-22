// Global default AI voice provider (/admin/voice-providers, top section). The default every business without an explicit
// provider of its own follows. Stage: choose a provider → Review (platform checks + every inherited business through its
// own checklist, with blockers by name) → "all at once" (only when nobody is blocked) or a staged rollout (blocked
// businesses are pinned to today's provider, by name) → type the provider id → Change. Promote: the staged provider goes
// to 100% of the businesses in ONE action: provider-level verification (a finished production-path test on a test
// business) + automated compatibility checks per business; missing per-business tests are a warning the admin
// acknowledges, real incompatibilities block the whole promotion; rollout pins are released into following the default;
// deliberate overrides only when included; type the provider id → Promote. Rollback likewise. Nothing here changes a
// session in progress; the server checks the platform-admin list on every action.
import { useState } from 'react'
import { api } from '../lib/api.js'
import { Badge, Facts, Section } from './control/ui.jsx'
import { when } from './control/lib.js'
import { BLOCKER } from '../dashboard/provider-control.js'

const STATUS = { switch: ['ok', 'Switches now (verified)'], pinned: ['warn', 'Stays (pinned, unverified)'], override: ['neutral', 'Untouched (explicit override)'] }
const PROMO = { promote: ['ok', 'Promoted'], blocked: ['bad', 'Blocked'], excluded: ['neutral', 'Untouched'] }
const ACTION = { follow: 'follows the default', release_pin: 'rollout pin released: follows the default', replace_override: 'deliberate override replaced: follows the default', none: 'untouched' }
const WARN = { unverified: 'no test session of its own', booking_not_ready: 'cannot book yet (any provider)', receptionist_off: 'receptionist off' }
const KIND = { inherited: 'follows the default', pin: 'rollout pin', override: 'deliberate override' }
const MODE = { all: 'promoted to 100%', staged: 'staged rollout', rollback: 'rollback' }
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 'es'}`
const usd = (micros) => (micros == null ? 'unavailable' : `$${(micros / 1e6).toFixed(micros < 100_000 ? 4 : 2)}`)
const num = (v) => (v == null ? 'unavailable' : String(v))

export default function GlobalProvider({ global, reload }) {
  const [target, setTarget] = useState('')
  const [check, setCheck] = useState(null)
  const [mode, setMode] = useState('staged')
  const [promo, setPromo] = useState(null) // the promotion checklist (null = not reviewed)
  const [includeOverrides, setIncludeOverrides] = useState(false)
  const [ack, setAck] = useState(false)
  const [confirming, setConfirming] = useState(null) // 'switch' | 'rollback' | 'promote'
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const cur = global.current
  const nameOf = (id) => global.providers.find((p) => p.id === id)?.name || id
  const targetName = nameOf(target)
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
      setPromo(null)
      reload()
    } else {
      setMsg(data?.error === 'stale' ? 'Changed elsewhere; reloaded.' : data?.error === 'blocked' ? (data.reason === 'unverified_businesses' ? 'Some businesses are not verified: choose the staged rollout or verify them first.' : 'Blocked by a platform check; see the checklist.') : data?.error === 'confirm_provider_mismatch' ? 'The typed provider did not match; nothing changed.' : `Not changed (${data?.error || status}).`)
      if (data?.check) setCheck(data.check)
      if (data?.error === 'stale') reload()
    }
  }
  const reviewPromotion = async (include = includeOverrides) => {
    const { status, data } = await post({ action: 'global_promote_check', includeOverrides: include })
    setPromo(status === 200 ? data.check : null)
    setAck(false)
    if (status !== 200) setMsg(`Couldn’t check the promotion (${data?.error || status}).`)
  }
  const toggleOverrides = (v) => {
    setIncludeOverrides(v)
    setConfirming(null)
    reviewPromotion(v)
  }
  const doPromote = async () => {
    const { status, data } = await post({ action: 'global_promote', provider: cur.provider, confirmProvider: typed.trim().toLowerCase(), includeOverrides, acknowledgeUnverified: ack, confirm: true, version: cur.version })
    setConfirming(null)
    setTyped('')
    if (status === 200) {
      const d = data.distribution.byProvider
      setMsg(`Promoted ${cur.name} to 100%: ${plural(data.applied.promoted, 'business')} promoted (${data.applied.pinsReleased} pins released, ${data.applied.overridesReplaced} overrides replaced, ${data.applied.moved} rows moved), ${data.applied.excluded} untouched. Now: ${Object.entries(d).map(([p, n]) => `${nameOf(p)} ${n}`).join(' · ')}. Rollback is available.`)
      setPromo(null)
      setAck(false)
      reload()
    } else {
      setMsg(data?.error === 'stale' ? 'Changed elsewhere (a business or the default moved since the review); nothing applied. Reloaded.' : data?.error === 'blocked' ? 'Blocked: see the checklist; nothing applied.' : data?.error === 'acknowledgement_required' ? 'Acknowledge the unverified businesses first; nothing applied.' : data?.error === 'confirm_provider_mismatch' ? 'The typed provider did not match; nothing changed.' : `Not promoted (${data?.error || status}).`)
      if (data?.check) setPromo(data.check)
      if (data?.error === 'stale') reload()
    }
  }
  const doRollback = async () => {
    const { status, data } = await post({ action: 'global_rollback', confirmProvider: typed.trim().toLowerCase(), confirm: true, version: cur.version })
    setConfirming(null)
    setTyped('')
    if (status === 200) {
      const u = data.undone
      const k = u.kept.length
      setMsg(`Rolled back to ${nameOf(data.global.current.provider)}: ${plural(u.unpinned, 'business')} follow the default again, ${u.moved} moved back, ${u.pinsRestored} rollout pins restored, ${u.overridesRestored} overrides restored${k ? `, ${k} kept where they are (${u.kept.map((x) => `${x.id}: ${x.reason}`).join(', ')})` : ''}.`)
      setPromo(null)
      reload()
    } else {
      setMsg(data?.error === 'confirm_provider_mismatch' ? 'The typed provider did not match; nothing changed.' : data?.error === 'stale' ? 'Changed elsewhere; reloaded.' : `Not rolled back (${data?.error || status}).`)
      if (data?.error === 'stale') reload()
    }
  }
  const expectedTyped = confirming === 'switch' ? target : confirming === 'promote' ? cur.provider : cur.previous || ''
  const typedOk = typed.trim().toLowerCase() === expectedTyped
  const r = global.rollout
  const promoReady = Boolean(promo?.ok) && (promo.counts.unverified === 0 || ack)
  return (
    <Section title="Global voice provider" id="vp-global" sub="The provider every business without an explicit provider of its own uses for customer-facing browser voice. A change is checked business by business and never activates an unverified business." data-global-provider={cur.provider}>
      <div className="cc-section-body">
        {!global.ready && <p className="cc-callout">Global default storage is not available yet (migration 0036). Every business follows Retell; nothing can be changed here.</p>}
        <Facts
          items={[
            ['Current global default', `${cur.name}${cur.version ? ` (version ${cur.version}, set ${when(cur.setAt)}${cur.mode ? `, ${MODE[cur.mode] || cur.mode}` : ''})` : ' (initial default, never changed)'}`],
            ['Staged target provider', cur.version && cur.mode === 'staged' ? `${cur.name} (staged; promote it below)` : cur.name],
            ['Businesses using it', `${global.counts.usingDefault} of ${global.counts.total}`],
            ['Following the default', `${global.counts.inherited} of ${global.counts.total}`],
            ['Pinned to a previous provider by a rollout', String(global.counts.pins)],
            ['Deliberate overrides', String(global.counts.independent)],
            ['Last rollout', cur.version ? `version ${cur.version}: ${MODE[cur.mode] || cur.mode}, ${cur.pinned} pinned, ${cur.switched} switched, ${when(cur.setAt)}` : 'none'],
            ['Previous default', cur.previous ? nameOf(cur.previous) : '—'],
            ['Rollback', cur.canRollBack ? `available (back to ${nameOf(cur.previous)})` : 'not available'],
          ]}
        />
        {global.ready && (
          <div className="rx-provider-switch" data-global-promotion data-global-promotion-pins={global.counts.pins}>
            <h3 className="vp-sub">Promote {cur.name} to 100%</h3>
            <p className="fine">
              One action for every business: rollout pins are released (those businesses follow the default again, no permanent override), businesses already following keep following, deliberate overrides only when included. Needs a finished production-path test of {cur.name} on a test business; businesses without a test of their own are a warning you acknowledge, real incompatibilities block all of it.
            </p>
            <div className="ui-form-actions">
              <button type="button" className="btn btn-primary btn-sm" onClick={() => reviewPromotion()} disabled={busy || Boolean(confirming)} data-global-promote>
                {promo ? 'Review again' : 'Promote to 100%…'}
              </button>
              <label className="check">
                <input type="checkbox" checked={includeOverrides} onChange={(e) => toggleOverrides(e.target.checked)} disabled={busy || Boolean(confirming)} data-global-promote-overrides />
                <span>Include deliberate overrides ({global.counts.independent}): replace them too (their previous provider is kept for the rollback)</span>
              </label>
            </div>
            {promo && (
              <div className="rx-check" aria-label="Promotion checklist" data-global-promote-check={promo.ok ? 'ok' : 'blocked'}>
                <ul>
                  {promo.checks.map((c) => (
                    <li key={c.id} className={c.ok ? '' : 'ui-step--miss'}>
                      <Badge tone={c.ok ? 'ok' : 'bad'}>{c.ok ? 'Verified' : 'Blocked'}</Badge> {c.note}
                    </li>
                  ))}
                  {promo.warnings.map((w) => (
                    <li key={w.code}>
                      <Badge tone="warn">Warning</Badge> {w.note}
                    </li>
                  ))}
                </ul>
                <p className="fine">
                  <strong>Promote {cur.name} to 100%</strong>
                </p>
                <ul className="fine" data-global-promote-summary>
                  <li>Total businesses: {promo.summary.total}</li>
                  <li>Already using {cur.name}: {promo.summary.usingTarget}</li>
                  <li>Rollout pins to release: {promo.summary.pinsToRelease}</li>
                  <li>Deliberate overrides to replace: {promo.summary.overridesToReplace}{promo.summary.overridesUntouched ? ` (${promo.summary.overridesUntouched} untouched, not included)` : ''}</li>
                  <li>Businesses blocked: {promo.summary.blocked}</li>
                  {promo.summary.suspended ? <li>Suspended (excluded): {promo.summary.suspended}</li> : null}
                  <li>New global provider: {cur.name}</li>
                </ul>
                <table className="vp-history" data-global-promote-businesses>
                  <thead>
                    <tr>
                      <th scope="col">Business</th>
                      <th scope="col">Today</th>
                      <th scope="col">After</th>
                      <th scope="col">Verified</th>
                      <th scope="col">Warnings</th>
                      <th scope="col">Blockers</th>
                    </tr>
                  </thead>
                  <tbody>
                    {promo.businesses.map((b) => (
                      <tr key={b.id} data-global-promote-business={b.id} data-global-promote-status={b.status}>
                        <td>
                          {b.name} <code>{b.id}</code> {b.test ? <Badge tone="neutral">Test</Badge> : null}
                        </td>
                        <td>
                          {nameOf(b.provider)} ({KIND[b.kind] || b.kind})
                        </td>
                        <td>
                          <Badge tone={PROMO[b.status][0]}>{PROMO[b.status][1]}</Badge> <span className="fine">{b.status === 'excluded' ? (b.reason === 'suspended' ? 'suspended' : 'not included') : ACTION[b.action] || b.action}</span>
                        </td>
                        <td className="fine">{b.facts?.length ? b.facts.join(' ') : '—'}</td>
                        <td className="fine">{b.warnings.map((w) => WARN[w] || w).join(', ') || '—'}</td>
                        <td className="fine">{b.blockers.map((x) => BLOCKER[x] || x).join(', ') || (b.reason === 'platform' ? 'platform check' : '—')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="fine">
                  <strong>What promoting does:</strong>
                </p>
                <ul className="fine">
                  {promo.consequences.map((c) => (
                    <li key={c}>{c}</li>
                  ))}
                </ul>
                {promo.ok && promo.counts.unverified > 0 && (
                  <label className="check">
                    <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} disabled={busy || Boolean(confirming)} data-global-promote-ack />
                    <span>
                      I acknowledge that {plural(promo.counts.unverified, 'business')} {promo.counts.unverified === 1 ? 'has' : 'have'} no finished {cur.name} test session of {promo.counts.unverified === 1 ? 'its' : 'their'} own; the provider-level production-path test and the automated compatibility checks passed. None of them is reported as individually tested.
                    </span>
                  </label>
                )}
                <div className="ui-form-actions">
                  <button type="button" className="btn btn-primary btn-sm" onClick={() => setConfirming('promote')} disabled={busy || !promoReady || Boolean(confirming)} data-global-promote-confirm>
                    Confirm promotion…
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
        {r && (
          <div className="rx-provider-switch" data-global-rollout={r.provider}>
            <h3 className="vp-sub">Rollout status</h3>
            <Facts
              items={[
                ['Target provider', `${nameOf(r.provider)} (${MODE[r.mode] || r.mode}, version ${r.version})`],
                ['Since', when(r.since)],
                ['Businesses affected by that version', `${cur.switched} switched, ${cur.pinned} pinned`],
                ['Businesses currently using it', `${global.counts.usingDefault} of ${global.counts.total}`],
                ['Sessions since then', r.sessions == null ? 'unavailable' : `${r.sessions} (${r.finished} finished, ${r.inProgress} in progress) on ${plural(r.businesses, 'business')}${r.truncated ? ', newest 500 counted' : ''}`],
                ['Session connection failures', num(r.connectionFailures)],
                ['Tool execution failures', num(r.toolFailures)],
                ['Booking failures', `${num(r.bookingFailures)}${r.bookings != null ? ` (${r.bookings} booked)` : ''}`],
                ['Usage and estimated cost', r.minutes == null ? 'unavailable' : `${r.minutes} min · ${usd(r.estimatedMicros)}`],
                ['Rollback', cur.canRollBack ? `available (back to ${nameOf(cur.previous)})` : 'not available'],
              ]}
            />
          </div>
        )}
        {global.ready && (
          <div className="rx-provider-switch">
            <h3 className="vp-sub">Stage a different provider</h3>
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
                              {nameOf(b.provider)} ({b.inherited ? 'global' : 'override'})
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
                        <span>All at once (every business individually verified){check.counts.pinned > 0 ? ` (not possible: ${plural(check.counts.pinned, 'business')} not verified; stage it, test the provider, then Promote to 100%)` : ''}</span>
                      </label>
                      <label className="check">
                        <input type="radio" name="global-mode" checked={mode === 'staged'} onChange={() => setMode('staged')} />
                        <span>Staged rollout: verified businesses switch now; unverified ones are pinned to today’s provider (an explicit override, listed above) until promoted (Promote to 100% above) or activated one by one; businesses created later follow the new default.</span>
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
          </div>
        )}
        {confirming && (
          <div className="rx-confirm ui-callout ui-callout--warn" role="group" aria-label="Confirm the global change" data-global-confirm={confirming}>
            <p>
              <strong>{confirming === 'switch' ? `Change the global default to ${targetName} (${mode === 'all' ? 'all businesses at once' : 'staged rollout'})?` : confirming === 'promote' ? `Promote ${cur.name} to 100% of the businesses in scope?` : `Roll the global default back to ${nameOf(cur.previous)}?`}</strong>
            </p>
            <p className="fine">
              {confirming === 'switch'
                ? `${plural(check?.counts.switch || 0, 'business')} switch now; ${plural(check?.counts.pinned || 0, 'business')} are pinned; ${plural(check?.counts.overrides || 0, 'business')} with an override are untouched. Sessions in progress are not interrupted.`
                : confirming === 'promote'
                  ? `${plural(promo?.summary.willChange || 0, 'business')} change provider now; ${promo?.summary.pinsToRelease || 0} rollout pins released; ${promo?.summary.overridesToReplace || 0} overrides replaced; ${promo?.summary.overridesUntouched || 0} untouched. NEW customer-facing browser conversations of every promoted business use ${cur.name}; conversations in progress continue on their provider; telephone routing is unchanged; provider behaviour and costs may differ; there is no automatic fallback; rollback stays available for future sessions.`
                  : `Businesses pinned by version ${cur.version} follow the default again, rows it moved go back, pins and overrides it released are restored, unless they were changed since (reported). Sessions in progress are not interrupted.`}
            </p>
            <label className="field">
              <span>Type the provider id to confirm ({expectedTyped})</span>
              <input type="text" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} aria-label="Type the provider id to confirm" placeholder={expectedTyped} />
            </label>
            <div className="ui-form-actions">
              <button type="button" className="btn btn-primary btn-sm" disabled={!typedOk || busy} onClick={confirming === 'switch' ? doSwitch : confirming === 'promote' ? doPromote : doRollback} data-global-confirm-action>
                {confirming === 'switch' ? `Change the default to ${targetName}` : confirming === 'promote' ? `Promote ${cur.name} to 100%` : 'Roll back the default'}
              </button>
              <button type="button" className="btn btn-quiet btn-sm" onClick={() => setConfirming(null)} disabled={busy}>
                Cancel
              </button>
            </div>
          </div>
        )}
        {global.ready && cur.canRollBack && !confirming && (
          <p className="fine">
            {cur.mode === 'all' ? 'Roll back global promotion' : 'Previous default'}: {nameOf(cur.previous)}.{' '}
            <button type="button" className="link-btn" onClick={() => setConfirming('rollback')} disabled={busy} data-global-rollback>
              Roll back
            </button>
          </p>
        )}
        {global.ready && (
          <span className="fine" role="status" data-global-status>
            {msg}
          </span>
        )}
      </div>
    </Section>
  )
}
