// QA → Tests: the inventory as Platform → area → journey → feature → test, derived from the code by the server.
// Filters are URL state and run on the server; without a filter the tree arrives down to features and an area's
// tests load when it is opened (or selected). Multi-select: a branch selects every test under it; "Run selected",
// "Run flow" per journey and "Run" per test all open the plan first. A page per test shows its full, append-only
// history (newest first) with the release each result was recorded against, its evidence and linked items.
import { useCallback, useMemo, useState } from 'react'
import { Badge, Empty, Facts, Link, LoadError, Loading, PageHead, Section } from '../ui.jsx'
import * as qa from '../qa-api.js'
import { CLASS, ENV, RESULT, TEST_STATUS, who, countTotal, countsLine, duration, isTest, selectionState, sha, stamp, testIdsUnder, toggleSelection, usd } from '../qa-lib.js'
import { ClassPill, Counts, EnvLabel, EvidenceList, ItemStatus, ResultPill, TestStatus } from './parts.jsx'
import { useAreas, useLoad, usePlan } from './hooks.jsx'
import { ManualCard } from './Manual.jsx'

const crumbs = [
  ['Control Center', {}],
  ['QA', { view: 'qa' }],
]
const OPEN_ALL_LIMIT = 300
const hasUnloaded = (n) => !isTest(n) && (n.children === null || (n.children || []).some(hasUnloaded))
const findKey = (n, key) => (n.key === key ? n : isTest(n) ? null : (n.children || []).reduce((hit, c) => hit || findKey(c, key), null))
const total = (n) => countTotal(n.counts) || n.testCount || testIdsUnder(n).length

function Check({ state, onChange, label, busy }) {
  return (
    <input
      type="checkbox"
      className="qa-tree-check"
      checked={state === 'all'}
      ref={(el) => el && (el.indeterminate = state === 'some')}
      onChange={(e) => onChange(e.target.checked)}
      aria-label={label}
      aria-busy={busy || undefined}
      disabled={busy}
    />
  )
}

function Leaf({ t, go, ctx }) {
  // lastAny: the latest result of ANY status (e.g. skipped while a feature is switched off); never counted as verified.
  const last = t.lastAny || t.last
  return (
    <li className="qa-leaf" data-test-id={t.id} data-status={TEST_STATUS[t.status] ? t.status : 'untested'}>
      <Check state={ctx.selected.has(t.id) ? 'all' : 'none'} onChange={(on) => ctx.setSelected((s) => toggleSelection(s, [t.id], on))} label={`Select ${t.title}`} />
      <span className="qa-leaf-main">
        <Link to={{ view: 'qa', test: t.id }} go={go} className="qa-leaf-title">
          {t.title}
        </Link>
        <span className="cc-item-sub">
          {last ? `Last result ${RESULT[last.status]?.[1]?.toLowerCase() || last.status}, ${stamp(last.at)} on ${sha(last.revision || last.commit)} · ${ENV[last.environment] || last.environment}` : 'No result recorded'}
          {t.impact === 'uncertain' ? ' · impact of changes unknown' : ''}
          {t.mobile ? ' · phone' : ''}
        </span>
      </span>
      <span className="qa-leaf-meta">
        <TestStatus s={t.status} />
        <ClassPill c={t.class} />
        {t.class === 'automated' && (
          <button type="button" className="btn btn-quiet btn-sm" onClick={() => ctx.openPlan({ tests: [t.id] }, t.title)} aria-label={`Run ${t.title}`}>
            Run
          </button>
        )}
      </span>
    </li>
  )
}

function Branch({ node, depth, go, ctx, areaId }) {
  const [open, setOpen] = useState(null)
  const [busy, setBusy] = useState(false)
  const ids = useMemo(() => testIdsUnder(node), [node])
  const isOpen = open ?? (ctx.openAll || depth < 1)
  const unloaded = hasUnloaded(node)
  const n = total(node)
  const toggle = () => {
    if (!isOpen && unloaded) ctx.loadArea(areaId)
    setOpen(!isOpen)
  }
  // Selecting a branch whose tests haven't loaded loads its area first, then selects exactly the tests under it.
  const select = async (on) => {
    if (on && unloaded) {
      setBusy(true)
      const loaded = await ctx.loadArea(areaId)
      setBusy(false)
      const fresh = loaded && findKey(loaded, node.key)
      if (fresh) ctx.setSelected((s) => toggleSelection(s, testIdsUnder(fresh), true))
      return
    }
    ctx.setSelected((s) => toggleSelection(s, ids, on))
  }
  // While its tests load, a just-ticked branch already shows as ticked (and waits, disabled).
  const state = busy ? 'all' : unloaded && !ids.length ? 'none' : selectionState(ctx.selected, ids)
  return (
    <li className={`qa-branch qa-branch--${node.kind}`} data-node={node.key} data-kind={node.kind}>
      <div className="qa-branch-row">
        <Check state={state} busy={busy} onChange={select} label={`Select every test in ${node.title}`} />
        <button type="button" className="qa-branch-toggle" aria-expanded={isOpen} onClick={toggle}>
          <span aria-hidden="true">{isOpen ? '▾' : '▸'}</span>
          <span className="qa-branch-title">{node.title}</span>
          <span className="cc-item-sub">
            {node.kind === 'journey' ? 'Journey · ' : node.kind === 'feature' ? 'Feature · ' : ''}
            {n} {n === 1 ? 'test' : 'tests'} · {countsLine(node.counts || {})}
          </span>
        </button>
        {node.kind === 'journey' && node.runnable && (
          <button type="button" className="btn btn-quiet btn-sm" onClick={() => ctx.openPlan({ journeys: [node.id] }, `Journey: ${node.title}`)} aria-label={`Run the ${node.title} journey`}>
            Run flow
          </button>
        )}
      </div>
      {isOpen &&
        (node.children === null ? (
          <p className="cc-status-line qa-tree-note" aria-busy="true">
            Loading tests…
          </p>
        ) : (
          <ul className="qa-tree">
            {node.children.map((c) => (isTest(c) ? <Leaf key={c.key} t={c} go={go} ctx={ctx} /> : <Branch key={c.key} node={c} depth={depth + 1} go={go} ctx={ctx} areaId={areaId} />))}
          </ul>
        ))}
    </li>
  )
}

export function TestsView({ params, go }) {
  const filtered = !!(params.q || params.status || params.cls || params.area)
  const [d, reload] = useLoad(() => qa.getInventory(filtered ? { q: params.q, status: params.status, cls: params.cls, area: params.area, detail: true } : {}), [params.q, params.status, params.cls, params.area])
  const [summary] = useLoad(() => qa.getInventory({}), [])
  const [areas, setAreas] = useState({})
  const [selected, setSelected] = useState(() => new Set())
  const [openPlan, plan] = usePlan(go)
  const [q, setQ] = useState(params.q || '')
  const set = (k, v) => go({ ...params, view: 'qa', tab: 'tests', [k]: v || null }, { replace: true })
  const inv = useMemo(() => (d && !d.error ? qa.normalizeInventory(d) : null), [d])
  const areaList = useMemo(() => (summary && !summary.error ? qa.normalizeInventory(summary).areaList : inv?.areaList || []), [summary, inv])
  const loadArea = useCallback(
    async (id) => {
      if (areas[id]) return areas[id]
      const r = await qa.getInventory({ area: id, detail: true })
      const node = r.ok ? qa.normalizeInventory(r.data).areas.find((a) => a.id === id) : null
      if (node) setAreas((m) => ({ ...m, [id]: node }))
      return node
    },
    [areas],
  )
  const tree = inv ? inv.areas.map((a) => (!filtered && areas[a.id]) || a) : []
  const matching = tree.reduce((n, a) => n + total(a), 0)
  const ctx = { selected, setSelected, openPlan, loadArea, openAll: filtered && matching <= OPEN_ALL_LIMIT }
  const head = <PageHead go={go} crumbs={[crumbs[0]]} title="Tests" lede="Every test we have, derived from the code. Select tests or whole branches to run them together; open a test for its full history." />
  return (
    <div className="cc-main" data-qa-tests>
      {head}
      {plan}
      <form
        className="cc-toolbar qa-filters"
        role="search"
        onSubmit={(e) => {
          e.preventDefault()
          set('q', q.trim())
        }}
      >
        <label className="sr-only" htmlFor="qa-q">
          Search tests
        </label>
        <input id="qa-q" className="cc-search" type="search" placeholder="Search tests, files or features" value={q} onChange={(e) => setQ(e.target.value)} onBlur={() => q.trim() !== (params.q || '') && set('q', q.trim())} />
        <label className="field qa-filter" htmlFor="qa-f-area">
          <span>Area</span>
          <select id="qa-f-area" value={params.area || ''} onChange={(e) => set('area', e.target.value)}>
            <option value="">All areas</option>
            {areaList.map((a) => (
              <option key={a.id} value={a.id}>
                {a.title}
              </option>
            ))}
          </select>
        </label>
        <label className="field qa-filter" htmlFor="qa-f-status">
          <span>Status</span>
          <select id="qa-f-status" value={params.status || ''} onChange={(e) => set('status', e.target.value)}>
            <option value="">Any status</option>
            {Object.entries(TEST_STATUS).map(([k, [, l]]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <label className="field qa-filter" htmlFor="qa-f-cls">
          <span>Kind</span>
          <select id="qa-f-cls" value={params.cls || ''} onChange={(e) => set('cls', e.target.value)}>
            <option value="">Any kind</option>
            {Object.entries(CLASS).map(([k, [, l]]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </select>
        </label>
      </form>
      {d === undefined ? (
        <Loading label="Loading the test inventory…" />
      ) : d.error ? (
        <LoadError what="the test inventory" onRetry={reload} />
      ) : (
        <>
          <p className="cc-status-line" role="status" data-qa-matching={matching}>
            {matching} {matching === 1 ? 'test' : 'tests'}
            {filtered ? ' match' : ' in the inventory'}
            {inv.generatedAt ? ` · inventory built ${stamp(inv.generatedAt)}` : ''}
            {filtered && matching > OPEN_ALL_LIMIT ? ' · open a branch to see its tests' : ''}
          </p>
          {!filtered && inv.platform?.counts && <Counts counts={inv.platform.counts} go={go} />}
          {tree.length ? (
            <ul className="qa-tree qa-tree--root" aria-label="Test inventory">
              {tree.map((a) => (
                <Branch key={a.key} node={a} depth={params.area ? 0 : 1} go={go} ctx={ctx} areaId={a.id} />
              ))}
            </ul>
          ) : (
            <Empty title="No test matches these filters.">
              <button type="button" className="link-btn" onClick={() => (setQ(''), go({ view: 'qa', tab: 'tests' }, { replace: true }))}>
                Clear the filters
              </button>
            </Empty>
          )}
          {!filtered && (inv.gaps.length > 0 || countTotal(inv.unassigned?.counts) > 0) && (
            <Section title="Coverage gaps" id="qa-gaps" sub="Functionality with no automated test and no recent manual result, and tests no area claims.">
              <ul className="cc-list" data-qa-gaps>
                {inv.gaps.map((g) => (
                  <li key={`${g.kind}:${g.id}`} className="cc-item qa-row" data-gap={g.id}>
                    <span className="cc-item-main">
                      <span className="cc-item-title">{g.title}</span>
                      <span className="cc-item-sub">
                        {areaList.find((a) => a.id === g.area)?.title || g.area} · {g.why}
                      </span>
                    </span>
                    <span className="cc-item-meta">
                      <Badge tone="warn">{g.kind === 'capability' ? 'No coverage' : 'Never checked'}</Badge>
                    </span>
                  </li>
                ))}
                {countTotal(inv.unassigned?.counts) > 0 && (
                  <li className="cc-item qa-row" data-gap="unassigned">
                    <span className="cc-item-main">
                      <span className="cc-item-title">
                        {countTotal(inv.unassigned.counts)} {countTotal(inv.unassigned.counts) === 1 ? 'test has' : 'tests have'} no product area
                      </span>
                      <span className="cc-item-sub">{qa.arr(inv.unassigned.files).join(', ')}</span>
                    </span>
                    <span className="cc-item-meta">
                      <Badge tone="warn">Unassigned</Badge>
                    </span>
                  </li>
                )}
              </ul>
            </Section>
          )}
        </>
      )}
      {selected.size > 0 && !plan && (
        <div className="qa-selbar" role="region" aria-label="Selected tests" data-qa-selection={selected.size}>
          <span>
            <b>{selected.size}</b> {selected.size === 1 ? 'test' : 'tests'} selected
          </span>
          <button type="button" className="btn btn-primary btn-sm" onClick={() => openPlan({ tests: [...selected] }, `${selected.size} selected ${selected.size === 1 ? 'test' : 'tests'}`)} data-run-selected>
            Run selected
          </button>
          <button type="button" className="btn btn-quiet btn-sm" onClick={() => setSelected(new Set())}>
            Clear selection
          </button>
        </div>
      )}
    </div>
  )
}

// ---------- one test ----------
export function TestDetail({ id, go }) {
  const [d, reload] = useLoad(() => qa.getTest(id), [id])
  const [openPlan, plan] = usePlan(go)
  const areas = useAreas()
  if (d === undefined) return <Loading label="Loading the test…" />
  if (d.error) return d.status === 404 ? <Empty title="Test not found.">It may have been removed or renamed in the code. Open Tests to find it.</Empty> : <LoadError what="this test" onRetry={reload} />
  const t = d.test || {}
  const history = qa.arr(d.history)
  const lastPass = history.find((h) => h.status === 'pass')
  const st = TEST_STATUS[t.status] ? t.status : 'untested'
  const manual = t.class === 'human' || t.class === 'ai_assisted'
  return (
    <div className="cc-main" data-qa-test={t.id}>
      <PageHead go={go} crumbs={[...crumbs, ['Tests', { view: 'qa', tab: 'tests' }]]} title={t.title || t.id}>
        <TestStatus s={st} />
        <ClassPill c={t.class} />
      </PageHead>
      {plan}
      <div className={`cc-callout${st === 'failed' ? ' cc-callout--warn' : st === 'verified' ? ' cc-callout--ok' : ''}`} data-verified-at={lastPass?.at || ''}>
        <strong>{TEST_STATUS[st][2]}.</strong>
        <span data-last-pass>
          {lastPass
            ? `Last passed ${stamp(lastPass.at)} on ${sha(lastPass.revision)}${lastPass.deployment ? ` (deployment ${String(lastPass.deployment).slice(0, 8)})` : ''}, ${ENV[lastPass.environment] || lastPass.environment}.`
            : 'It has never passed.'}
        </span>
        {t.lastAny && t.lastAny.status !== 'pass' && t.lastAny.status !== 'fail' && (
          <span data-last-any>
            Latest result: {RESULT[t.lastAny.status]?.[1] || t.lastAny.status}, {stamp(t.lastAny.at)}. It doesn’t count as verified.
          </span>
        )}
        {t.impact === 'uncertain' && <span>We can’t tell which code this test depends on, so recent changes may affect it. A broader regression run is recommended.</span>}
      </div>
      <Facts
        items={[
          t.area && ['Area', t.areaTitle || areas.find((a) => a.id === t.area)?.title || t.area],
          t.journey && ['Journey', t.journeyTitle || t.journey],
          t.feature && ['Feature', t.featureTitle || t.feature],
          t.file && ['File', <span key="f" className="cc-code">{t.file}</span>],
          ['Kind', CLASS[t.class]?.[1] || t.class || 'Unknown'],
          t.hashes?.def && ['Definition version', <span key="h" className="cc-code">{String(t.hashes.def).slice(0, 10)}</span>],
          t.estimate && ['Estimated', `${duration(t.estimate.ms)} · ${usd(qa.usdOf(t.estimate))}`],
        ]}
      />
      {(t.command || qa.arr(t.covers).length > 0) && (
        <details className="cc-details">
          <summary>How it runs and what it covers</summary>
          {t.command && <pre className="qa-pre">{t.command}</pre>}
          {qa.arr(t.covers).length > 0 && <p className="cc-status-line">Covers: {t.covers.join(', ')}</p>}
        </details>
      )}
      <div className="cc-actions">
        {t.class === 'automated' && (
          <button type="button" className="btn btn-primary btn-sm" onClick={() => openPlan({ tests: [t.id] }, t.title || t.id)} data-run-test>
            Run this test
          </button>
        )}
        {t.class === 'authorization' && (
          <button type="button" className="btn btn-quiet btn-sm" onClick={() => openPlan({ tests: [t.id], includePaid: true }, t.title || t.id)}>
            Plan a run (needs approval)
          </button>
        )}
        <Link to={{ view: 'qa', tab: 'defects', from: t.id }} go={go} className="btn btn-quiet btn-sm">
          Record a defect
        </Link>
      </div>
      {manual && (
        <Section title="Record a result" id="qa-t-record">
          <div className="cc-section-body">
            <ManualCard t={t} go={go} onSaved={() => reload(true)} />
          </div>
        </Section>
      )}
      <Section title="History" id="qa-t-hist" sub="Every recorded result, newest first, with the release it was recorded against. A retest adds a row; earlier failures are kept.">
        {history.length ? (
          <ul className="cc-list" data-qa-history-rows>
            {history.map((h) =>
              h.source === 'unchanged' ? (
                // A pass recorded compactly on its run: the test passed again with identical code and dependencies.
                <li key={h.id} className="cc-item qa-row qa-row--compact" data-result-id={h.id} data-result="pass" data-unchanged>
                  <span className="cc-item-main">
                    <span className="cc-item-sub">
                      {stamp(h.at)} · <span className="cc-code">{sha(h.revision)}</span> · passed again, code unchanged
                    </span>
                  </span>
                  <span className="cc-item-meta">
                    <ResultPill s="pass" />
                    <EnvLabel e={h.environment} />
                    {h.executionId && (
                      <Link to={{ view: 'qa', exec: h.executionId }} go={go} className="cc-more">
                        Run →
                      </Link>
                    )}
                  </span>
                </li>
              ) : (
              <li key={h.id} className="cc-item qa-row" data-result-id={h.id} data-result={h.status}>
                <span className="cc-item-main">
                  <span className="cc-item-title">
                    {stamp(h.at)} · <span className="cc-code">{sha(h.revision)}</span>
                    {h.deployment ? ` · deployment ${String(h.deployment).slice(0, 8)}` : ''}
                  </span>
                  <span className="cc-item-sub">
                    {[h.reviewer ? `Recorded by ${who(h.reviewer)}${h.confirmedAt ? ` at ${stamp(h.confirmedAt)}` : ''}` : h.source === 'legacy' ? 'Earlier CI run' : 'Automated', h.provider === 'real' ? 'real providers' : h.provider === 'mocked' ? 'stand-in providers' : null, h.ms != null ? duration(h.ms) : null, h.costMicros ? `cost ${usd(h.costMicros / 1e6)}` : null, h.model ? `model ${h.model}` : null, h.retestOf ? 'retest' : null]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                  {h.expected && <span className="cc-item-sub">Expected: {h.expected}</span>}
                  {h.actual && <span className="cc-item-sub">Actual: {h.actual}</span>}
                  {/^in-process, not through the edge/.test(h.actual || '') && (
                    <span>
                      <Badge tone="warn" plain>
                        In-process, not through the live site: doesn’t count as production verification
                      </Badge>
                    </span>
                  )}
                  {h.aiAssessment && (
                    <span className="cc-item-sub">
                      <Badge tone="info" plain>
                        AI assessment, not a verified result
                      </Badge>{' '}
                      {h.aiAssessment.text || String(h.aiAssessment)}
                    </span>
                  )}
                </span>
                <span className="cc-item-meta">
                  <ResultPill s={h.status} />
                  <EnvLabel e={h.environment} />
                  {h.executionId ? (
                    <Link to={{ view: 'qa', exec: h.executionId }} go={go} className="cc-more">
                      Run →
                    </Link>
                  ) : h.runId ? (
                    <Link to={{ run: h.runId }} go={go} className="cc-more">
                      Run →
                    </Link>
                  ) : null}
                  {h.status === 'fail' && (
                    <Link to={{ view: 'qa', tab: 'defects', from: t.id, result: h.source === 'legacy' ? null : h.id }} go={go} className="btn btn-quiet btn-sm" data-defect-from={h.id}>
                      Record defect
                    </Link>
                  )}
                </span>
              </li>
              ),
            )}
          </ul>
        ) : (
          <Empty title="Untested.">No result has been recorded for this test.</Empty>
        )}
      </Section>
      <Section title="Evidence" id="qa-t-ev">
        <div className="cc-section-body">
          <EvidenceList items={d.evidence} />
        </div>
      </Section>
      <Section title="Defects and ideas" id="qa-t-items">
        {qa.arr(d.items).length ? (
          <ul className="cc-list">
            {d.items.map((i) => (
              <li key={i.id}>
                <Link to={{ view: 'qa', item: i.id }} go={go} className="cc-item">
                  <span className="cc-item-main">
                    <span className="cc-item-title">{i.title}</span>
                  </span>
                  <span className="cc-item-meta">
                    <ItemStatus item={i} />
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <Empty title="None linked." />
        )}
      </Section>
    </div>
  )
}
