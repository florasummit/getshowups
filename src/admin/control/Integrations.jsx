// Integrations: each external service with ONE evidence-based state (server/ops/states.js) and a detail page:
// what it does, configured / enabled / tested, last success and failure, affected businesses, safe diagnostics.
import { Badge, Empty, Facts, Link, PageHead, Section } from './ui.jsx'
import { ago, plural, when } from './lib.js'

const ORDER = ['failed', 'degraded', 'unknown', 'testing', 'setup_required', 'disabled', 'healthy']
const GROUP = {
  failed: 'Failing',
  degraded: 'Degraded',
  unknown: 'On, not verified',
  testing: 'Test mode',
  setup_required: 'Setup required',
  disabled: 'Off until approved',
  healthy: 'Healthy',
}
// Safe diagnostics that already exist; anything else is explained, never improvised.
const DIAGNOSTIC = {
  'calendar.google': 'Open an account and use “Diagnose calendar (read-only)”: one free/busy lookup, rate-limited, changes nothing.',
}

export function IntegrationsList({ o, go }) {
  const groups = ORDER.map((s) => [s, o.integrations.filter((c) => c.state === s)]).filter(([, l]) => l.length)
  return (
    <>
      <PageHead
        go={go}
        crumbs={[['Control Center', {}]]}
        title="Integrations"
        lede="Every outside service GetShowUps depends on. “Healthy” needs recorded evidence of it working; a feature that is off on purpose is shown as off, not failed."
      />
      {groups.map(([state, list]) => (
        <Section key={state} title={`${GROUP[state]} (${list.length})`} id={`int-${state}`}>
          <ul className="cc-list">
            {list.map((c) => (
              <li key={c.id}>
                <Link to={{ view: 'integrations', integration: c.id }} go={go} className="cc-item" data-capability={c.id} data-state={c.state}>
                  <span className="cc-item-main">
                    <span className="cc-item-title">{c.name}</span>
                    <span className="cc-item-sub">
                      {c.external}
                      {c.lastSuccess ? ` · last success ${ago(c.lastSuccess)}` : ' · no success recorded'}
                      {c.openIncidents.length ? ` · ${plural(c.openIncidents.length, 'open incident')}` : ''}
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
        </Section>
      ))}
      {!groups.length && <Empty title="No integrations registered." />}
    </>
  )
}

export function IntegrationDetail({ o, id, go }) {
  const c = o.integrations.find((x) => x.id === id)
  const crumbs = [
    ['Control Center', {}],
    ['Integrations', { view: 'integrations' }],
  ]
  if (!c)
    return (
      <>
        <PageHead go={go} crumbs={crumbs} title="Not an outside integration" />
        <Empty title="This feature isn’t tracked as an outside integration.">Its status is in Business Review.</Empty>
        <a className="btn btn-quiet btn-sm" href="/admin/review">
          Open Business Review
        </a>
      </>
    )
  const names = new Map(o.businesses.map((b) => [b.id, b.name]))
  const configured = !['setup_required'].includes(c.state)
  const enabled = !['disabled', 'setup_required'].includes(c.state)
  return (
    <div className="cc-main" data-integration={c.id} data-state={c.state}>
      <PageHead go={go} crumbs={crumbs} title={c.name} lede={c.description || null}>
        <Badge tone={c.tone}>{c.stateLabel}</Badge>
      </PageHead>
      <div className={`cc-callout ${c.state === 'failed' ? 'cc-callout--warn' : c.state === 'healthy' ? 'cc-callout--ok' : ''}`}>
        <strong>{c.stateLabel}</strong>
        <span>{c.stateExplain}</span>
        {c.note && <span>{c.note}</span>}
        {c.approval && <span>Needs approval to change: {c.approval}</span>}
      </div>
      <Facts
        items={[
          ['Provider', c.external],
          ['Configured', configured ? 'Yes' : 'No'],
          ['Enabled', enabled ? (c.state === 'testing' ? 'Test mode only' : 'Yes') : 'No'],
          ['Tested', c.verification ? (c.verification.ok ? `Verified ${when(c.verification.at)}` : 'Verification did not pass') : c.lastSuccess ? 'Seen working in records' : 'No evidence yet'],
          ['Last success', c.lastSuccess ? `${when(c.lastSuccess)} (${ago(c.lastSuccess)})` : 'None recorded'],
          ['Last failure', c.lastFailure ? `${when(c.lastFailure)} (${ago(c.lastFailure)})` : 'None recorded'],
          ['Failures (7 days)', String(c.failures7)],
        ]}
      />
      <div className="cc-grid-2">
        <Section title="Affected" id="int-affected">
          {c.openIncidents.length ? (
            <ul className="cc-list">
              {c.openIncidents.map((iid) => {
                const i = o.incidents.list.find((x) => x.id === iid)
                return (
                  <li key={iid}>
                    <Link to={{ incident: iid }} go={go} className="cc-item">
                      <span className="cc-item-main">
                        <span className="cc-item-title">{i?.title || iid}</span>
                        <span className="cc-item-sub">{i?.scope === 'platform' ? 'Platform-wide' : names.get(i?.customer) || i?.customer}</span>
                      </span>
                      <span className="cc-chev" aria-hidden="true">
                        ›
                      </span>
                    </Link>
                  </li>
                )
              })}
            </ul>
          ) : (
            <Empty title="No open incident on this integration." />
          )}
          {c.affectedBusinesses.length > 0 && (
            <div className="cc-section-body" style={{ paddingTop: 12 }}>
              <span className="cc-label">Businesses affected</span>
              <div className="cc-actions">
                {c.affectedBusinesses.map((b) => (
                  <Link key={b} to={{ business: b }} go={go} className="btn btn-quiet btn-sm">
                    {names.get(b) || b}
                  </Link>
                ))}
              </div>
            </div>
          )}
        </Section>
        <Section title="Diagnostics" id="int-diag">
          <div className="cc-section-body">
            <p className="cc-status-line">{DIAGNOSTIC[c.id] || 'No live diagnostic is available from here: checking this service would mean an extra call to the provider. The evidence above comes from recorded events.'}</p>
            {c.blockedBy.length > 0 && <p className="cc-status-line">Depends on something that is off or missing: {c.blockedBy.join(', ')}.</p>}
            {c.blockers.length > 0 && <p className="cc-status-line">Known blockers: {c.blockers.join('; ')}.</p>}
            <a className="cc-more" href="/admin/review">
              Full capability detail in Business Review →
            </a>
          </div>
        </Section>
      </div>
    </div>
  )
}
