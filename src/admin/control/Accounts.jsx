// Accounts: find any business by name (or id), filter to the ones that need help, and inspect one. The inspector is a
// read view of records (no sign-in as the customer). The only active check is the read-only calendar diagnosis.
import { useEffect, useMemo, useState } from 'react'
import { api } from '../../lib/api.js'
import { Badge, Empty, Facts, Link, LoadError, Loading, PageHead, Section, Severity, TestTag } from './ui.jsx'
import { ago, day, plural, when } from './lib.js'

const STAGE = { invited: 'Invited', calendar: 'Connecting calendar', hours: 'Setting hours', live: 'Live', suspended: 'Suspended' }
const READY_TONE = { verified: 'ok', configured: 'info', enabled: 'info', eligible: 'info', test_mode: 'neutral', not_set_up: 'neutral', disabled: 'neutral', failed: 'bad', not_applicable: 'neutral' }
const READY_LABEL = { verified: 'Verified working', configured: 'Configured · not verified', enabled: 'Enabled', eligible: 'Eligible', test_mode: 'Test mode', not_set_up: 'Not set up', disabled: 'Disabled', failed: 'Failed', not_applicable: 'Not applicable' }

const FILTERS = [
  ['all', 'All'],
  ['help', 'Needs help'],
  ['affected', 'Affected by incidents'],
  ['production', 'Production'],
  ['test', 'Test accounts'],
]
const PAGE = 25

export function AccountsList({ o, params, go }) {
  const filter = params.filter || 'all'
  const [q, setQ] = useState(params.q || '')
  const [shown, setShown] = useState(PAGE)
  const list = useMemo(() => {
    const term = q.trim().toLowerCase()
    return o.businesses
      .filter((b) => (filter === 'help' ? b.labels.length && !b.test : filter === 'affected' ? b.affected : filter === 'production' ? !b.test : filter === 'test' ? b.test : true))
      .filter((b) => !term || b.name.toLowerCase().includes(term) || b.id.includes(term))
      .sort((a, b) => Number(b.affected) - Number(a.affected) || Number(Boolean(b.labels.length)) - Number(Boolean(a.labels.length)) || a.name.localeCompare(b.name))
  }, [o.businesses, filter, q])
  return (
    <>
      <PageHead go={go} crumbs={[['Control Center', {}]]} title="Accounts" lede="Every business on the platform. Search by name, then open one to see its readiness, journey, incidents and history." />
      <div className="cc-toolbar">
        <label className="sr-only" htmlFor="cc-acc-search">
          Search accounts
        </label>
        <input
          id="cc-acc-search"
          className="cc-search"
          type="search"
          placeholder="Search by business name or id"
          value={q}
          onChange={(e) => {
            setQ(e.target.value)
            setShown(PAGE)
          }}
          autoComplete="off"
        />
      </div>
      <div className="cc-chips" role="group" aria-label="Filter accounts">
        {FILTERS.map(([id, label]) => (
          <button key={id} type="button" className="cc-chip" aria-pressed={filter === id} onClick={() => go({ view: 'accounts', filter: id === 'all' ? null : id }, { replace: true })}>
            {label}
          </button>
        ))}
      </div>
      <Section title={`${plural(list.length, 'account')}`} id="acc-list">
        {list.length ? (
          <>
            <ul className="cc-list">
              {list.slice(0, shown).map((b) => (
                <li key={b.id}>
                  <Link to={{ business: b.id }} go={go} className="cc-item" data-account-row={b.id} aria-label={`Open ${b.name}`}>
                    <span className="cc-item-main">
                      <span className="cc-item-title">
                        {b.name}
                        {b.test && <TestTag />}
                      </span>
                      <span className="cc-item-sub">
                        {b.id} · {STAGE[b.onboarding] || b.onboarding}
                        {b.createdAt ? ` · joined ${day(b.createdAt)}` : ''}
                      </span>
                    </span>
                    <span className="cc-item-meta">
                      {b.affected && <Badge tone="bad">Open incident</Badge>}
                      {b.labels.slice(0, 2).map((l) => (
                        <Badge key={l} tone="warn">
                          {l}
                        </Badge>
                      ))}
                      {!b.affected && !b.labels.length && <Badge tone="ok">No flags</Badge>}
                      <span className="cc-chev" aria-hidden="true">
                        ›
                      </span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
            {list.length > shown && (
              <div className="cc-section-body" style={{ paddingTop: 12 }}>
                <button type="button" className="btn btn-quiet btn-sm" onClick={() => setShown((n) => n + PAGE)}>
                  Show {Math.min(PAGE, list.length - shown)} more
                </button>
              </div>
            )}
          </>
        ) : (
          <Empty title="No account matches.">{q ? `Nothing found for “${q}”.` : 'Try another filter.'}</Empty>
        )}
      </Section>
    </>
  )
}

const STEP_ICON = { completed: '✓', failed: '!', current: '•', blocked: '–', skipped: '', unknown: '?' }
const STEP_STATE = { completed: 'Done', current: 'In progress', blocked: 'Waiting', failed: 'Failed', skipped: 'Not part of this setup', unknown: 'Unknown' }
const HISTORY = {
  'incident.opened': 'Incident opened',
  'incident.resolved': 'Incident resolved',
  'availability.failed': 'Booking page couldn’t load times',
  'availability.recovered': 'Booking page loaded times again',
  'booking.failed': 'A booking failed',
  'booking.recovered': 'Booking recovered',
  'booking.cancel': 'Booking cancelled',
  'website.publish': 'Website published',
  'website.unpublish': 'Website unpublished',
  'website.restore': 'Website version restored',
  'support.diagnose_calendar': 'Admin ran a calendar diagnosis',
  'receptionist.settings': 'Receptionist settings changed',
  'qa.human_run_started': 'Guided QA session started',
}
const MODE = { at_business: 'Customers come to the business', at_customer: 'The business visits the customer' }

export function AccountInspector({ id, go }) {
  const [a, setA] = useState(null)
  const [reload, setReload] = useState(0)
  const [diag, setDiag] = useState(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let live = true
    api(`/api/platform/inspector?business=${encodeURIComponent(id)}`).then(({ status, data }) => live && setA(status === 200 ? data : { error: status === 404 ? 'not_found' : status === 400 ? 'invalid' : 'failed' }))
    return () => {
      live = false
    }
  }, [id, reload])
  const diagnose = async () => {
    setBusy(true)
    const { status, data } = await api('/api/platform/inspector', { method: 'POST', body: { business: id, check: 'calendar' } })
    setBusy(false)
    setDiag(status === 200 ? data : { error: status === 429 ? 'Too many checks for this account. Try again in a few minutes.' : 'The check couldn’t run. Nothing was changed.' })
  }
  const crumbs = [
    ['Control Center', {}],
    ['Accounts', { view: 'accounts' }],
  ]
  if (!a) return <Loading label="Loading account…" />
  if (a.error === 'not_found' || a.error === 'invalid')
    return (
      <>
        <PageHead go={go} crumbs={crumbs} title="Account not found" />
        <Empty title="No business with this id.">Search for it by name in Accounts.</Empty>
      </>
    )
  if (a.error) return <LoadError what="this account" onRetry={() => setReload((n) => n + 1)} />
  const open = a.incidents.filter((i) => i.status === 'open')
  const failing = a.readiness.filter((r) => r.state === 'failed').length
  return (
    <div className="cc-main" data-account={id}>
      <PageHead go={go} crumbs={crumbs} title={a.identity.name}>
        {a.identity.test ? <TestTag /> : <Badge tone="info">Production</Badge>}
        {a.identity.status !== 'active' && <Badge tone="warn">{a.identity.status}</Badge>}
        {open.length > 0 && <Badge tone="bad">{plural(open.length, 'open incident')}</Badge>}
      </PageHead>
      <Facts
        items={[
          ['Business id', <span key="id" className="cc-code">{a.identity.id}</span>],
          ['Joined', day(a.identity.createdAt)],
          ['Journey', `${a.journey.title}${a.journey.type.incomplete ? ' · setup incomplete' : ''}`],
          a.identity.appointmentMode && ['Appointments', MODE[a.identity.appointmentMode] || a.identity.appointmentMode],
          ['Attention', a.identity.attention?.length ? a.identity.attention.map((x) => x.replace(/_/g, ' ')).join(', ') : 'None'],
        ]}
      />
      {open.length > 0 && (
        <Section title="Open incidents" id="acc-inc">
          <ul className="cc-list">
            {open.map((i) => (
              <li key={i.id}>
                <Link to={{ incident: i.id }} go={go} className="cc-item" data-incident={i.id}>
                  <span className="cc-item-main">
                    <span className="cc-item-title">{i.title}</span>
                    <span className="cc-item-sub">
                      {i.featureName || i.feature} · last {ago(i.lastSeen)}
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
            ))}
          </ul>
        </Section>
      )}
      <Section title="Readiness" id="acc-ready" sub={failing ? `${plural(failing, 'area')} failing.` : '“Configured” means set up but not yet seen working; only a recorded success counts as “Verified working”.'}>
        <div className="cc-section-body">
          <div className="cc-tiles">
            {a.readiness.map((r) => (
              <div key={r.id} className="cc-tile" data-readiness={r.id} data-state={r.state}>
                <h4>{r.label}</h4>
                <div>
                  <Badge tone={READY_TONE[r.state]}>{READY_LABEL[r.state] || r.state}</Badge>
                </div>
                <p>{r.detail}</p>
              </div>
            ))}
          </div>
          <div className="cc-actions">
            <button type="button" className="btn btn-quiet btn-sm" onClick={diagnose} disabled={busy}>
              {busy ? 'Checking calendar…' : 'Diagnose calendar (read-only)'}
            </button>
            <span className="cc-status-line">Asks Google for this account’s free/busy once. Changes nothing and doesn’t open or close incidents.</span>
          </div>
          <p className="cc-status-line" role="status" aria-live="polite" data-diagnosis={diag?.code || ''}>
            {diag &&
              (diag.error
                ? diag.error
                : diag.ok
                  ? `Calendar lookup works: ${diag.code === 'no_free_time' ? 'no free time in the booking window' : `${diag.openTimes} open times`} (${diag.ms} ms).`
                  : `Calendar lookup failed: ${diag.code}. ${diag.code === 'reconnect_required' ? 'The owner needs to reconnect Google Calendar.' : 'See the open incident for next steps.'}`)}
          </p>
        </div>
      </Section>
      <div className="cc-grid-2">
        <Section title={`Journey: ${a.journey.title}`} id="acc-journey" sub="Each step from records. A step is done only when its record says so.">
          <div className="cc-section-body">
            <ol className="cc-steps">
              {a.journey.steps.map((s) => (
                <li key={s.id} data-step={s.id} data-state={s.state}>
                  <span className={`cc-step-icon cc-step-icon--${s.state}`} aria-hidden="true">
                    {STEP_ICON[s.state]}
                  </span>
                  <span className="cc-step-body">
                    <strong>{s.title}</strong>
                    <span>
                      {s.state === 'skipped' && s.reasonText ? s.reasonText : `${STEP_STATE[s.state]}${s.reasonText ? ` · ${s.reasonText}` : s.reason ? ` · ${s.reason.replace(/_/g, ' ')}` : ''}`}
                    </span>
                  </span>
                </li>
              ))}
            </ol>
          </div>
        </Section>
        <div className="cc-main">
          <Section title="What the owner and customers see" id="acc-view" sub="Read-only previews from records. Support never signs in as the customer.">
            <div className="cc-section-body">
              <ul className="cc-steps">
                {a.customerView.ownerChecklist.map((s) => (
                  <li key={s.id}>
                    <span className={`cc-step-icon cc-step-icon--${s.done ? 'completed' : 'unknown'}`} aria-hidden="true">
                      {s.done ? '✓' : ''}
                    </span>
                    <span className="cc-step-body">
                      <strong>{s.title}</strong>
                      <span>{s.done ? 'Done in the owner’s checklist' : 'Still to do in the owner’s checklist'}</span>
                    </span>
                  </li>
                ))}
              </ul>
              <div className="cc-actions">
                {a.customerView.publicPages.length ? (
                  a.customerView.publicPages.map((p) => (
                    <a key={p.href} className="btn btn-quiet btn-sm" href={p.href} target="_blank" rel="noreferrer">
                      {p.label} ↗
                    </a>
                  ))
                ) : (
                  <span className="cc-status-line">No public page is live.</span>
                )}
              </div>
            </div>
          </Section>
          <Section title="Recent activity" id="acc-hist">
            {a.history.length ? (
              <div className="cc-section-body">
                <ul className="cc-timeline">
                  {a.history.slice(0, 12).map((h, k) => (
                    <li key={k}>
                      <time>{when(h.at)}</time>
                      <span>
                        {HISTORY[h.action] || h.action.replace(/[._]/g, ' ')} {h.outcome === 'failure' && <Badge tone="bad">failed</Badge>}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <Empty title="No recorded events yet." />
            )}
          </Section>
        </div>
      </div>
      <div className="cc-actions">
        <a className="btn btn-quiet btn-sm" href={`/admin/review?business=${encodeURIComponent(id)}`}>
          Business Review for this account
        </a>
        <Link to={{ view: 'qa', for: id }} go={go} className="btn btn-quiet btn-sm">
          Start guided QA with this account
        </Link>
      </div>
    </div>
  )
}
