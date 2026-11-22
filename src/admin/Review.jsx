// Business Review (/admin/review): the founder's operational map. Fully driven by /api/platform/review: every
// capability, its status, dependencies, verification, events and incidents come from the server-side registry
// (server/ops/), so a newly registered capability appears here without any change to this file.
import { useEffect, useMemo, useState } from 'react'
import { api, fmt } from '../lib/api.js'

const STATUS_LABEL = {
  live_verified: 'Live-verified',
  built_tested: 'Built + tested',
  sandbox: 'Sandbox only',
  disabled: 'Off · needs approval',
  missing: 'Not built',
  unknown: 'Unknown',
}
const STATUS_HELP = {
  live_verified: 'runs in production and was seen working recently',
  built_tested: 'switched on, but not seen working recently',
  sandbox: 'works only with test accounts or test mode',
  disabled: 'built, but a switch keeps it off',
  missing: 'not built yet',
  unknown: 'couldn’t be checked',
}
const HEALTH_LABEL = { failing: 'Failing', degraded: 'Quiet lately', healthy: 'Working', unknown: 'No evidence yet', not_applicable: '' }
const when = (ms) => (ms ? fmt(new Date(ms).toISOString(), undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—')
const TIER_ORDER = ['operate', 'payments', 'advertising', 'optional', 'later']
const GROUP_ORDER = ['broken', 'works', 'testable', 'configuration', 'approval', 'not_built']
const GROUP_HELP = {
  broken: 'Switched on and failing right now. Fix first.',
  works: 'Live in production and seen working recently.',
  testable: 'You can use or test these now. Some run in test mode only until you approve going live.',
  configuration: 'Built. Waiting on credentials, a binding or a migration: setup work, not a decision.',
  approval: 'Built and switched off. Each needs your explicit decision to turn on.',
  not_built: 'Not built. Nothing waits on these unless they become needed.',
}
const Badge = ({ s }) => (
  <span className={`tag st st--${s}`} data-status={s}>
    {STATUS_LABEL[s] || s}
  </span>
)
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`

function Capability({ c, names }) {
  return (
    <li className="cap" data-capability={c.id}>
      <details open={c.openFailures.length > 0 || c.status === 'unknown'}>
      <summary className="cap-head">
        <span className="cap-name">
          {c.name}
          {c.openFailures.length > 0 && <span className="bad"> · {plural(c.openFailures.length, 'problem')}</span>}
        </span>
        <span className="cap-badges">
          {HEALTH_LABEL[c.health] && ['failing', 'degraded'].includes(c.health) && <span className={`tag hl hl--${c.health}`} data-health={c.health}>{HEALTH_LABEL[c.health]}</span>}
          <Badge s={c.status} />
        </span>
      </summary>
      {c.description && <p className="fine">{c.description}</p>}
      <dl className="cap-facts">
        {c.note && (
          <div>
            <dt>Now</dt>
            <dd>{c.note}</dd>
          </div>
        )}
        <div>
          <dt>Verified</dt>
          <dd data-verified={c.verification ? (c.verification.ok ? 'yes' : 'no') : 'none'}>
            {c.verification ? `${c.verification.evidence}${c.verification.at ? ` (${when(c.verification.at)})` : ''}` : 'No live check defined'}
          </dd>
        </div>
        {c.dependsOn.length > 0 && (
          <div>
            <dt>Needs</dt>
            <dd>
              {c.dependsOn.map((d, i) => (
                <span key={d} className={c.blockedBy.includes(d) ? 'dep dep--blocked' : 'dep'}>
                  {i ? ', ' : ''}
                  {names[d] || d}
                </span>
              ))}
            </dd>
          </div>
        )}
        {c.external && (
          <div>
            <dt>Outside service</dt>
            <dd>{c.external}</dd>
          </div>
        )}
        {(c.events.failures7 > 0 || c.events.lastSuccess) && (
          <div>
            <dt>Events</dt>
            <dd>
              {c.events.lastSuccess ? `last success ${when(c.events.lastSuccess)}` : 'no successes yet'}
              {c.events.failures7 ? ` · ${plural(c.events.failures7, 'failure')} in 7 days` : ''}
            </dd>
          </div>
        )}
        {c.openFailures.length > 0 && (
          <div>
            <dt>Open problems</dt>
            <dd className="bad">{plural(c.openFailures.length, 'unresolved failure')}</dd>
          </div>
        )}
        {c.blockers.length > 0 && (
          <div>
            <dt>Blocked by</dt>
            <dd>{c.blockers.join('; ')}</dd>
          </div>
        )}
        {c.approval && ['disabled', 'sandbox'].includes(c.status) && (
          <div>
            <dt>To turn on</dt>
            <dd>{c.approval}</dd>
          </div>
        )}
        {c.nextStep && (
          <div>
            <dt>Next step</dt>
            <dd>
              {c.nextStep}
              {c.action && (
                <>
                  {' '}
                  <a href={c.action.href}>{c.action.label}</a>
                </>
              )}
            </dd>
          </div>
        )}
      </dl>
      <CapabilityEvents id={c.id} />
      </details>
    </li>
  )
}

// Drill-down: the capability's recent events, loaded on demand.
function CapabilityEvents({ id }) {
  const [ev, setEv] = useState(null)
  const load = () => api(`/api/platform/audit?capability=${encodeURIComponent(id)}`).then(({ status, data }) => setEv(status === 200 ? data.entries : []))
  if (!ev)
    return (
      <button type="button" className="link-btn fine" onClick={load}>
        Show recent events
      </button>
    )
  if (!ev.length) return <p className="fine">No events recorded.</p>
  return (
    <ul className="cap-events" data-cap-events={id}>
      {ev.slice(0, 10).map((e) => (
        <li key={e.seq}>
          <span className={`tag ${e.outcome === 'failure' ? 'tag--bad' : e.outcome === 'success' ? 'tag--ok' : ''}`}>{e.outcome}</span> {e.action}
          {e.customer ? ` · ${e.customer}` : ''} · {when(e.at)}
        </li>
      ))}
    </ul>
  )
}

// The founder's plain-language map: what works, what can be tested, what needs setup, what needs a decision, what is
// broken, what is optional. Same data as the capability list below (server/ops/review.js groupOf / nextStepOf);
// nothing is computed in the browser. A tier filter shows what still stands between the founder and each goal.
function PlainMap({ r, byId }) {
  const [tier, setTier] = useState('operate')
  const plain = r.plain
  if (!plain) return null
  const t = plain.tiers[tier]
  const inTier = (id) => tier === 'all' || byId.get(id)?.tier === tier
  const tierLabel = (id) => plain.tiers[byId.get(id)?.tier]?.label || ''
  return (
    <section className="card" aria-labelledby="rv-plain" data-plain-map>
      <h2 className="card-title" id="rv-plain">
        What this means for operating
      </h2>
      <div className="seg seg--sm" role="tablist" aria-label="What for">
        {[...TIER_ORDER.map((k) => [k, plain.tiers[k].label]), ['all', 'Everything']].map(([k, label]) => (
          <button key={k} type="button" role="tab" aria-selected={tier === k} className={tier === k ? 'seg-on' : ''} onClick={() => setTier(k)} data-tier-tab={k}>
            {label}
          </button>
        ))}
      </div>
      {t && (
        <p className={t.ready ? 'notice-ok' : t.ready === false ? 'notice-warn' : 'fine'} role="status" data-tier-ready={t.ready === null ? 'na' : t.ready ? 'yes' : 'no'}>
          {t.ready === null
            ? `${plural(t.capabilities.length, 'capability')} in this tier; nothing waits on them.`
            : t.ready
              ? `Nothing in “${t.label.toLowerCase()}” is blocked: every capability needed here works or can be tested now.`
              : `${plural(t.blockers.length, 'blocker')} for “${t.label.toLowerCase()}”: ${t.blockers.map((id) => byId.get(id)?.name || id).join('; ')}.`}
        </p>
      )}
      {GROUP_ORDER.map((g) => {
        const ids = (plain.groups[g] || []).filter(inTier)
        if (!ids.length) return null
        return (
          <div key={g} className="plain-group" data-plain-group={g}>
            <h3 className="journey-title">
              {plain.groupLabels[g]} <span className="fine">({ids.length})</span>
            </h3>
            <p className="fine">{GROUP_HELP[g]}</p>
            <ul className="rows">
              {ids.map((id) => {
                const c = byId.get(id)
                return (
                  <li key={id} className="row" data-plain-cap={id}>
                    <div className="row-main">
                      <p className="row-title">
                        {c.name} {tier === 'all' && <span className="fine">· {tierLabel(id)}</span>}
                      </p>
                      <p className="row-sub">
                        {[c.note, c.verification?.evidence, c.nextStep].filter(Boolean).join(' · ')}
                      </p>
                    </div>
                    {c.action && (
                      <a className="btn btn-sm btn-quiet" href={c.action.href} data-plain-action={id}>
                        {c.action.label}
                      </a>
                    )}
                  </li>
                )
              })}
            </ul>
          </div>
        )
      })}
    </section>
  )
}

function Platform({ r, openBusiness }) {
  const names = useMemo(() => Object.fromEntries(r.capabilities.map((c) => [c.id, c.name])), [r])
  const byId = useMemo(() => new Map(r.capabilities.map((c) => [c.id, c])), [r])
  return (
    <div className="stack-lg">
      <section className="card" aria-labelledby="rv-summary">
        <h2 className="card-title" id="rv-summary">
          Where things stand
        </h2>
        <ul className="status-strip">
          {Object.entries(STATUS_LABEL).map(([s, label]) => (
            <li key={s} title={STATUS_HELP[s]}>
              <Badge s={s} /> <strong data-count={s}>{r.counts[s] ?? 0}</strong>
              <span className="sr-only"> {label}</span>
            </li>
          ))}
        </ul>
        <p className="fine">
          {r.health ? `Working ${r.health.healthy} · failing ${r.health.failing} · quiet lately ${r.health.degraded} · no evidence yet ${r.health.unknown} · ` : ''}
          {r.release.build?.commit ? `Release ${r.release.build.commit.slice(0, 7)}` : 'Release unknown'}
          {r.audit ? ` · audit log ${r.audit.ok ? 'intact' : `BROKEN at ${r.audit.brokenAt}`}` : ''} · generated {when(r.generatedAt)}
        </p>
      </section>

      <PlainMap r={r} byId={byId} />

      <section className="card" aria-labelledby="rv-incidents">
        <h2 className="card-title" id="rv-incidents">
          Needs attention {r.incidents.length > 0 && <span className="tag tag--bad">{r.incidents.length}</span>}
        </h2>
        {r.incidents.length ? (
          <ul className="rows" data-incidents>
            {r.incidents.map((i, n) => (
              <li key={n} className="row" data-incident={i.kind}>
                <div className="row-main">
                  <p className="row-title">
                    <span className={`sev sev--${i.severity}`}>{i.severity}</span> {i.title}
                  </p>
                  <p className="row-sub">
                    {[i.capability && (names[i.capability] || i.capability), i.detail, i.at && when(i.at)].filter(Boolean).join(' · ')}
                  </p>
                </div>
                {i.customer && (
                  <button type="button" className="btn btn-sm btn-quiet" onClick={() => openBusiness(i.customer)}>
                    Open business
                  </button>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="empty">Nothing needs attention.</p>
        )}
      </section>

      {r.approvals.length > 0 && (
        <section className="card" aria-labelledby="rv-approvals">
          <h2 className="card-title" id="rv-approvals">
            Waiting on a decision
          </h2>
          <ul className="rows">
            {r.approvals.map((a) => (
              <li key={a.capability} className="row">
                <div className="row-main">
                  <p className="row-title">{a.name}</p>
                  <p className="row-sub">{a.approval}</p>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="card" aria-labelledby="rv-journey">
        <h2 className="card-title" id="rv-journey">
          Customer journey and capabilities
        </h2>
        <p className="fine">Signup → billing → onboarding → website → advertising → lead → booking → show-up → attributed results.</p>
        {r.journey
          .filter((j) => j.capabilities.length)
          .map((j) => (
            <div key={j.id} className="journey-step" data-journey={j.id}>
              <h3 className="journey-title">{j.label}</h3>
              <ul className="caps">
                {j.capabilities.map((id) => (
                  <Capability key={id} c={byId.get(id)} names={names} />
                ))}
              </ul>
            </div>
          ))}
      </section>

      {r.blocked.length > 0 && (
        <section className="card" aria-labelledby="rv-blocked">
          <h2 className="card-title" id="rv-blocked">
            Blocked
          </h2>
          <ul className="rows">
            {r.blocked.map((b) => (
              <li key={b.capability} className="row">
                <div className="row-main">
                  <p className="row-title">{b.name}</p>
                  <p className="row-sub">{[...b.blockers, ...b.blockedBy.map((d) => `needs ${names[d] || d} (${STATUS_LABEL[byId.get(d)?.status] || 'missing'})`)].join('; ')}</p>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="card" aria-labelledby="rv-changes">
        <h2 className="card-title" id="rv-changes">
          Releases, migrations and switches
        </h2>
        {r.release.migrations ? (
          <p className="fine" data-migrations>
            Migrations: {r.release.migrations.filter((m) => m.applied).length} of {r.release.migrations.length} applied
            {r.release.migrations.some((m) => m.applied === false) && `; pending: ${r.release.migrations.filter((m) => m.applied === false).map((m) => m.file).join(', ')}`}
          </p>
        ) : (
          <p className="fine">Migration status unavailable (no build info).</p>
        )}
        <p className="fine" data-switches>
          Switches on: {Object.entries(r.release.config.switches).filter(([, v]) => v).map(([k]) => k).join(', ') || 'none'} · Stripe key: {r.release.config.stripeMode}
        </p>
        {r.release.history.length > 0 && (
          <ul className="rows">
            {r.release.history.map((h) => (
              <li key={h.seq} className="row">
                <div className="row-main">
                  <p className="row-title">{h.action === 'platform.release' ? `Release ${String(h.details.commit).slice(0, 7)}` : 'Configuration changed'}</p>
                  <p className="row-sub">
                    {when(h.at)}
                    {h.details.pendingMigrations?.length ? ` · pending migrations: ${h.details.pendingMigrations.join(', ')}` : ''}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

function Business({ list, id, setId }) {
  const [q, setQ] = useState('')
  const shown = list.filter((x) => `${x.name} ${x.id}`.toLowerCase().includes(q.trim().toLowerCase()))
  return (
    <div className="stack-lg">
      <section className="card">
        <label className="field">
          <span>Find a business</span>
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name or id" />
        </label>
        <ul className="rows" aria-label="Businesses">
          {shown.slice(0, 30).map((x) => (
            <li key={x.id} className={`row${x.id === id ? ' row--current' : ''}`}>
              <div className="row-main">
                <button type="button" className="link-btn row-title" onClick={() => setId(x.id)}>
                  {x.name}
                </button>
                <p className="row-sub">
                  {x.id}
                  {x.testBusiness ? ' · test' : ''}
                  {x.deleted ? ' · deleted' : ''}
                  {x.attention?.length ? ` · ${plural(x.attention.length, 'flag')}` : ''}
                </p>
              </div>
            </li>
          ))}
        </ul>
      </section>
      {id && <BusinessLoader key={id} id={id} />}
    </div>
  )
}

function BusinessLoader({ id }) {
  const [b, setB] = useState(null)
  useEffect(() => {
    let live = true
    api(`/api/platform/review?business=${encodeURIComponent(id)}`).then(({ status, data }) => live && setB(status === 200 ? data : { error: true }))
    return () => {
      live = false
    }
  }, [id])
  if (!b) return <p className="fine">Loading…</p>
  if (b.error) return <p className="form-error">Couldn’t load this business.</p>
  return <BusinessDetail b={b} />
}

const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '—')
function BusinessDetail({ b }) {
  const l = b.lifecycle
  const f = b.funnel || {}
  return (
    <div className="stack-lg" data-business={b.id}>
      <section className="card">
        <h2 className="card-title">
          {b.name} <span className="fine">({b.id})</span>
        </h2>
        <p className="fine">
          Stage: <strong data-stage={l?.stage}>{l?.stage?.replace(/_/g, ' ') || '—'}</strong> · onboarding {b.onboarding} · since {when(b.createdAt)}
          {b.attention?.length ? ` · flags: ${b.attention.join(', ')}` : ''}
        </p>
      </section>
      <section className="card" aria-label="Capabilities for this business">
        <h2 className="card-title">Status by capability</h2>
        <ul className="rows">
          {b.capabilities.map((c) => (
            <li key={c.id} className="row" data-business-capability={c.id}>
              <div className="row-main">
                <p className="row-title">{c.name}</p>
                <p className="row-sub">{c.summary}</p>
              </div>
              <span className={`tag ${c.status === 'ok' ? 'tag--ok' : c.status === 'attention' ? 'tag--bad' : ''}`}>{c.status}</span>
            </li>
          ))}
        </ul>
      </section>
      <section className="card" aria-label="Funnel">
        <h2 className="card-title">Leads to show-ups</h2>
        <div className="stats" data-funnel>
          {[
            ['Leads', f.leads],
            ['Leads (30 days)', f.leads30],
            ['Booked', f.booked],
            ['Showed', f.showed],
            ['No-show', f.no_show],
            ['Show-up rate', pct(f.showed || 0, (f.showed || 0) + (f.no_show || 0))],
          ].map(([label, v]) => (
            <div key={label} className="stat">
              <div className="stat-value">{v ?? '—'}</div>
              <div className="stat-label">{label}</div>
            </div>
          ))}
        </div>
        <p className="fine">
          Attribution: {b.attribution.length ? b.attribution.map((a) => `${a.source} ${a.n}`).join(' · ') : 'none recorded'}
          {f.test_leads ? ` · ${plural(f.test_leads, 'test lead')} excluded` : ''}
        </p>
      </section>
      <section className="card" aria-label="Billing and lifecycle">
        <h2 className="card-title">Billing and lifecycle</h2>
        <dl className="kv">
          <div>
            <dt>Subscription</dt>
            <dd>{l?.subscription ? `${l.subscription.status}${l.subscription.cancelAtPeriodEnd ? ' (cancellation scheduled)' : ''}` : 'not billed'}</dd>
          </div>
          <div>
            <dt>Hosting plan</dt>
            <dd>{l?.hosting?.status || '—'}</dd>
          </div>
          <div>
            <dt>Ads hold</dt>
            <dd>{l?.adsHold?.replace(/_/g, ' ') || 'none'}</dd>
          </div>
          <div>
            <dt>Recovery</dt>
            <dd>{l?.recovery ? (l.recovery.expired ? `over since ${when(l.recovery.until)}` : `until ${when(l.recovery.until)}`) : '—'}</dd>
          </div>
          <div>
            <dt>Deletion</dt>
            <dd>{l?.deletion ? `${l.deletion.status} (${l.deletion.step})` : '—'}</dd>
          </div>
        </dl>
      </section>
      <section className="card" aria-label="Advertising">
        <h2 className="card-title">Advertising</h2>
        <p className="fine">Monthly ceiling: {b.ads.budget ? `$${(b.ads.budget.monthlyCents / 100).toFixed(0)}` : 'none approved'}</p>
        {b.ads.campaigns.length ? (
          <ul className="rows">
            {b.ads.campaigns.map((c) => (
              <li key={c.id} className="row" data-campaign={c.id}>
                <div className="row-main">
                  <p className="row-title">
                    {c.platform} · {c.status}
                    {c.launched ? '' : ' (not created)'}
                  </p>
                  <p className="row-sub">
                    ${(c.dailyBudgetCents / 100).toFixed(2)}/day{c.lastError ? ` · ${c.lastError}` : ''} · {when(c.updatedAt)}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="empty">No campaigns.</p>
        )}
      </section>
      <section className="card" aria-label="Problems and events">
        <h2 className="card-title">Problems and recent events</h2>
        {b.openFailures.length > 0 && (
          <ul className="rows" data-open-failures>
            {b.openFailures.map((x, n) => (
              <li key={n} className="row">
                <div className="row-main">
                  <p className="row-title bad">{x.action} failed</p>
                  <p className="row-sub">{[x.capability, x.details?.code || x.details?.error, when(x.at)].filter(Boolean).join(' · ')}</p>
                </div>
              </li>
            ))}
          </ul>
        )}
        {b.events.length ? (
          <ul className="rows" data-events>
            {b.events.slice(0, 25).map((e) => (
              <li key={e.seq} className="row">
                <div className="row-main">
                  <p className="row-title">
                    {e.action} <span className={`tag ${e.outcome === 'failure' ? 'tag--bad' : e.outcome === 'success' ? 'tag--ok' : ''}`}>{e.outcome}</span>
                  </p>
                  <p className="row-sub">
                    {e.actorType === 'admin' ? e.actor : e.actorType} · {when(e.at)}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="empty">No events recorded.</p>
        )}
      </section>
    </div>
  )
}

export default function Review() {
  const params = new URLSearchParams(window.location.search)
  const [view, setView] = useState(params.get('business') ? 'business' : 'platform')
  const [id, setIdState] = useState(params.get('business'))
  const [r, setR] = useState(null)
  useEffect(() => {
    api('/api/platform/review').then(({ status, data }) => setR(status === 200 ? data : { error: true }))
  }, [])
  const setId = (next) => {
    setIdState(next)
    setView('business')
    window.history.replaceState(null, '', next ? `/admin/review?business=${encodeURIComponent(next)}` : '/admin/review')
  }
  if (!r) return <p className="fine">Loading…</p>
  if (r.error) return <p className="form-error">Couldn’t load the Business Review.</p>
  return (
    <div className="enter review">
      <div className="page-head">
        <h1 className="title title--page">Business Review</h1>
      </div>
      <div className="seg" role="tablist" aria-label="Business Review views">
        {[
          ['platform', 'Platform'],
          ['business', 'Business'],
        ].map(([v, label]) => (
          <button key={v} type="button" role="tab" aria-selected={view === v} className={view === v ? 'seg-on' : ''} onClick={() => (v === 'platform' ? (setView('platform'), window.history.replaceState(null, '', '/admin/review')) : setView('business'))}>
            {label}
          </button>
        ))}
      </div>
      {view === 'platform' ? <Platform r={r} openBusiness={setId} /> : <Business list={r.businesses} id={id} setId={setId} />}
    </div>
  )
}
