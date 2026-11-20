// Incidents: the register as a filterable list, and one incident as an investigation page. Read-only: incidents are
// opened and resolved by the cron on evidence; nothing here changes an account or a setting.
import { useEffect, useState } from 'react'
import { api } from '../../lib/api.js'
import { Badge, Empty, Facts, Link, LoadError, Loading, PageHead, Section, Severity, TestTag } from './ui.jsx'
import { ago, plural, when } from './lib.js'

const CAUSE = {
  confirmed: ['ok', 'Confirmed cause'],
  suspected: ['warn', 'Suspected cause (hypothesis)'],
  unknown: ['neutral', 'Cause not determined'],
}
const SCOPE = (i) => (i.scope === 'platform' ? 'Platform-wide' : i.businessName || i.customer)

export function IncidentRow({ i, go }) {
  return (
    <li>
      <Link to={{ incident: i.id }} go={go} className="cc-item" data-incident={i.id} data-kind={i.kind} data-status={i.status}>
        <span className="cc-item-main">
          <span className="cc-item-title">
            {i.title}
            {i.test && <TestTag />}
          </span>
          <span className="cc-item-sub">
            {SCOPE(i)} · {i.featureName || i.feature} · {plural(i.occurrences, 'occurrence')} · last {ago(i.lastSeen)}
          </span>
        </span>
        <span className="cc-item-meta">
          <Severity s={i.severity} />
          <Badge tone={i.phaseTone}>{i.phaseLabel}</Badge>
          <span className="cc-chev" aria-hidden="true">
            ›
          </span>
        </span>
      </Link>
    </li>
  )
}

const FILTERS = [
  ['open', 'Open'],
  ['critical', 'Critical'],
  ['customer', 'Customer impact'],
  ['resolved', 'Resolved'],
]
export function IncidentsList({ o, params, go }) {
  const filter = params.filter || 'open'
  const all = [...o.incidents.list, ...o.incidents.recentlyResolved]
  const list =
    filter === 'resolved'
      ? o.incidents.recentlyResolved
      : filter === 'critical'
        ? o.incidents.list.filter((i) => i.severity === 'critical')
        : filter === 'customer'
          ? o.incidents.list.filter((i) => !i.test && i.customer)
          : o.incidents.list
  return (
    <>
      <PageHead
        go={go}
        crumbs={[['Control Center', {}]]}
        title="Incidents"
        lede="Failures detected from records: what broke, who it affects, and whether a later success has been seen. Incidents open and close on evidence only."
      />
      <div className="cc-chips" role="group" aria-label="Filter incidents">
        {FILTERS.map(([id, label]) => (
          <button key={id} type="button" className="cc-chip" aria-pressed={filter === id} onClick={() => go({ view: 'incidents', filter: id === 'open' ? null : id }, { replace: true })}>
            {label}
          </button>
        ))}
      </div>
      <Section title={`${FILTERS.find(([id]) => id === filter)?.[1]} incidents`} id="inc-list" sub={filter === 'resolved' ? 'The 10 most recently resolved.' : null}>
        {list.length ? (
          <ul className="cc-list">
            {list.map((i) => (
              <IncidentRow key={i.id} i={i} go={go} />
            ))}
          </ul>
        ) : (
          <Empty title={filter === 'resolved' ? 'Nothing resolved yet.' : 'No incidents match.'}>
            {all.length === 0 ? 'The register is empty: no failure has been recorded without a later success.' : 'Try another filter.'}
          </Empty>
        )}
      </Section>
    </>
  )
}

const EVENT_LABEL = { 'incident.opened': 'Incident opened', 'incident.resolved': 'Incident resolved' }
const RESOLUTION = { success_seen: 'a later success was recorded', connected: 'the calendar was connected again', no_new_failures: 'no new failures within the window (not a confirmed fix)' }

export function IncidentDetail({ id, go, integrations = [] }) {
  const [d, setD] = useState(null)
  const [reload, setReload] = useState(0)
  useEffect(() => {
    let live = true
    api(`/api/platform/incidents?id=${encodeURIComponent(id)}`).then(({ status, data }) => live && setD(status === 200 ? data : { error: status === 404 ? 'not_found' : 'failed' }))
    return () => {
      live = false
    }
  }, [id, reload])
  const crumbs = [
    ['Control Center', {}],
    ['Incidents', { view: 'incidents' }],
  ]
  if (!d) return <Loading label="Loading incident…" />
  if (d.error === 'not_found')
    return (
      <>
        <PageHead go={go} crumbs={crumbs} title="Incident not found" />
        <Empty title="This incident no longer exists.">Resolved incidents are kept for a year; this link may be older or mistyped.</Empty>
      </>
    )
  if (d.error) return <LoadError what="this incident" onRetry={() => setReload((n) => n + 1)} />
  const i = d.incident
  const [causeTone, causeLabel] = CAUSE[i.cause] || CAUSE.unknown
  const open = i.status === 'open'
  return (
    <div className="cc-main" data-incident-detail={i.id} data-status={i.status}>
      <PageHead go={go} crumbs={crumbs} title={i.title}>
        <Severity s={i.severity} />
        <Badge tone={i.phaseTone} data-phase={i.phase}>
          {i.phaseLabel}
        </Badge>
        {i.test && <TestTag />}
      </PageHead>
      <Facts
        items={[
          ['Scope', i.scope === 'platform' ? 'Platform-wide (no single business)' : <Link key="scope" to={{ business: i.customer }} go={go}>{i.businessName || i.customer}</Link>],
          ['Affected feature', integrations.includes(i.feature) ? <Link key="feature" to={{ view: 'integrations', integration: i.feature }} go={go}>{i.featureName || i.feature}</Link> : i.featureName || i.feature],
          ['First failure', when(i.firstSeen)],
          ['Most recent failure', `${when(i.lastSeen)} (${ago(i.lastSeen)})`],
          ['Occurrences', String(i.occurrences)],
          ['Status', open ? 'Open' : `Resolved ${when(i.resolvedAt)}`],
        ]}
      />
      {open && i.triage && (
        <div className={`cc-callout ${i.triage.action === 'act' ? 'cc-callout--next' : ''}`} data-triage={i.triage.action}>
          <span className="cc-label">{i.triage.action === 'act' ? 'Act now' : 'Monitor'}</span>
          <strong>Next step</strong>
          <span>{i.next}</span>
          <span>Why: {i.triage.why}</span>
        </div>
      )}
      <div className="cc-grid-2">
        <Section title="What we know" id="inc-known">
          <div className="cc-section-body">
            <p>
              <span className="cc-label">Customer impact</span>
              <br />
              {i.test ? 'None: this is a test account.' : i.impact}
            </p>
            <p>
              <span className="cc-label">Observed</span>
              <br />
              {plural(i.occurrences, 'failure')} recorded for {i.featureName || i.feature} ({i.step ? <span className="cc-code">{i.step}</span> : null}{' '}
              with code <span className="cc-code">{i.code}</span>), first {when(i.firstSeen)}, most recently {when(i.lastSeen)}.
              {d.lastSuccess ? ` The last success for this feature${i.customer ? ' on this account' : ''} was ${when(d.lastSuccess.at)}.` : ` No success has been recorded for this feature${i.customer ? ' on this account' : ''}.`}
            </p>
            <div>
              <Badge tone={causeTone}>{causeLabel}</Badge>
              <p className="cc-status-line" style={{ marginTop: 6 }}>
                {i.causeNote || (i.cause === 'unknown' ? 'The system has no fixed explanation for this code. Treat any explanation as a hypothesis until it is checked.' : '')}
              </p>
            </div>
          </div>
        </Section>
        <Section title="Recovery" id="inc-recovery">
          <div className="cc-section-body">
            {open ? (
              <p className="cc-status-line">
                {i.phase === 'active'
                  ? 'Still failing: a failure was recorded in the last 24 hours and no success since.'
                  : 'No new failures recently, but no success has been recorded either, so this is not a confirmed recovery. It closes when a success is recorded, or as “no new failures” 14 days after the last failure.'}
              </p>
            ) : (
              <p className="cc-status-line">Resolved {when(i.resolvedAt)} because {RESOLUTION[i.resolution] || i.resolution}.</p>
            )}
            <ul className="cc-timeline" aria-label="Incident history">
              <li>
                <time>{when(i.firstSeen)}</time>
                <span>First failure recorded</span>
              </li>
              {d.history.map((h, k) => (
                <li key={k}>
                  <time>{when(h.at)}</time>
                  <span>
                    {EVENT_LABEL[h.action] || h.action}
                    {h.resolution ? ` (${RESOLUTION[h.resolution] || h.resolution})` : ''}
                  </span>
                </li>
              ))}
              {i.lastSeen !== i.firstSeen && (
                <li>
                  <time>{when(i.lastSeen)}</time>
                  <span>Most recent failure</span>
                </li>
              )}
            </ul>
          </div>
        </Section>
      </div>
      <Section title="Technical evidence" id="inc-evidence" sub="Codes, counts and times only. No customer details are stored with incidents.">
        <div className="cc-section-body">
          {d.events.length > 0 ? (
            <ul className="cc-timeline" aria-label="Underlying events">
              {d.events.map((e) => (
                <li key={e.seq}>
                  <time>{when(e.at)}</time>
                  <span>
                    <span className="cc-code">{e.action}</span> {e.outcome}
                    {e.code ? (
                      <>
                        {' · reason '}
                        <span className="cc-code">{e.code}</span>
                      </>
                    ) : null}{' '}
                    · audit #{e.seq}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="cc-status-line">The evidence for this incident is a count, not individual events.</p>
          )}
          <details className="cc-details">
            <summary>Raw evidence record</summary>
            <pre className="cc-code" style={{ display: 'block', whiteSpace: 'pre-wrap', padding: 12 }}>
              {JSON.stringify(i.evidence, null, 2)}
            </pre>
          </details>
          <p className="cc-status-line">
            Incident <span className="cc-code">{i.id}</span> · fingerprint <span className="cc-code">{i.fingerprint}</span>
          </p>
        </div>
      </Section>
      <div className="cc-actions">
        {i.customer && (
          <Link to={{ business: i.customer }} go={go} className="btn btn-primary btn-sm">
            Open account
          </Link>
        )}
        {integrations.includes(i.feature) && (
          <Link to={{ view: 'integrations', integration: i.feature }} go={go} className="btn btn-quiet btn-sm">
            View {i.featureName || 'integration'}
          </Link>
        )}
        {i.customer && (
          <a className="btn btn-quiet btn-sm" href={`/admin/review?business=${encodeURIComponent(i.customer)}`}>
            Business Review for this account
          </a>
        )}
      </div>
    </div>
  )
}
