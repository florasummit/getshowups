// QA → Overview: release readiness from recorded results only. Production version and deploy time, the readiness
// line (counts with their denominator, never a bare percentage), the setup checklist while CI dispatch / result ingest /
// paid checks aren't configured, the run presets (each opens its plan), status counts (each a drill-down), automated
// vs manual progress, what changed in the release and what is stale, blockers, recommended next, history, spending.
import { Empty, Facts, Link, LoadError, Loading, PageHead, Section, Severity } from '../ui.jsx'
import * as qa from '../qa-api.js'
import { CLASS, ENV, PRESETS, countTotal, scopeText, sha, share, stamp, usd } from '../qa-lib.js'
import { Counts, EnvLabel, ExecPill, ItemStatus } from './parts.jsx'
import { useLoad, usePlan } from './hooks.jsx'
import { QaSettings } from './Settings.jsx'

function Setup({ setup }) {
  if (!setup.missing.length) return null
  return (
    <div className="cc-callout cc-callout--warn" data-qa-setup>
      <strong>Some of QA isn’t connected yet</strong>
      <span>Runs that depend on these steps are refused until they’re done (never left waiting). Read-only production checks and manual checks work now.</span>
      <ol className="qa-plain-list" data-qa-setup-steps>
        {setup.missing.map((m, k) => (
          <li key={m.id || k} data-setup-step={m.id || k}>
            {qa.setupText(m)}
          </li>
        ))}
      </ol>
      <span className="cc-status-line">
        Start automated runs from here: {setup.ciDispatch ? 'yes' : 'not yet'} · receive CI results: {setup.ingest ? 'yes' : 'not yet'} · production checks: {setup.productionChecks ? 'yes' : 'not yet'} · paid AI and voice checks: {setup.paidEvals ? 'authorized within the QA budget' : 'off'}
      </span>
    </div>
  )
}

function Readiness({ o }) {
  const c = o.counts
  const total = countTotal(c)
  const verified = Number(c.verified) || 0
  const failed = Number(c.failed) || 0
  const open = o.blockers.length
  const tone = failed || open ? 'bad' : !total || verified < total ? 'warn' : 'ok'
  const title = open ? `${open === 1 ? '1 launch blocker' : `${open} launch blockers`} open` : failed ? `${failed === 1 ? '1 test' : `${failed} tests`} failing on this release` : !total ? 'No tests recorded yet' : verified === total ? 'Every test is verified on this release' : 'Not fully verified on this release'
  return (
    <div className={`cc-banner cc-banner--${tone}`} role="status" data-qa-readiness={tone}>
      <span className="cc-banner-dot" aria-hidden="true" />
      <div>
        <strong>{title}</strong>
        <span>
          Verified on the current release: {share(verified, total)}.{c.verified_ci_only ? ` ${c.verified_ci_only} more passed in CI only.` : ''}
          {c.untested ? ` ${c.untested} untested.` : ''}
          {c.stale ? ` ${c.stale} stale since their last pass.` : ''} From recorded results only.
        </span>
      </div>
    </div>
  )
}

// Automated vs manual progress, per class, each with its own denominator.
function ByClass({ byClass, go }) {
  if (!byClass) return null
  return (
    <ul className="qa-classes" data-qa-classes>
      {Object.entries(CLASS).map(([c, [, label]]) => {
        const x = byClass[c]
        if (!x || !countTotal(x)) return null
        const done = (Number(x.verified) || 0) + (Number(x.verified_ci_only) || 0)
        return (
          <li key={c}>
            <Link to={{ view: 'qa', tab: c === 'human' || c === 'ai_assisted' ? 'manual' : 'tests', cls: c === 'human' || c === 'ai_assisted' ? null : c }} go={go} className="qa-count" data-class={c}>
              <span className="cc-label">{label}</span>
              <b>{done}</b>
              <small>
                verified of {countTotal(x)} · {x.failed || 0} failed · {x.untested || 0} untested
              </small>
            </Link>
          </li>
        )
      })}
    </ul>
  )
}

function HistoryRow({ h, go }) {
  if (h.type === 'release')
    return (
      <li>
        <time>{stamp(h.at)}</time>
        <span>
          Released <span className="cc-code">{sha(h.commit)}</span>
          {h.previous ? (
            <>
              {' '}
              after <span className="cc-code">{sha(h.previous)}</span>
            </>
          ) : null}
          {qa.arr(h.pendingMigrations).length ? ` · ${h.pendingMigrations.length} migrations not applied` : ''}
        </span>
      </li>
    )
  if (h.type === 'run')
    return (
      <li>
        <time>{stamp(h.at)}</time>
        <span>
          <Link to={{ run: h.id }} go={go} className="cc-more">
            Earlier CI run
          </Link>{' '}
          {h.summary ? `${h.summary.pass ?? 0} passed · ${h.summary.fail ?? 0} failed` : ''} · <span className="cc-code">{sha(h.commit)}</span>
        </span>
      </li>
    )
  return (
    <li>
      <time>{stamp(h.at)}</time>
      <span>
        <Link to={{ view: 'qa', exec: h.id }} go={go} className="cc-more">
          {scopeText(h)}
        </Link>{' '}
        <ExecPill s={h.status} /> <EnvLabel e={h.environment} />
        {h.progress ? ` ${h.progress.pass ?? 0} passed · ${h.progress.fail ?? 0} failed` : ''}
      </span>
    </li>
  )
}

export function QaOverview({ go }) {
  const [d, reload] = useLoad(qa.getOverview, [])
  const [openPlan, plan] = usePlan(go)
  const head = <PageHead go={go} title="QA" lede="Release readiness from recorded results. A test with no result is untested, and an AI opinion never counts as a pass." />
  if (d === undefined)
    return (
      <>
        {head}
        <Loading label="Loading QA…" />
      </>
    )
  if (d.error)
    return (
      <>
        {head}
        <LoadError what="QA" onRetry={reload} />
      </>
    )
  const o = qa.normalizeOverview(d)
  if (!o.available)
    return (
      <>
        {head}
        <Empty title="QA records aren’t set up in this environment yet.">Guided checks still work under Manual.</Empty>
      </>
    )
  const p = o.production
  const f = o.freshness
  return (
    <div className="cc-main" data-qa-overview>
      {head}
      <Readiness o={o} />
      <Setup setup={o.setup} />
      <Facts
        items={[
          ['Production version', p?.commit ? <span key="c" className="cc-code" data-prod-commit>{sha(p.commit)}</span> : 'Unknown'],
          ['Deployed', p?.builtAt ? stamp(p.builtAt) : 'Unknown'],
          p?.deployment && ['Deployment', <span key="d" className="cc-code">{String(p.deployment).slice(0, 8)}</span>],
          ['Latest QA run', o.latest ? <Link key="l" to={{ view: 'qa', exec: o.latest.id }} go={go} className="cc-more">{stamp(o.latest.finishedAt || o.latest.requestedAt)} →</Link> : 'None yet'],
        ]}
      />
      <Section title="Run tests" id="qa-run" sub="Each one shows its plan first: scope, where it runs, time, cost, and any approval needed. Nothing starts until you confirm.">
        <div className="cc-section-body">
          {plan}
          <div className="qa-presets">
            {PRESETS.map(([id, label, hint], k) => (
              <button key={id} type="button" className={`qa-preset${k === 0 ? ' qa-preset--primary' : ''}`} onClick={() => openPlan({ preset: id }, label)} data-preset={id}>
                <strong>{label}</strong>
                <span>{hint}</span>
              </button>
            ))}
            <Link to={{ view: 'qa', tab: 'manual' }} go={go} className="qa-preset" data-preset="manual_continue">
              <strong>Continue manual QA</strong>
              <span>{o.manual ? `${share(o.manual.done, o.manual.total)} manual checks recorded${qa.arr(o.manual.inProgress).length ? ` · ${o.manual.inProgress.length} guided ${o.manual.inProgress.length === 1 ? 'session' : 'sessions'} in progress` : ''}.` : 'Guided checks that need a person.'}</span>
            </Link>
          </div>
        </div>
      </Section>
      <Section title="Status on the current release" id="qa-status" action={<Link to={{ view: 'qa', tab: 'tests' }} go={go} className="cc-more">All tests →</Link>} sub="Open any count to see those tests.">
        <div className="cc-section-body">
          <Counts counts={o.counts} go={go} />
          <ByClass byClass={o.byClass} go={go} />
        </div>
      </Section>
      {f && (
        <Section title="What changed" id="qa-fresh" sub="Results are tied to the code they ran against. Only tests whose code or definition changed are marked stale.">
          <div className="cc-section-body" data-qa-freshness>
            <p className="cc-status-line">
              Current release <span className="cc-code">{sha(f.release?.commit)}</span>
              {f.release?.previous ? (
                <>
                  {' '}
                  replaced <span className="cc-code">{sha(f.release.previous)}</span>
                </>
              ) : null}
              {f.release?.at ? ` on ${stamp(f.release.at)}` : ''}.{' '}
              {f.hashesAvailable === false ? 'Change tracking isn’t available for this release, so nothing could be marked stale.' : `${f.stale || 0} ${f.stale === 1 ? 'test is' : 'tests are'} stale since then.`}
            </p>
            {f.uncertain > 0 && (
              <p className="cc-status-line" data-qa-uncertain>
                {f.uncertainNote || `${f.uncertain} tests can’t be traced to the code they cover.`}
              </p>
            )}
            <div className="cc-actions">
              {f.stale > 0 && (
                <button type="button" className="btn btn-quiet btn-sm" onClick={() => openPlan({ preset: 'affected' }, 'Tests affected by recent changes')}>
                  Plan the affected tests
                </button>
              )}
              {f.uncertain > 0 && (
                <button type="button" className="btn btn-quiet btn-sm" onClick={() => openPlan({ preset: 'regression' }, 'Comprehensive regression')}>
                  Plan a broader regression
                </button>
              )}
            </div>
          </div>
        </Section>
      )}
      <div className="cc-grid-2">
        <Section title="Launch blockers" id="qa-blockers" action={<Link to={{ view: 'qa', tab: 'defects' }} go={go} className="cc-more">All defects →</Link>} sub="Open bugs and regressions of critical or high severity.">
          {o.blockers.length ? (
            <ul className="cc-list">
              {o.blockers.map((b) => (
                <li key={b.id}>
                  <Link to={{ view: 'qa', item: b.id }} go={go} className="cc-item" data-blocker={b.id}>
                    <span className="cc-item-main">
                      <span className="cc-item-title">{b.title}</span>
                      <span className="cc-item-sub">
                        {[b.area, b.feature].filter(Boolean).join(' · ') || 'No area set'} · recorded {stamp(b.createdAt)}
                      </span>
                    </span>
                    <span className="cc-item-meta">
                      <Severity s={b.severity} />
                      <ItemStatus item={b} />
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <Empty title="No open critical or high defects recorded.">That says nothing about untested areas: see the counts above.</Empty>
          )}
        </Section>
        <Section title="Recommended next" id="qa-next" sub="From recorded results: failed, stale, never checked in production, never recorded.">
          {o.recommended.length ? (
            <ul className="cc-list">
              {o.recommended.map((r, k) => (
                <li key={k} className="cc-item qa-row" data-recommended={r.preset || r.journey || k}>
                  <span className="cc-item-main">
                    <span className="cc-item-title">{r.title}</span>
                    <span className="cc-item-sub">{r.why}</span>
                  </span>
                  <span className="cc-item-meta">
                    {r.kind === 'journey' ? (
                      <Link to={{ view: 'qa', tab: 'manual', journey: r.journey }} go={go} className="btn btn-quiet btn-sm">
                        Start guided check
                      </Link>
                    ) : (
                      <button type="button" className="btn btn-quiet btn-sm" onClick={() => openPlan(r.preset ? { preset: r.preset } : { tests: qa.arr(r.testIds) }, r.title)}>
                        Plan run
                      </button>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <Empty title="Nothing recommended right now." />
          )}
        </Section>
      </div>
      <div className="cc-grid-2">
        <Section title="Recent releases and runs" id="qa-history" action={<Link to={{ view: 'qa', tab: 'runs' }} go={go} className="cc-more">All runs →</Link>}>
          <div className="cc-section-body">
            {o.history.length ? (
              <ol className="cc-timeline qa-history" data-qa-history>
                {o.history.slice(0, 12).map((h, k) => (
                  <HistoryRow key={`${h.type}:${h.id || h.commit || k}`} h={h} go={go} />
                ))}
              </ol>
            ) : (
              <p className="cc-status-line">No releases or runs recorded yet.</p>
            )}
          </div>
        </Section>
        <Section title="QA spending" id="qa-spend" sub="Only paid AI and voice checks cost money; everything else is free.">
          <div className="cc-section-body" data-qa-spend data-paid={o.spend?.paidEnabled ? 'on' : 'off'}>
            {o.spend ? (
              <>
                <Facts
                  items={[
                    ['Spent this month', usd(o.spend.spent, { free: false })],
                    o.spend.reserved ? ['Reserved for running checks', usd(o.spend.reserved, { free: false })] : null,
                    ['Monthly QA budget', o.spend.budget ? usd(o.spend.budget, { free: false }) : 'None (paid checks off)'],
                    ['Available', o.spend.available != null ? usd(o.spend.available, { free: false }) : 'Unknown'],
                    ['Paid checks', o.spend.paidEnabled ? 'Authorized' : 'Off'],
                  ]}
                />
                {!o.spend.paidEnabled && <p className="cc-status-line">Paid checks never run without an authorized budget. Free checks are unaffected.</p>}
              </>
            ) : (
              <p className="cc-status-line">Spending isn’t available.</p>
            )}
            <QaSettings />
          </div>
        </Section>
      </div>
      {o.latest && (
        <Section title="Latest run" id="qa-latest">
          <div className="cc-section-body">
            <p className="cc-status-line">
              <ExecPill s={o.latest.status} /> {scopeText(o.latest)} · {ENV[o.latest.environment] || o.latest.environment} · requested {stamp(o.latest.requestedAt)}
              {o.latest.finishedAt ? ` · finished ${stamp(o.latest.finishedAt)}` : ''}
              {o.latest.progress ? ` · ${o.latest.progress.done} of ${o.latest.progress.total} done, ${o.latest.progress.fail ?? 0} failed` : ''}
            </p>
            <Link to={{ view: 'qa', exec: o.latest.id }} go={go} className="cc-more">
              Open the run →
            </Link>
          </div>
        </Section>
      )}
    </div>
  )
}
