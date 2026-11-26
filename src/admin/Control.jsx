// /admin/control — the Control Center (platform admins; every request is authorized server-side).
// Overview answers: what's broken, who is affected, what to do next. Then Incidents, Accounts, Integrations and
// Testing, each one click from the side navigation. Every screen is a URL (?view=…, ?incident=…, ?business=…,
// ?integration=…, ?session=…, ?run=…), so Back, deep links and new tabs work. Read-only except guided-QA records,
// the read-only calendar diagnosis and the founder-alert test (each confirmed, rate-limited and audited).
import { Suspense, useEffect, useState } from 'react'
import { lazyPage } from '../lib/lazy.js'
import { api } from '../lib/api.js'
import { Badge, Empty, Link, LoadError, Loading, PageHead, Section, Severity, TestTag } from './control/ui.jsx'
import { ago, plural, useLocation, when } from './control/lib.js'
import { IncidentDetail, IncidentRow, IncidentsList } from './control/Incidents.jsx'
import { AccountInspector, AccountsList } from './control/Accounts.jsx'
import { IntegrationDetail, IntegrationsList } from './control/Integrations.jsx'
import './control.css'

const Testing = lazyPage(() => import('./Qa.jsx'))
const Session = lazyPage(() => import('./Qa.jsx').then((m) => ({ default: m.Session })))
const RunReview = lazyPage(() => import('./Qa.jsx').then((m) => ({ default: m.RunReview })))

// ---------- Overview ----------
function Banner({ o }) {
  const act = o.attention.filter((a) => a.action === 'act')
  const watch = o.attention.filter((a) => a.action !== 'act')
  const tone = o.incidents.critical > 0 ? 'bad' : act.length ? 'warn' : watch.length ? 'neutral' : 'ok'
  const title = act.length ? `${plural(act.length, 'item needs', 'items need')} action` : watch.length ? `Nothing urgent · ${plural(watch.length, 'item')} to watch` : 'Nothing needs your attention'
  const sub = act.length
    ? `To act on: ${act.map((a) => (a.kind === 'account' ? `${a.businessName} (${a.title.toLowerCase()})` : a.title)).slice(0, 3).join('; ')}${act.length > 3 ? '…' : ''}.${watch.length ? ` Also watching ${plural(watch.length, 'item')}.` : ''}`
    : watch.length
      ? 'Open items have no recorded customer impact. Each one says why it is being watched.'
      : 'No open incidents and no account flagged. This reflects recorded evidence only.'
  return (
    <div className={`cc-banner cc-banner--${tone}`} role="status" data-overview-status={tone}>
      <span className="cc-banner-dot" aria-hidden="true" />
      <div>
        <strong>{title}</strong>
        <span>{sub}</span>
      </div>
    </div>
  )
}

function Metric({ label, value, to, go, bad, hint }) {
  const body = (
    <>
      <b>{value}</b>
      <span>{label}</span>
      {to && hint && <small>{hint}</small>}
    </>
  )
  return to ? (
    <Link to={to} go={go} className={`cc-metric${bad ? ' cc-metric--bad' : ''}`} data-metric={label}>
      {body}
    </Link>
  ) : (
    <div className={`cc-metric${bad ? ' cc-metric--bad' : ''}`} data-metric={label}>
      {body}
    </div>
  )
}

function AttentionItem({ a, go }) {
  const to = a.kind === 'incident' ? { incident: a.id } : { business: a.id }
  return (
    <li>
      <Link to={to} go={go} className="cc-item" data-attention={a.kind} data-triage={a.action} data-incident={a.kind === 'incident' ? a.id : undefined}>
        <span className="cc-item-main">
          <span className="cc-item-title">
            {a.title}
            {a.test && <TestTag />}
          </span>
          <span className="cc-item-sub">
            {a.scope === 'platform' ? 'Platform-wide' : a.businessName || a.customer}
            {a.impact ? ` · ${a.impact}` : ''}
          </span>
          <span className="cc-item-sub">
            <strong>{a.action === 'act' ? 'Next: ' : 'Watching: '}</strong>
            {a.action === 'act' ? a.next : a.why}
          </span>
        </span>
        <span className="cc-item-meta">
          {a.kind === 'incident' ? <Severity s={a.severity} /> : <Badge tone="warn">Account</Badge>}
          {a.phaseLabel && <Badge tone={a.phaseTone}>{a.phaseLabel}</Badge>}
          <Badge tone={a.action === 'act' ? 'bad' : 'neutral'} plain>
            {a.action === 'act' ? 'Act now' : 'Monitor'}
          </Badge>
          <span className="cc-chev" aria-hidden="true">
            ›
          </span>
        </span>
      </Link>
    </li>
  )
}

const ALERT_REFUSED = {
  alerts_disabled: 'Founder alerts are off (FOUNDER_ALERTS_ENABLED).',
  no_recipient: 'No platform admin is on the test-recipient list, so nothing can be delivered.',
  email_not_configured: 'Email delivery is not configured.',
  too_soon: 'A test was sent in the last 10 minutes.',
}
// Founder alert delivery: the switch, how many admins would receive mail now (counts only), and a controlled test
// email through the real outbox + launch gate + provider (only while alerts are on; confirmed; rate-limited).
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
    <Section title="Founder alerts" id="cc-alerts" data-alerts={s?.enabled ? 'on' : 'off'}>
      <div className="cc-section-body">
        {!s ? (
          <Loading />
        ) : s.error ? (
          <p className="cc-status-line">Alert status isn’t available.</p>
        ) : (
          <>
            <p className="cc-status-line">
              <Badge tone={s.enabled ? 'ok' : 'neutral'}>{s.enabled ? 'On' : 'Off'}</Badge> {s.deliverable} of {plural(s.admins, 'admin')} would receive alerts now
              {s.held ? ` (${s.held} not on the test-recipient list)` : ''}. {s.last ? `Last alert ${when(s.last.at)} (${s.last.status}).` : 'No alert sent yet.'}
            </p>
            {!s.enabled && <p className="cc-status-line">Emails you when a business’s calendar breaks, its booking page has no times, or messages fail. Turning it on needs approval.</p>}
            {s.enabled && !confirming && (
              <div>
                <button type="button" className="btn btn-quiet btn-sm" onClick={() => setConfirming(true)} disabled={busy}>
                  Send test alert
                </button>
              </div>
            )}
            {confirming && (
              <div className="cc-actions">
                <span className="cc-status-line">Send one test email to {plural(s.deliverable, 'admin')} now?</span>
                <button type="button" className="btn btn-primary btn-sm" onClick={send} disabled={busy}>
                  {busy ? 'Sending…' : 'Send test email'}
                </button>
                <button type="button" className="btn btn-quiet btn-sm" onClick={() => setConfirming(false)} disabled={busy}>
                  Cancel
                </button>
              </div>
            )}
          </>
        )}
        <p className="cc-status-line" role="status" aria-live="polite" data-alert-test={result?.code || ''}>
          {result?.code === 'sent' && `Test sent to ${plural(result.sent, 'admin')}${result.notSent ? `; ${result.notSent} not sent (${result.errors.join(', ')})` : ''}.`}
          {result?.code === 'not_sent' && `Not delivered (${result.errors.join(', ') || 'unknown'}).`}
          {result && !['sent', 'not_sent'].includes(result.code) && (ALERT_REFUSED[result.code] || 'Couldn’t send the test.')}
        </p>
      </div>
    </Section>
  )
}

const FEEDBACK = { wrong_fact: 'Wrong fact', misunderstood: 'Misunderstood', wrong_action: 'Wrong action', missing: 'Missing something', not_useful: 'Not useful' }
// Codes and counts only: no question or answer is stored, so a reason is followed up with the owner or a new test.
function AssistantQuality({ a }) {
  if (!a) return null
  return (
    <Section title="Assistant answers" id="cc-assistant">
      <div data-assistant-quality>
        <p className="cc-status-line">
          Last {a.days} days, real businesses: {plural(a.asked, 'question')}, {a.answered} answered, {a.heldBack} held back by the checks. {a.testFeedback ? `${plural(a.testFeedback, 'report')} from test businesses not counted.` : ''}
        </p>
        {a.feedback.length > 0 && (
          <ul>
            {a.feedback.map((f) => (
              <li key={`${f.reason}:${f.view}`}>
                {FEEDBACK[f.reason] || f.reason} on {f.view || 'unknown page'}: {f.count}, last {ago(f.last)}
              </li>
            ))}
          </ul>
        )}
        {a.checks.length > 0 && (
          <details>
            <summary>Why drafts were corrected or held back</summary>
            <ul>
              {a.checks.map((c) => (
                <li key={c.check}>
                  {c.check}… {c.count}
                </li>
              ))}
            </ul>
          </details>
        )}
        {!a.feedback.length && !a.checks.length && <p className="cc-status-line">No owner reports and no held-back drafts recorded.</p>}
      </div>
    </Section>
  )
}

function Overview({ o, go }) {
  const problems = o.integrations.filter((c) => ['failed', 'degraded'].includes(c.state))
  const counts = o.integrations.reduce((m, c) => ({ ...m, [c.state]: (m[c.state] || 0) + 1 }), {})
  const running = (o.qa?.human || []).filter((r) => r.status === 'running')
  return (
    <div className="cc-main" data-overview>
      <PageHead go={go} title="Control Center" lede="What’s broken, who it affects, and what to do next, built from records. Nothing here changes a customer’s account." />
      <Banner o={o} />
      <div className="cc-metrics" aria-label="Summary">
        <Metric label="Critical incidents" value={o.incidents.critical} bad={o.incidents.critical > 0} to={{ view: 'incidents', filter: 'critical' }} go={go} hint="View" />
        <Metric label="Open incidents" value={o.incidents.openAll} bad={o.incidents.open > 0} to={{ view: 'incidents' }} go={go} hint={o.incidents.openTest ? `${o.incidents.openTest} on test accounts` : 'View'} />
        <Metric label="Affected businesses" value={o.affectedBusinesses.length} bad={o.affectedBusinesses.length > 0} to={{ view: 'accounts', filter: 'affected' }} go={go} hint="View" />
        <Metric label="Accounts needing help" value={o.assistance.length} to={{ view: 'accounts', filter: 'help' }} go={go} hint="View" />
        <Metric label="Recovered (7 days)" value={o.incidents.resolved7d} to={{ view: 'incidents', filter: 'resolved' }} go={go} hint="View" />
      </div>
      <Section title="Needs attention" id="cc-attention" action={o.attention.length ? <Link to={{ view: 'incidents' }} go={go} className="cc-more">All incidents →</Link> : null} sub={o.attention.length ? 'Priority order: things to act on first, then things being watched (with the reason).' : null}>
        {o.attention.length ? (
          <ul className="cc-list">
            {o.attention.map((a) => (
              <AttentionItem key={`${a.kind}:${a.id}`} a={a} go={go} />
            ))}
          </ul>
        ) : (
          <Empty title="Nothing needs your attention." data-attention-empty>
            No open incident and no account flagged by its records.
          </Empty>
        )}
      </Section>
      <AssistantQuality a={o.assistant} />
      <div className="cc-grid-2">
        <Section title="Integrations" id="cc-int" action={<Link to={{ view: 'integrations' }} go={go} className="cc-more">All integrations →</Link>} sub={`${counts.healthy || 0} healthy · ${counts.failed || 0} failed · ${counts.testing || 0} test mode · ${(counts.disabled || 0) + (counts.setup_required || 0)} off or not set up · ${counts.unknown || 0} not verified`}>
          {problems.length ? (
            <ul className="cc-list">
              {problems.map((c) => (
                <li key={c.id}>
                  <Link to={{ view: 'integrations', integration: c.id }} go={go} className="cc-item" data-capability={c.id}>
                    <span className="cc-item-main">
                      <span className="cc-item-title">{c.name}</span>
                      <span className="cc-item-sub">
                        {c.external} · {c.lastFailure ? `last failure ${ago(c.lastFailure)}` : 'latest check reported a problem'}
                      </span>
                    </span>
                    <span className="cc-item-meta">
                      <Badge tone={c.tone}>{c.stateLabel}</Badge>
                      <span className="cc-chev" aria-hidden="true">
                        ›
                      </span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <Empty title="No integration is failing.">Integrations without recent evidence are listed as “not verified”, never as healthy.</Empty>
          )}
        </Section>
        <Section title="Testing" id="cc-qa" action={<Link to={{ view: 'qa' }} go={go} className="cc-more">Open testing →</Link>}>
          <div className="cc-section-body">
            <p className="cc-status-line" data-overview-activation={o.activation?.measured ? 'measured' : 'not-measured'}>
              <span className="cc-label">Activation (≤ 20 min)</span>
              <br />
              {o.activation?.measured ? `${o.activation.latest.totalMinutes} min in the latest observer-recorded run.` : 'Not measured yet: no real-person run has been recorded.'}
            </p>
            <p className="cc-status-line" data-overview-qa>
              <span className="cc-label">Automated tests</span>
              <br />
              {!o.qa ? 'QA history isn’t available yet.' : o.qa.automated[0] ? `Latest run ${o.qa.automated[0].status}, ${ago(o.qa.automated[0].startedAt)} (${o.qa.automated[0].provider === 'real' ? 'real providers' : 'mocked providers'}).` : 'No automated runs recorded: CI isn’t connected yet.'}
            </p>
            {running.length > 0 && (
              <Link to={{ session: running[0].id }} go={go} className="btn btn-quiet btn-sm" style={{ justifySelf: 'start' }}>
                Resume guided session ({running.length} in progress)
              </Link>
            )}
          </div>
        </Section>
      </div>
      <div className="cc-grid-2">
        <Section title="Before real customers" id="cc-launch" sub="Switched off or test-only until approved. From the capability registry, not a hand-kept list.">
          {o.approvals.length ? (
            <ul className="cc-list">
              {o.approvals.map((x) => (
                <li key={x.id}>
                  <Link to={{ view: 'integrations', integration: x.id }} go={go} className="cc-item" data-approval={x.id}>
                    <span className="cc-item-main">
                      <span className="cc-item-title">{x.name}</span>
                      <span className="cc-item-sub">{x.approval}</span>
                    </span>
                    <span className="cc-item-meta">
                      <Badge tone={x.state === 'testing' ? 'info' : 'neutral'}>{x.state === 'testing' ? 'Test mode' : 'Off'}</Badge>
                    </span>
                  </Link>
                </li>
              ))}
              {!o.activation?.measured && (
                <li>
                  <Link to={{ view: 'qa' }} go={go} className="cc-item">
                    <span className="cc-item-main">
                      <span className="cc-item-title">Real-person activation test</span>
                      <span className="cc-item-sub">Not measured yet: needs an approved tester.</span>
                    </span>
                    <span className="cc-item-meta">
                      <Badge tone="neutral">Not run</Badge>
                    </span>
                  </Link>
                </li>
              )}
            </ul>
          ) : (
            <Empty title="No pending approvals recorded." />
          )}
        </Section>
        <div className="cc-main">
          <FounderAlerts />
          <Section title="Recent activity" id="cc-recent">
            {o.incidents.recentlyResolved.length ? (
              <ul className="cc-list">
                {o.incidents.recentlyResolved.slice(0, 5).map((i) => (
                  <IncidentRow key={i.id} i={i} go={go} />
                ))}
              </ul>
            ) : (
              <Empty title="No incident has been resolved yet." />
            )}
          </Section>
        </div>
      </div>
    </div>
  )
}

// ---------- shell ----------
const NAV = [
  ['overview', 'Overview'],
  ['incidents', 'Incidents'],
  ['accounts', 'Accounts'],
  ['integrations', 'Integrations'],
  ['qa', 'Testing'],
]
const sectionOf = (p) => (p.incident ? 'incidents' : p.business ? 'accounts' : p.integration ? 'integrations' : p.session || p.run ? 'qa' : NAV.some(([id]) => id === p.view) ? p.view : 'overview')

export default function Control() {
  const [params, go] = useLocation()
  const [o, setO] = useState(null)
  const [reload, setReload] = useState(0)
  useEffect(() => {
    let live = true
    api('/api/platform/control').then(({ status, data }) => live && setO(status === 200 ? data : { error: true }))
    return () => {
      live = false
    }
  }, [reload])
  const section = sectionOf(params)
  const count = (id) =>
    !o || o.error
      ? null
      : id === 'incidents'
        ? [o.incidents.openAll, o.incidents.open > 0]
        : id === 'accounts'
          ? [o.businesses.length, false]
          : id === 'integrations'
            ? [o.integrations.filter((c) => c.state === 'failed').length || null, true]
            : id === 'qa'
              ? [(o.qa?.human || []).filter((r) => r.status === 'running').length || null, false]
              : null
  let body
  if (params.incident) body = <IncidentDetail key={params.incident} id={params.incident} go={go} integrations={o && !o.error ? o.integrations.map((c) => c.id) : []} />
  else if (params.business) body = <AccountInspector key={params.business} id={params.business} go={go} />
  else if (params.session) body = <Session key={params.session} id={params.session} go={go} />
  else if (params.run) body = <RunReview key={params.run} id={params.run} go={go} />
  else if (!o) body = <Loading label="Loading the Control Center…" />
  else if (o.error) body = <LoadError what="the Control Center" onRetry={() => setReload((n) => n + 1)} />
  else if (params.integration) body = <IntegrationDetail o={o} id={params.integration} go={go} />
  else if (section === 'incidents') body = <IncidentsList o={o} params={params} go={go} />
  else if (section === 'accounts') body = <AccountsList key={params.filter || 'all'} o={o} params={params} go={go} />
  else if (section === 'integrations') body = <IntegrationsList o={o} go={go} />
  else if (section === 'qa') body = <Testing o={o} params={params} go={go} />
  else body = <Overview o={o} go={go} />
  return (
    <div className="cc" data-cc-section={section}>
      <nav className="cc-nav" aria-label="Control Center">
        <span className="cc-nav-title">Control Center</span>
        {NAV.map(([id, label]) => {
          const c = count(id)
          return (
            <Link key={id} to={id === 'overview' ? {} : { view: id }} go={go} aria-current={section === id ? 'page' : undefined} data-nav={id}>
              {label}
              {c && c[0] ? <span className={`cc-count${c[1] ? ' cc-count--bad' : ''}`}>{c[0]}</span> : null}
            </Link>
          )
        })}
      </nav>
      <div className="cc-main">
        <Suspense fallback={<Loading />}>{body}</Suspense>
      </div>
    </div>
  )
}
