// /admin/control — QA & Account Operations Control Center (platform admins; every request is authorized server-side).
// Exceptions first: incidents, affected businesses, accounts needing help, integration health, next actions; then the
// Account Inspector (readiness, journey, incidents, history, customer view) for one business. Counts and codes only.
import { lazy, Suspense, useCallback, useEffect, useState } from 'react'
import { api, fmt } from '../lib/api.js'

const Qa = lazy(() => import('./Qa.jsx'))

const when = (ms) => (ms ? fmt(new Date(ms).toISOString(), undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—')
const SEV_TAG = { critical: 'tag--bad', high: 'tag--bad', medium: 'tag--warn', low: 'tag--info' }
const STEP_TAG = { completed: 'tag--ok', current: 'tag--info', blocked: 'tag--warn', failed: 'tag--bad', skipped: '', unknown: '' }
const STEP_LABEL = { completed: 'Done', current: 'Current', blocked: 'Blocked', failed: 'Failed', skipped: 'Skipped', unknown: 'Unknown' }
const CAUSE_LABEL = { confirmed: 'Cause confirmed', suspected: 'Cause suspected', unknown: 'Cause unknown' }
const RESOLUTION = { success_seen: 'Recovered (success seen)', connected: 'Recovered (calendar connected)', no_new_failures: 'No new failures in the window', not_applicable: 'Closed' }
const READY = (ok) => <span className={`tag ${ok ? 'tag--ok' : 'tag--bad'}`}>{ok ? 'Ready' : 'Not ready'}</span>

function useQueryParam(name) {
  const read = () => new URLSearchParams(window.location.search).get(name)
  const [value, setValue] = useState(read)
  useEffect(() => {
    const onPop = () => setValue(read())
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  })
  const set = useCallback(
    (v) => {
      const p = new URLSearchParams(window.location.search)
      if (v) p.set(name, v)
      else p.delete(name)
      window.history.pushState(null, '', `${window.location.pathname}${p.toString() ? `?${p}` : ''}`)
      setValue(v)
    },
    [name],
  )
  return [value, set]
}

function Incident({ i, onOpen }) {
  return (
    <li className="row cc-incident" data-incident={i.id} data-kind={i.kind} data-status={i.status}>
      <div className="row-main">
        <p className="row-title">
          <span className={`tag ${SEV_TAG[i.severity]}`}>{i.severity}</span> {i.impact}
          {i.test && <span className="tag"> Test</span>}
        </p>
        <p className="row-sub">
          {i.businessName || i.customer || 'Platform'} · {i.feature} · {i.journey}/{i.step} · code <code>{i.code}</code> · {i.occurrences}× · first {when(i.firstSeen)} · last {when(i.lastSeen)}
        </p>
        <p className="row-sub">
          {CAUSE_LABEL[i.cause]}
          {i.causeNote ? `: ${i.causeNote}` : ''}
        </p>
        {i.status === 'open' ? <p className="row-sub">Next: {i.recovery}</p> : <p className="row-sub">{RESOLUTION[i.resolution] || i.resolution} · {when(i.resolvedAt)}</p>}
        <details>
          <summary className="fine">Evidence</summary>
          <pre className="cc-evidence">{JSON.stringify(i.evidence, null, 1)}</pre>
        </details>
      </div>
      {i.customer && onOpen && (
        <button type="button" className="link-btn" onClick={() => onOpen(i.customer)}>
          Open account
        </button>
      )}
    </li>
  )
}

function Stat({ label, value, bad }) {
  return (
    <div className="stat">
      <p className={`stat-value${bad ? ' bad' : ''}`}>{value}</p>
      <p className="stat-label">{label}</p>
    </div>
  )
}

function Overview({ o, onOpen, onQa }) {
  const problems = o.integrations.filter((c) => ['failing', 'degraded', 'unknown'].includes(c.health))
  return (
    <div className="stack-lg">
      <div className="stats" aria-label="Summary">
        <Stat label="Critical incidents" value={o.incidents.critical} bad={o.incidents.critical > 0} />
        <Stat label="Open incidents" value={o.incidents.open} bad={o.incidents.open > 0} />
        <Stat label="Affected businesses" value={o.affectedBusinesses.length} />
        <Stat label="Accounts needing help" value={o.assistance.length} />
        <Stat label="Resolved (7 days)" value={o.incidents.resolved7d} />
      </div>
      <section className="card" aria-labelledby="cc-next">
        <h2 id="cc-next" className="card-title">Recommended next actions</h2>
        {o.nextActions.length ? (
          <ol className="rows">
            {o.nextActions.map((a, k) => (
              <li key={k} className="row">
                <div className="row-main">
                  <p className="row-title">{a.text}</p>
                  {a.customer && <p className="row-sub">{a.customer}</p>}
                </div>
                {a.customer && (
                  <button type="button" className="link-btn" onClick={() => onOpen(a.customer)}>
                    Open account
                  </button>
                )}
              </li>
            ))}
          </ol>
        ) : (
          <p className="empty">Nothing needs action.</p>
        )}
      </section>
      <section className="card" aria-labelledby="cc-open">
        <h2 id="cc-open" className="card-title">Open incidents</h2>
        {o.incidents.list.length ? (
          <ul className="rows">
            {o.incidents.list.map((i) => (
              <Incident key={i.id} i={i} onOpen={onOpen} />
            ))}
          </ul>
        ) : (
          <p className="empty">No open incidents.</p>
        )}
        {o.incidents.openTest > 0 && <p className="fine">{o.incidents.openTest} of these are on test businesses (not customer impact).</p>}
      </section>
      <section className="card" aria-labelledby="cc-assist">
        <h2 id="cc-assist" className="card-title">Accounts needing assistance</h2>
        {o.assistance.length ? (
          <ul className="rows">
            {o.assistance.map((a) => (
              <li key={a.id} className="row">
                <div className="row-main">
                  <p className="row-title">{a.name}</p>
                  <p className="row-sub">{a.actions.join(' ') || a.attention.join(', ')}</p>
                </div>
                <button type="button" className="link-btn" onClick={() => onOpen(a.id)}>
                  Open account
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="empty">No account needs help right now.</p>
        )}
      </section>
      <section className="card" aria-labelledby="cc-int">
        <h2 id="cc-int" className="card-title">Integration health</h2>
        <ul className="rows">
          {(problems.length ? problems : o.integrations).map((c) => (
            <li key={c.id} className="row" data-capability={c.id}>
              <div className="row-main">
                <p className="row-title">{c.name}</p>
                <p className="row-sub">
                  {c.external} · {c.status} · {c.health}
                </p>
              </div>
            </li>
          ))}
        </ul>
        {!problems.length && <p className="fine">No integration is failing.</p>}
      </section>
      <section className="card" aria-labelledby="cc-qa">
        <h2 id="cc-qa" className="card-title">Test runs and activation</h2>
        {!o.qa ? (
          <p className="empty">QA history isn’t available yet.</p>
        ) : (
          <>
            {o.qa.failedJourneys.length > 0 && <p className="bad">Failing journeys (latest automated result): {o.qa.failedJourneys.join(', ')}</p>}
            <p className="fine" data-overview-qa>
              Latest automated run: {o.qa.automated[0] ? `${o.qa.automated[0].status} · ${when(o.qa.automated[0].startedAt)} · ${o.qa.automated[0].provider === 'real' ? 'real provider' : 'mocked providers'}` : 'none recorded'}
            </p>
            <p className="fine" data-overview-activation={o.activation?.measured ? 'measured' : 'not-measured'}>
              Activation: {o.activation?.measured ? `${o.activation.latest.totalMinutes} min in the latest observer-recorded run (target 20)` : 'not measured yet (no real-person run recorded)'}
            </p>
          </>
        )}
        {onQa && (
          <button type="button" className="link-btn" onClick={onQa}>
            Open QA
          </button>
        )}
      </section>
      <FounderAlerts />
      {o.incidents.recentlyResolved.length > 0 && (
        <section className="card" aria-labelledby="cc-res">
          <h2 id="cc-res" className="card-title">Recently resolved</h2>
          <ul className="rows">
            {o.incidents.recentlyResolved.map((i) => (
              <Incident key={i.id} i={i} onOpen={onOpen} />
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}

// Founder alert delivery: the switch, how many admins would receive mail now (counts only), and a controlled test
// email through the real outbox + launch gate + provider (only while alerts are on; confirmed; rate-limited).
const TEST_REFUSED = {
  alerts_disabled: 'Founder alerts are off (FOUNDER_ALERTS_ENABLED).',
  no_recipient: 'No platform admin is on the test-recipient list, so nothing can be delivered.',
  email_not_configured: 'Email delivery is not configured.',
  too_soon: 'A test was sent in the last 10 minutes.',
}
function FounderAlerts() {
  const [s, setS] = useState(null)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState(null)
  useEffect(() => {
    let live = true
    api('/api/platform/alerts').then(({ status, data }) => live && setS(status === 200 ? data : { error: data.error || 'failed' }))
    return () => {
      live = false
    }
  }, [result])
  const send = async () => {
    setBusy(true)
    const { status, data } = await api('/api/platform/alerts', { method: 'POST', body: { action: 'test', confirm: true } })
    setBusy(false)
    setConfirming(false)
    setResult(status === 200 ? { ...data, code: data.ok ? 'sent' : 'not_sent' } : { code: data.error || 'failed' })
  }
  return (
    <section className="card" aria-labelledby="cc-alerts" data-alerts={s?.enabled ? 'on' : 'off'}>
      <h2 id="cc-alerts" className="card-title">Founder alerts</h2>
      {!s ? (
        <p aria-busy="true">Loading…</p>
      ) : s.error ? (
        <p className="fine">Alert status isn’t available ({s.error}).</p>
      ) : (
        <>
          <p className="fine">
            {s.enabled ? 'On' : 'Off'} · {s.deliverable} of {s.admins} admin{s.admins === 1 ? '' : 's'} would receive alerts now
            {s.held ? ` (${s.held} not on the test-recipient list)` : ''}
            {s.last ? ` · last alert ${when(s.last.at)} (${s.last.status}${s.last.error ? `: ${s.last.error}` : ''})` : ' · no alert sent yet'}
          </p>
          {s.enabled && !confirming && (
            <button type="button" className="btn btn-ghost" onClick={() => setConfirming(true)} disabled={busy}>
              Send test alert
            </button>
          )}
          {confirming && (
            <p className="fine">
              Send one test email to {s.deliverable} admin{s.deliverable === 1 ? '' : 's'} now?{' '}
              <button type="button" className="btn btn-primary" onClick={send} disabled={busy}>
                {busy ? 'Sending…' : 'Send test email'}
              </button>{' '}
              <button type="button" className="link-btn" onClick={() => setConfirming(false)} disabled={busy}>
                Cancel
              </button>
            </p>
          )}
        </>
      )}
      <p className="fine" role="status" aria-live="polite" data-alert-test={result?.code || ''}>
        {result?.code === 'sent' && `Test sent to ${result.sent} admin${result.sent === 1 ? '' : 's'}${result.notSent ? `; ${result.notSent} not sent (${result.errors.join(', ')})` : ''}.`}
        {result?.code === 'not_sent' && `Not delivered (${result.errors.join(', ') || 'unknown'}).`}
        {result && !['sent', 'not_sent'].includes(result.code) && (TEST_REFUSED[result.code] || `Couldn’t send (${result.code}).`)}
      </p>
    </section>
  )
}

function Facts({ items }) {
  return (
    <dl className="cap-facts">
      {items.filter(Boolean).map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  )
}

function Account({ id, onBack }) {
  const [a, setA] = useState(null)
  const [diag, setDiag] = useState(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let live = true
    api(`/api/platform/inspector?business=${encodeURIComponent(id)}`).then(({ status, data }) => live && setA(status === 200 ? data : { error: data.error || 'failed' }))
    return () => {
      live = false
    }
  }, [id])
  const diagnose = async () => {
    setBusy(true)
    const { status, data } = await api('/api/platform/inspector', { method: 'POST', body: { business: id, check: 'calendar' } })
    setBusy(false)
    setDiag(status === 200 ? data : { error: status === 429 ? 'Too many checks; try again in a few minutes.' : 'Check failed.' })
  }
  if (!a) return <p aria-busy="true">Loading account…</p>
  if (a.error) return <p className="form-error" role="alert">Couldn’t load this account ({a.error}).</p>
  const open = a.incidents.filter((i) => i.status === 'open')
  return (
    <div className="stack-lg" data-account={id}>
      <button type="button" className="link-btn" onClick={onBack}>
        ← All accounts
      </button>
      <div className="page-head">
        <h2 className="title title--page">
          {a.identity.name} {a.identity.test && <span className="tag">Test</span>}
        </h2>
        <p className="fine">
          {a.identity.id} · {a.identity.status} · created {when(a.identity.createdAt)} · journey: {a.journey.type.primary}
          {a.journey.type.incomplete ? ' · setup incomplete' : ''}
          {a.journey.type.recovery ? ' · integration recovery' : ''}
        </p>
      </div>
      <section className="card" aria-labelledby="ai-ready">
        <h3 id="ai-ready" className="card-title">Readiness</h3>
        <Facts
          items={[
            ['Booking', <>{READY(a.booking.ready)} {a.booking.reasons.join(', ')}</>],
            ['Calendar', <>{READY(a.calendar.connected)} {a.calendar.lastLookup ? `last lookup ${a.calendar.lastLookup.outcome} ${when(a.calendar.lastLookup.at)}` : 'no lookup recorded'}</>],
            ['Website', `${a.website.live ? 'Published' : 'Not published'} · hosting ${a.website.hosting}${a.website.domain ? ` · domain ${a.website.domain}` : ''}`],
            ['Messages', `${a.communications.gate === 'live' ? 'Live' : 'Test recipients only'} · 7 days: ${a.communications.sent7} sent, ${a.communications.failed7} failed, ${a.communications.skipped7} skipped`],
            ['Voice', `${a.voice.status}${a.voice.receptionist ? ' · receptionist on' : ' · receptionist off'}`],
            ['Billing', `${a.billing.selfServe ? 'Self-serve' : 'Not billed (pilot/invited)'} · ${a.billing.state}${a.billing.lifecycle?.stage ? ` · ${a.billing.lifecycle.stage}` : ''}${a.billing.liveBilling ? '' : ' · live billing off'}`],
          ]}
        />
        <button type="button" className="btn btn-ghost" onClick={diagnose} disabled={busy}>
          {busy ? 'Checking calendar…' : 'Diagnose calendar (read-only)'}
        </button>
        <p className="fine" role="status" aria-live="polite" data-diagnosis={diag?.code || ''}>
          {diag && (diag.error ? diag.error : `${diag.ok ? 'Calendar lookup works' : 'Calendar lookup failed'}: ${diag.code}${diag.openTimes != null ? ` · ${diag.openTimes} open times` : ''} · ${diag.ms} ms`)}
        </p>
      </section>
      <section className="card" aria-labelledby="ai-journey">
        <h3 id="ai-journey" className="card-title">Journey: {a.journey.title}</h3>
        <ol className="cc-steps">
          {a.journey.steps.map((s) => (
            <li key={s.id} data-step={s.id} data-state={s.state}>
              <span className={`tag ${STEP_TAG[s.state]}`}>{STEP_LABEL[s.state]}</span> {s.title}
              {s.reason && <span className="fine"> · {s.reason}</span>}
            </li>
          ))}
        </ol>
      </section>
      <section className="card" aria-labelledby="ai-inc">
        <h3 id="ai-inc" className="card-title">Incidents ({open.length} open)</h3>
        {a.incidents.length ? (
          <ul className="rows">
            {a.incidents.map((i) => (
              <Incident key={i.id} i={i} />
            ))}
          </ul>
        ) : (
          <p className="empty">No incidents recorded.</p>
        )}
      </section>
      <section className="card" aria-labelledby="ai-view">
        <h3 id="ai-view" className="card-title">What the owner and customers see</h3>
        <ul className="cc-steps">
          {a.customerView.ownerChecklist.map((s) => (
            <li key={s.id}>
              <span className={`tag ${s.done ? 'tag--ok' : ''}`}>{s.done ? 'Done' : 'To do'}</span> {s.title}
            </li>
          ))}
        </ul>
        <p className="fine">
          Public pages:{' '}
          {a.customerView.publicPages.length
            ? a.customerView.publicPages.map((p, k) => (
                <span key={p.href}>
                  {k > 0 && ' · '}
                  <a href={p.href} target="_blank" rel="noreferrer">
                    {p.label}
                  </a>
                </span>
              ))
            : 'none live'}
        </p>
      </section>
      <section className="card" aria-labelledby="ai-hist">
        <h3 id="ai-hist" className="card-title">Recent operational history</h3>
        {a.history.length ? (
          <ul className="rows">
            {a.history.map((h, k) => (
              <li key={k} className="row">
                <div className="row-main">
                  <p className="row-title">
                    {h.action} <span className={`tag ${h.outcome === 'failure' ? 'tag--bad' : ''}`}>{h.outcome}</span>
                  </p>
                  <p className="row-sub">
                    {when(h.at)} · {h.capability || '—'}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="empty">No recorded events.</p>
        )}
      </section>
    </div>
  )
}

export default function Control() {
  const [o, setO] = useState(null)
  const [business, setBusiness] = useQueryParam('business')
  const [view, setView] = useQueryParam('view')
  useEffect(() => {
    if (business || view === 'qa') return
    let live = true
    api('/api/platform/control').then(({ status, data }) => live && setO(status === 200 ? data : { error: true }))
    return () => {
      live = false
    }
  }, [business, view])
  return (
    <div className="stack-lg">
      <div className="page-head">
        <h1 className="title title--page">Control Center</h1>
        <p className="fine">Customer-impacting failures, accounts that need help, and where each customer is in their journey. Built from records; nothing here changes a customer’s account.</p>
      </div>
      {!business && (
        <div className="seg cc-views" role="group" aria-label="Control Center view">
          <button type="button" className={view !== 'qa' ? 'seg-on' : ''} aria-pressed={view !== 'qa'} onClick={() => setView(null)}>
            Overview
          </button>
          <button type="button" className={view === 'qa' ? 'seg-on' : ''} aria-pressed={view === 'qa'} onClick={() => setView('qa')}>
            QA
          </button>
        </div>
      )}
      {!business && view === 'qa' ? (
        <Suspense fallback={<p aria-busy="true">Loading QA…</p>}>
          <Qa initialJourney={new URLSearchParams(window.location.search).get('journey')} />
        </Suspense>
      ) : business ? (
        <Account key={business} id={business} onBack={() => setBusiness(null)} />
      ) : !o ? (
        <p aria-busy="true">Loading…</p>
      ) : o.error ? (
        <p className="form-error" role="alert">Couldn’t load the Control Center.</p>
      ) : (
        <>
          <Overview o={o} onOpen={setBusiness} onQa={() => setView('qa')} />
          <section className="card" aria-labelledby="cc-acc">
            <h2 id="cc-acc" className="card-title">All accounts</h2>
            <ul className="rows">
              {o.businesses.map((b) => (
                <li key={b.id} className="row">
                  <div className="row-main">
                    <p className="row-title">
                      {b.name} {b.test && <span className="tag">Test</span>}
                    </p>
                    <p className="row-sub">
                      {b.id} · {b.onboarding}
                      {b.attention?.length ? ` · ${b.attention.join(', ')}` : ''}
                    </p>
                  </div>
                  <button type="button" className="link-btn" onClick={() => setBusiness(b.id)} aria-label={`Open ${b.name}`}>
                    Open account
                  </button>
                </li>
              ))}
            </ul>
          </section>
        </>
      )}
    </div>
  )
}
