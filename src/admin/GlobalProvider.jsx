// Global voice provider (/admin/voice-providers): the provider every business without settings of its own follows.
// One card: the provider, its rollout state, who uses it, and the ONE next action for the current situation:
//   Choose provider (Change provider… → Review → Change, typed) → Test <provider> (a dry-run session on the customer
//   page of a test business; the server records the evidence) → Promote to 100% (checklist → one confirmation, typed)
//   → Rollout monitoring (records only) → Roll back (typed).
// Everything else (versions, counts by kind, verification record, test business, storage) sits under Advanced details.
// The server (server/voice/global.js) decides every state and checks the platform-admin list on every action; nothing
// here changes a session in progress, and the promotion stays all-or-nothing with rollback.
import { useState } from 'react'
import { api } from '../lib/api.js'
import { Badge, Facts, Section } from './control/ui.jsx'
import { when } from './control/lib.js'
import { BLOCKER } from '../dashboard/provider-control.js'
import { nextAction, ROLLOUT_STATE, rolloutState } from './rollout-state.js'

const MODE = { all: 'promoted to 100%', staged: 'staged rollout', rollback: 'rollback' }
const KIND = { inherited: 'follows the default', pin: 'still on the previous provider', override: 'business-specific settings' }
const PROMO = { promote: ['ok', 'Switches'], blocked: ['bad', 'Blocked'], excluded: ['neutral', 'Untouched'] }
const SWITCH = { switch: ['ok', 'Switches now'], pinned: ['warn', 'Stays (not verified)'], override: ['neutral', 'Untouched (business-specific)'] }
const WARN = { unverified: 'no test session of its own', booking_not_ready: 'cannot book yet (any provider)', receptionist_off: 'receptionist off' }
const NO_TEST = { no_test_business: 'No eligible test business: mark an active, bookable business as a test business in the console first.', not_configured: 'Not configured on the platform (credentials missing).', disabled: 'Switched off on the platform.', no_customer_path: 'No customer-facing voice path.' }
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 'es'}`
const usd = (micros) => (micros == null ? 'unavailable' : `$${(micros / 1e6).toFixed(micros < 100_000 ? 4 : 2)}`)
const num = (v) => (v == null ? 'unavailable' : String(v))

function TypedConfirm({ expected, title, children, action, busy, onConfirm, onCancel, disabled = false, kind, ...rest }) {
  const [typed, setTyped] = useState('')
  const ok = typed.trim().toLowerCase() === expected
  return (
    <div className="vp-card vp-card--confirm" role="group" aria-label="Confirm the global change" data-global-confirm={kind} {...rest}>
      <p className="vp-card-title">{title}</p>
      {children}
      <label className="field">
        <span>Type {expected} to confirm</span>
        <input type="text" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} aria-label="Type the provider id to confirm" placeholder={expected} />
      </label>
      <div className="vp-actions">
        <button type="button" className="btn btn-primary btn-sm" disabled={!ok || busy || disabled} onClick={onConfirm} data-global-confirm-action>
          {action}
        </button>
        <button type="button" className="btn btn-quiet btn-sm" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </div>
  )
}

export default function GlobalProvider({ global, reload, children }) {
  const [target, setTarget] = useState('')
  const [staging, setStaging] = useState(false) // "Change provider…" open
  const [check, setCheck] = useState(null)
  const [mode, setMode] = useState('staged')
  const [promo, setPromo] = useState(null) // the promotion checklist (null = not reviewed)
  const [includeOverrides, setIncludeOverrides] = useState(false)
  const [ack, setAck] = useState(false)
  const [confirming, setConfirming] = useState(null) // 'switch' | 'rollback'
  const [busy, setBusy] = useState(false)
  const [promoting, setPromoting] = useState(false)
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
  const closeAll = () => {
    setPromo(null)
    setAck(false)
    setConfirming(null)
    setStaging(false)
    setTarget('')
    setCheck(null)
  }
  const pick = (p) => {
    setTarget(p)
    setCheck(null)
    setConfirming(null)
  }
  const review = async () => {
    const { status, data } = await post({ action: 'global_check', provider: target })
    setCheck(status === 200 ? data.check : null)
    if (status !== 200) setMsg(`Couldn’t check (${data?.error || status}).`)
    else setMode(data.check.counts.pinned > 0 ? 'staged' : 'all')
  }
  const doSwitch = async () => {
    const { status, data } = await post({ action: 'global_switch', provider: target, confirmProvider: target, mode, confirm: true, version: cur.version })
    setConfirming(null)
    if (status === 200) {
      setMsg(`${targetName} is now the global default: ${data.applied.switched} switched, ${data.applied.pinned} stay on ${cur.name} until promoted, ${data.applied.overrides} business-specific untouched.`)
      closeAll()
      reload()
    } else {
      setMsg(data?.error === 'stale' ? 'Changed elsewhere; reloaded.' : data?.error === 'blocked' ? (data.reason === 'unverified_businesses' ? 'Some businesses are not verified: choose the staged rollout or verify them first.' : 'Blocked by a platform check; see the checklist.') : `Not changed (${data?.error || status}).`)
      if (data?.check) setCheck(data.check)
      if (data?.error === 'stale') reload()
    }
  }
  const reviewPromotion = async (include = includeOverrides) => {
    setConfirming(null)
    setStaging(false)
    const { status, data } = await post({ action: 'global_promote_check', includeOverrides: include })
    setPromo(status === 200 ? data.check : null)
    setAck(false)
    if (status !== 200) setMsg(`Couldn’t check the promotion (${data?.error || status}).`)
  }
  const toggleOverrides = (v) => {
    setIncludeOverrides(v)
    reviewPromotion(v)
  }
  const doPromote = async () => {
    setPromoting(true)
    const { status, data } = await post({ action: 'global_promote', provider: cur.provider, confirmProvider: cur.provider, includeOverrides, acknowledgeUnverified: ack, confirm: true, version: cur.version })
    setPromoting(false)
    if (status === 200) {
      const d = data.distribution.byProvider
      setMsg(`Promoted ${cur.name} to 100%: ${plural(data.applied.promoted, 'business')} promoted (${data.applied.pinsReleased} were still on the previous provider, ${data.applied.overridesReplaced} business-specific replaced), ${data.applied.excluded} untouched. Now: ${Object.entries(d).filter(([, n]) => n > 0).map(([p, n]) => `${nameOf(p)} ${n}`).join(' · ')}. Rollback is available.`)
      closeAll()
      reload()
    } else {
      setMsg(data?.error === 'stale' ? 'Changed elsewhere (a business or the default moved since the review); nothing applied. Reloaded.' : data?.error === 'blocked' ? 'Blocked; nothing applied.' : data?.error === 'acknowledgement_required' ? 'Acknowledge the untested businesses first; nothing applied.' : `Not promoted (${data?.error || status}).`)
      if (data?.check) setPromo(data.check)
      if (data?.error === 'stale') reload()
    }
  }
  const doRollback = async () => {
    const { status, data } = await post({ action: 'global_rollback', confirmProvider: cur.previous, confirm: true, version: cur.version })
    setConfirming(null)
    if (status === 200) {
      const u = data.undone
      const k = u.kept.length
      setMsg(`Rolled back to ${nameOf(data.global.current.provider)}: ${plural(u.unpinned, 'business')} follow the default again, ${u.moved} moved back, ${u.pinsRestored} put back on their previous provider, ${u.overridesRestored} business-specific settings restored${k ? `, ${k} kept where they are (${u.kept.map((x) => `${x.id}: ${x.reason}`).join(', ')})` : ''}.`)
      closeAll()
      reload()
    } else {
      setMsg(data?.error === 'stale' ? 'Changed elsewhere; reloaded.' : `Not rolled back (${data?.error || status}).`)
      if (data?.error === 'stale') reload()
    }
  }

  const state = rolloutState(global, { blocked: Boolean(promo && !promo.ok), promoting })
  const total = global.counts.total
  const remaining = total - global.counts.usingDefault
  const others = Object.entries(global.counts.byProvider || {})
    .filter(([p, n]) => p !== cur.provider && n > 0)
    .map(([p, n]) => `${n} still using ${nameOf(p)}`)
  const v = global.verification
  const t = global.testPage
  const r = global.rollout
  const monitorShown = Boolean(r) && cur.mode !== 'rollback' && (cur.mode === 'all' || cur.switched > 0)
  const next = nextAction(global, state)
  const promoReady = Boolean(promo?.ok) && promo.counts.promote > 0 && (promo.counts.unverified === 0 || ack)
  const open = Boolean(promo || staging || confirming)
  const rollbackConfirm = confirming === 'rollback' && (
    <TypedConfirm kind="rollback" expected={cur.previous || ''} title={`Roll back to ${nameOf(cur.previous)}?`} action="Roll back" busy={busy} onConfirm={doRollback} onCancel={() => setConfirming(null)}>
      <p className="fine">Businesses this rollout switched go back to {nameOf(cur.previous)}; businesses it released or replaced get their previous settings back, unless changed since (reported). Conversations in progress are not interrupted.</p>
    </TypedConfirm>
  )
  return (
    <>
      <Section title="Global voice provider" id="vp-global" data-global-provider={cur.provider} data-global-state={state}>
        <div className="cc-section-body">
          {!global.ready && <p className="cc-callout">Global default storage is not available yet (migration 0036). Every business follows Retell; nothing can be changed here.</p>}
          <div className="vp-hero" data-global-promotion data-global-promotion-pins={global.counts.pins}>
            <div className="vp-hero-head">
              <h3 className="vp-provider">{cur.name}</h3>
              <Badge tone={ROLLOUT_STATE[state][0]}>{ROLLOUT_STATE[state][1]}</Badge>
            </div>
            <p className="vp-line" data-global-counts>
              {cur.version && cur.mode === 'staged' ? `Staged for ${plural(total, 'business')}` : `Default for ${plural(total, 'business')}`} · {global.counts.usingDefault} of {total} using it{others.length ? ` · ${others.join(' · ')}` : ''}
            </p>
            {global.ready && state !== 'not_configured' && (
              <p className="vp-next" data-global-verification={v?.ok ? 'ok' : 'missing'}>
                {v?.ok ? `Verified on the production path: ${plural(v.finished, 'test session')}, last ${when(v.lastAt)}.` : remaining > 0 ? `Test ${cur.name} before switching businesses.` : `Every business uses ${cur.name}.`}
                {state === 'partial' ? ` ${plural(remaining, 'business')} with business-specific settings still use another provider.` : ''}
              </p>
            )}
            {state === 'not_configured' && <p className="vp-next">Add {cur.name} credentials on the platform before it can be tested or promoted.</p>}
            {global.ready && !open && (
              <div className="vp-actions">
                {next === 'test' && (t?.url ? (
                  <a className="btn btn-primary btn-sm" href={t.url} target="_blank" rel="noreferrer" data-global-test>
                    Test {cur.name}
                  </a>
                ) : (
                  <span className="fine" data-global-test-missing={t?.reason || 'unknown'}>{NO_TEST[t?.reason] || 'No test page is available.'}</span>
                ))}
                {next === 'promote' && (
                  <button type="button" className="btn btn-primary btn-sm" onClick={() => reviewPromotion()} disabled={busy} data-global-promote>
                    Promote to 100%
                  </button>
                )}
                {next === 'promote' && t?.url && (
                  <a className="btn btn-quiet btn-sm" href={t.url} target="_blank" rel="noreferrer" data-global-test>
                    Test again
                  </a>
                )}
                {state !== 'not_configured' && (
                  <button type="button" className="btn btn-quiet btn-sm" onClick={() => setStaging(true)} disabled={busy} data-global-stage>
                    Change provider…
                  </button>
                )}
                {cur.canRollBack && !monitorShown && (
                  <button type="button" className="link-btn" onClick={() => setConfirming('rollback')} disabled={busy} data-global-rollback>
                    Roll back to {nameOf(cur.previous)}
                  </button>
                )}
              </div>
            )}
            {next === 'test' && t?.url && !open && <p className="fine">Opens the customer chat page of {t.business.name} (a test business) in a new tab. Press the microphone, say hello, ask for available times, book one (dry run), end the call. Come back here: the result is read from the recorded session.</p>}
          </div>

          {promo && (
            <div className={`vp-card ${promo.ok ? 'vp-card--confirm' : 'vp-card--blocked'}`} role="group" aria-label="Promotion checklist" data-global-promote-check={promo.ok ? 'ok' : 'blocked'} data-global-confirm="promote">
              <p className="vp-card-title">
                {promo.ok ? (promo.summary.willChange > 0 ? `Ready to switch ${plural(promo.summary.willChange, 'business')} to ${cur.name}` : promo.counts.promote > 0 ? `Ready to promote ${cur.name}: ${plural(promo.counts.promote, 'business')} follow it from now on (already using it)` : `Nothing to promote: every business in scope already follows ${cur.name}`) : `Blocked: ${promo.summary.blocked > 0 ? `${plural(promo.summary.blocked, 'business')} need attention` : 'a platform check failed'}`}
              </p>
              <ul className="vp-list" data-global-promote-summary>
                <li>Target: {cur.name}</li>
                <li>
                  Businesses affected: {promo.counts.promote} of {promo.summary.total} ({promo.summary.willChange} change provider, {promo.summary.pinsToRelease} still on the previous provider, {promo.summary.overridesToReplace} business-specific replaced{promo.summary.overridesUntouched ? `, ${promo.summary.overridesUntouched} business-specific untouched` : ''}{promo.summary.suspended ? `, ${promo.summary.suspended} suspended excluded` : ''})
                </li>
                <li>Today: {Object.entries(global.counts.byProvider || {}).filter(([, n]) => n > 0).map(([p, n]) => `${nameOf(p)} ${n}`).join(' · ') || '—'}</li>
                <li>Blocked: {promo.summary.blocked}</li>
                <li>Rollback: available after the promotion</li>
              </ul>
              {promo.checks
                .filter((c) => !c.ok)
                .map((c) => (
                  <p key={c.id} className="fine">
                    <Badge tone="bad">Blocked</Badge> {c.note}
                  </p>
                ))}
              {promo.warnings.map((w) => (
                <p key={w.code} className="fine">
                  <Badge tone="warn">Warning</Badge> {w.note}
                </p>
              ))}
              {promo.ok && promo.checks.find((c) => c.id === 'verification')?.ok && <p className="fine">{promo.checks.find((c) => c.id === 'verification').note}</p>}
              {promo.ok && <p className="fine">New customer conversations of the switched businesses start on {cur.name}; conversations in progress finish on their provider. Telephone routing is unchanged. No automatic fallback: a session that cannot connect fails visibly. Provider behaviour and costs may differ. Rollback stays available.</p>}
              <details className="cc-details" open={!promo.ok || undefined}>
                <summary>Business by business ({promo.businesses.length})</summary>
                <table className="vp-history vp-table" data-global-promote-businesses>
                  <thead>
                    <tr>
                      <th scope="col">Business</th>
                      <th scope="col">Today</th>
                      <th scope="col">After</th>
                      <th scope="col">Notes</th>
                    </tr>
                  </thead>
                  <tbody>
                    {promo.businesses.map((b) => (
                      <tr key={b.id} data-global-promote-business={b.id} data-global-promote-status={b.status}>
                        <td>
                          {b.name} {b.test ? <Badge tone="neutral">Test</Badge> : null}
                        </td>
                        <td>
                          {nameOf(b.provider)} <span className="fine">({KIND[b.kind] || b.kind})</span>
                        </td>
                        <td>
                          <Badge tone={PROMO[b.status][0]}>{PROMO[b.status][1]}</Badge>
                        </td>
                        <td className="fine">{[...b.blockers.map((x) => BLOCKER[x] || x), ...b.warnings.map((w) => WARN[w] || w), b.status === 'excluded' ? (b.reason === 'suspended' ? 'suspended' : 'not included') : ''].filter(Boolean).join(', ') || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <details className="cc-details">
                  <summary>What promoting does</summary>
                  <ul className="vp-list">
                    {promo.consequences.map((c) => (
                      <li key={c}>{c}</li>
                    ))}
                  </ul>
                </details>
              </details>
              {global.counts.independent > 0 && (
                <label className="check">
                  <input type="checkbox" checked={includeOverrides} onChange={(e) => toggleOverrides(e.target.checked)} disabled={busy} data-global-promote-overrides />
                  <span>Also switch the {plural(global.counts.independent, 'business')} with business-specific settings (their provider is kept for rollback)</span>
                </label>
              )}
              {promo.ok && promo.counts.unverified > 0 && (
                <label className="check">
                  <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} disabled={busy} data-global-promote-ack />
                  <span>I understand {plural(promo.counts.unverified, 'business')} {promo.counts.unverified === 1 ? 'has' : 'have'} no finished {cur.name} test session of {promo.counts.unverified === 1 ? 'its' : 'their'} own. The provider-level production-path test and the automated compatibility checks passed; none of them is reported as individually tested.</span>
                </label>
              )}
              {promo.ok ? (
                <TypedConfirmInline expected={cur.provider} action="Promote to 100%" busy={busy} disabled={!promoReady} onConfirm={doPromote} onCancel={closeAll} />
              ) : (
                <div className="vp-actions">
                  <button type="button" className="btn btn-quiet btn-sm" onClick={() => reviewPromotion()} disabled={busy}>
                    Check again
                  </button>
                  <button type="button" className="btn btn-quiet btn-sm" onClick={closeAll} disabled={busy}>
                    Close
                  </button>
                </div>
              )}
            </div>
          )}

          {staging && !confirming && (
            <div className="vp-card" role="group" aria-label="Change the global provider" data-global-staging>
              <p className="vp-card-title">Change the global provider</p>
              <label className="field">
                <span>New default</span>
                <select value={target} onChange={(e) => pick(e.target.value)} aria-label="Global provider" disabled={busy} data-global-target>
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
              <div className="vp-actions">
                <button type="button" className="btn btn-quiet btn-sm" onClick={review} disabled={busy || !target} data-global-review>
                  Review businesses
                </button>
                <button type="button" className="btn btn-primary btn-sm" onClick={() => setConfirming('switch')} disabled={busy || !check?.ok || (mode === 'all' && check.counts.pinned > 0)} data-global-change>
                  Change default…
                </button>
                <button type="button" className="btn btn-quiet btn-sm" onClick={closeAll} disabled={busy}>
                  Cancel
                </button>
              </div>
              {check && (
                <div className="vp-stack" aria-label="Global checklist" data-global-check={check.ok ? 'ok' : 'blocked'}>
                  {check.checks
                    .filter((c) => !c.ok)
                    .map((c) => (
                      <p key={c.id} className="fine">
                        <Badge tone="bad">Blocked</Badge> {c.note}
                      </p>
                    ))}
                  {check.ok && (
                    <>
                      <p className="fine">
                        <strong>
                          {plural(check.counts.switch, 'business')} switch now · {plural(check.counts.pinned, 'business')} stay on {cur.name} until tested or promoted · {plural(check.counts.overrides, 'business')} with business-specific settings untouched.
                        </strong>
                      </p>
                      <fieldset className="ui-group" disabled={busy}>
                        <legend>How to apply it</legend>
                        <label className="check">
                          <input type="radio" name="global-mode" checked={mode === 'all'} onChange={() => setMode('all')} disabled={check.counts.pinned > 0} />
                          <span>All at once{check.counts.pinned > 0 ? ` (not possible: ${plural(check.counts.pinned, 'business')} not verified)` : ' (every business verified)'}</span>
                        </label>
                        <label className="check">
                          <input type="radio" name="global-mode" checked={mode === 'staged'} onChange={() => setMode('staged')} />
                          <span>Staged: verified businesses switch now, the others stay on {cur.name} until you test {targetName} and promote it to 100%.</span>
                        </label>
                      </fieldset>
                      <details className="cc-details">
                        <summary>Business by business ({check.businesses.length})</summary>
                        <table className="vp-history vp-table" data-global-businesses>
                          <thead>
                            <tr>
                              <th scope="col">Business</th>
                              <th scope="col">Today</th>
                              <th scope="col">After</th>
                              <th scope="col">Notes</th>
                            </tr>
                          </thead>
                          <tbody>
                            {check.businesses.map((b) => (
                              <tr key={b.id} data-global-business={b.id} data-global-status={b.status}>
                                <td>
                                  {b.name} {b.test ? <Badge tone="neutral">Test</Badge> : null}
                                </td>
                                <td>
                                  {nameOf(b.provider)} <span className="fine">({b.inherited ? 'follows the default' : 'business-specific'})</span>
                                </td>
                                <td>
                                  <Badge tone={SWITCH[b.status][0]}>{SWITCH[b.status][1]}</Badge>
                                </td>
                                <td className="fine">{[...b.blockers.map((x) => BLOCKER[x] || x), b.receptionist ? '' : 'receptionist off'].filter(Boolean).join(', ') || '—'}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                        <details className="cc-details">
                          <summary>What changing the default does</summary>
                          <ul className="vp-list">
                            {check.consequences.map((c) => (
                              <li key={c}>{c}</li>
                            ))}
                          </ul>
                        </details>
                      </details>
                    </>
                  )}
                </div>
              )}
            </div>
          )}

          {confirming === 'switch' && (
            <TypedConfirm kind="switch" expected={target} title={`Change the global default to ${targetName} (${mode === 'all' ? 'all businesses at once' : 'staged rollout'})?`} action={`Change the default to ${targetName}`} busy={busy} onConfirm={doSwitch} onCancel={() => setConfirming(null)}>
              <p className="fine">
                {plural(check?.counts.switch || 0, 'business')} switch now; {plural(check?.counts.pinned || 0, 'business')} stay on {cur.name}; {plural(check?.counts.overrides || 0, 'business')} with business-specific settings are untouched. Conversations in progress are not interrupted.
              </p>
            </TypedConfirm>
          )}
          {!monitorShown && rollbackConfirm}

          {global.ready && (
            <details className="cc-details" data-global-advanced>
              <summary>Advanced details</summary>
              <Facts
                items={[
                  ['Version', cur.version ? `${cur.version} (${MODE[cur.mode] || cur.mode}, set ${when(cur.setAt)})` : 'initial default, never changed'],
                  ['Previous default', cur.previous ? nameOf(cur.previous) : '—'],
                  ['Rollback', cur.canRollBack ? `available (back to ${nameOf(cur.previous)})` : 'not available'],
                  ['Last rollout', cur.version ? `${cur.switched} switched, ${cur.pinned} kept on the previous provider` : 'none'],
                  ['Following the default', `${global.counts.inherited} of ${total}`],
                  ['Still on the previous provider (rollout)', String(global.counts.pins)],
                  ['Business-specific settings', String(global.counts.independent)],
                  ['By provider', Object.entries(global.counts.byProvider || {}).map(([p, n]) => `${nameOf(p)} ${n}`).join(' · ') || '—'],
                  ['Verification record', v ? (v.ok ? `${v.finished} finished production-path session(s) on ${v.businesses.join(', ')}, last ${when(v.lastAt)}` : `${v.finished} finished, ${v.sessions} started; missing: ${v.missing.join(', ')}`) : 'unavailable'],
                  ['Test business', t?.business ? `${t.business.name} (${t.business.id})${t.business.receptionist ? '' : ', receptionist off for customers'}` : NO_TEST[t?.reason] || 'none'],
                  r && !monitorShown ? ['Rollout status', `${nameOf(r.provider)} since ${when(r.since)}: ${r.sessions == null ? 'no session records' : `${r.sessions} sessions, ${num(r.connectionFailures)} connection failures, ${num(r.bookingFailures)} booking failures`}`] : null,
                ]}
              />
            </details>
          )}
          {global.ready && (
            <span className="fine" role="status" data-global-status>
              {msg}
            </span>
          )}
        </div>
      </Section>
      {children}
      {monitorShown && (
        <Section title="Rollout monitoring" id="vp-rollout" data-global-rollout={r.provider}>
          <div className="cc-section-body">
            <Facts
              items={[
                ['Provider', `${nameOf(r.provider)} (${MODE[r.mode] || r.mode}, since ${when(r.since)})`],
                ['Businesses switched', `${cur.switched} by this rollout · ${global.counts.usingDefault} of ${total} using it now`],
                ['Sessions', r.sessions == null ? 'unavailable' : `${r.sessions} (${r.finished} finished, ${r.inProgress} in progress) on ${plural(r.businesses, 'business')}${r.truncated ? ', newest 500 counted' : ''}`],
                ['Connection failures', num(r.connectionFailures)],
                ['Booking failures', `${num(r.bookingFailures)}${r.bookings != null ? ` (${r.bookings} booked)` : ''}`],
                ['Tool failures', num(r.toolFailures)],
                ['Usage and estimated cost', r.minutes == null ? 'unavailable' : `${r.minutes} min · ${usd(r.estimatedMicros)}`],
              ]}
            />
            {cur.canRollBack && !confirming && (
              <div className="vp-actions">
                <button type="button" className="btn btn-quiet btn-sm" onClick={() => setConfirming('rollback')} disabled={busy} data-global-rollback>
                  Roll back to {nameOf(cur.previous)}
                </button>
              </div>
            )}
            {rollbackConfirm}
          </div>
        </Section>
      )}
    </>
  )
}

// The typed confirmation inside the promotion card (same rule: the provider id typed back, one action).
function TypedConfirmInline({ expected, action, busy, disabled, onConfirm, onCancel }) {
  const [typed, setTyped] = useState('')
  const ok = typed.trim().toLowerCase() === expected
  return (
    <>
      <label className="field">
        <span>Type {expected} to confirm</span>
        <input type="text" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} aria-label="Type the provider id to confirm" placeholder={expected} />
      </label>
      <div className="vp-actions">
        <button type="button" className="btn btn-primary btn-sm" disabled={!ok || busy || disabled} onClick={onConfirm} data-global-confirm-action>
          {action}
        </button>
        <button type="button" className="btn btn-quiet btn-sm" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </>
  )
}
