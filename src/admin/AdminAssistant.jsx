// The platform-admin assistant (server/admin-assist/, /api/platform/assist): the "This week" card at the top of
// Admin → Overview (deterministic, no AI) and the Assistant side panel from the admin header (docked beside the page on
// wide screens, a bottom sheet on phones; the same .help-panel styles as the owner's assistant). The panel opens with the
// brief; questions go to the model; prepared changes show an Approve card and only that button does anything.
// The conversation lives in this page only (never stored). Keyboard: the panel takes focus, Escape closes it.
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import Icon from '../components/Icon.jsx'
import { api } from '../lib/api.js'
import { Pill } from '../dashboard/ui.jsx'
import { loadBrief, openAssistant, setAssistant as set, useAssistant as useStore } from './admin-assistant-store.js'

const LEVEL = { urgent: ['Urgent', 'bad'], important: ['Important', 'warn'], fyi: ['FYI', 'neutral'] }
const IDEAS = ['What needs me this week?', 'Is anything broken?', 'Which enrollments are stuck?', 'How much did AI cost yesterday?']
const PANEL_ID = 'admin-assistant'

function go(href, e) {
  if (!href || !href.startsWith('/admin')) return
  e?.preventDefault()
  window.history.pushState(null, '', href)
  window.dispatchEvent(new PopStateEvent('popstate'))
}

function BriefList({ items, limit = 50 }) {
  if (!items.length) return <p className="empty">Nothing needs you right now.</p>
  return (
    <ul className="rows" data-brief-items>
      {items.slice(0, limit).map((i) => (
        <li key={i.id} className="row" data-brief-level={i.level}>
          <div className="row-main">
            <p className="row-title">
              <Pill tone={LEVEL[i.level][1]}>{LEVEL[i.level][0]}</Pill> {i.title}
            </p>
            {i.detail && <p className="row-sub">{i.detail}</p>}
            <p className="row-sub">
              {i.next}{' '}
              <a className="link-btn" href={i.href} onClick={(e) => go(i.href, e)}>
                Open
              </a>
            </p>
          </div>
        </li>
      ))}
    </ul>
  )
}

// Admin → Overview: "This week", first thing on the page.
export function ThisWeek() {
  const s = useStore()
  const [all, setAll] = useState(false)
  useEffect(() => {
    loadBrief()
  }, [])
  if (!s.loaded) return <section className="card" aria-busy="true" data-this-week />
  if (!s.brief) return <section className="card" data-this-week><h2 className="card-title">This week</h2><p className="form-error">Couldn’t load this week’s list.</p></section>
  const { items, counts } = s.brief
  const shown = all ? items : items.filter((i) => i.level !== 'fyi').slice(0, 8)
  return (
    <section className="card" aria-labelledby="this-week-title" data-this-week>
      <div className="page-head">
        <h2 className="card-title" id="this-week-title">
          This week
        </h2>
        {s.enabled && (
          <button type="button" className="btn btn-quiet btn-sm" onClick={() => openAssistant()}>
            Ask the assistant
          </button>
        )}
      </div>
      <p className="fine">
        {counts.urgent} urgent · {counts.important} important · {counts.fyi} FYI. From the records, no AI.
      </p>
      <BriefList items={shown} />
      {items.length > shown.length && (
        <div>
          <button type="button" className="btn btn-quiet btn-sm" onClick={() => setAll(true)}>
            Show all {items.length}
          </button>
        </div>
      )}
      {s.brief.unreadable?.length > 0 && <p className="fine">Couldn’t read: {s.brief.unreadable.join(', ')}.</p>}
    </section>
  )
}

export function AdminAssistantButton() {
  const s = useStore()
  useEffect(() => {
    loadBrief()
  }, [])
  if (!s.enabled) return null
  return (
    <button type="button" className="assist-btn" aria-expanded={s.open} aria-controls={s.open ? PANEL_ID : undefined} onClick={() => set({ open: !s.open })} data-admin-assistant>
      <Icon name="sparkles" size={17} />
      <span>Assistant</span>
    </button>
  )
}

function Proposal({ p }) {
  const [st, setSt] = useState({})
  const approve = async () => {
    setSt({ busy: true })
    const { status, data } = await api('/api/platform/assist-approve', { method: 'POST', body: { proposal: p, confirm: true } })
    if (status === 200) {
      setSt({ done: data.state })
      loadBrief(true)
    } else setSt({ error: { stale: 'The records changed since this was prepared. Ask again to prepare it fresh.', not_found: 'That record no longer exists.', rate_limited: 'Too many approvals at once. Try again in a few minutes.' }[data?.error] || 'Couldn’t do that. Nothing was changed.' })
  }
  if (st.gone) return <p className="fine">Not done.</p>
  return (
    <div className="ask-proposal" data-admin-proposal={p.type} data-state={st.done ? 'done' : 'review'}>
      <p className="ask-proposal-title">
        {p.title}: {p.name}
      </p>
      <ul className="ask-list">
        {p.effects.map((x) => (
          <li key={x}>{x}</li>
        ))}
      </ul>
      {st.error && <p className="ask-error">{st.error}</p>}
      {st.done ? (
        <p className="ask-saved" role="status">
          {st.done}
        </p>
      ) : (
        <div className="ask-proposal-actions">
          <button type="button" className="btn btn-sm btn-primary" disabled={st.busy} onClick={approve}>
            {st.busy ? 'Working…' : 'Approve'}
          </button>
          <button type="button" className="btn btn-sm btn-quiet" disabled={st.busy} onClick={() => setSt({ gone: true })}>
            Not now
          </button>
        </div>
      )}
    </div>
  )
}

const ERRORS = { rate_limited: 'Too many questions in a minute. Try again shortly.', network: 'Couldn’t reach GetShowUps. Check the connection and try again.', too_long: 'That question is too long. Shorter, please.' }
const LIMIT = { spending: 'The assistant reached today’s spending ceiling; it resumes at 00:00 UTC.', answers: 'The assistant reached today’s question limit; it resumes at 00:00 UTC.', quota: 'The AI allowance is used up for today; it resumes at 00:00 UTC.' }

function Entry({ e }) {
  return (
    <div className="ask-entry" data-admin-entry={e.kind || (e.error ? 'error' : 'wait')}>
      <p className="ask-q">
        <span className="sr-only">You asked: </span>
        {e.q}
      </p>
      {!e.kind && !e.error && (
        <div className="ask-wait">
          <span className="sr-only">Working on an answer…</span>
          <i />
          <i />
          <i />
        </div>
      )}
      {e.error && <p className="ask-error">{ERRORS[e.error] || 'Couldn’t answer that. Try again in a moment.'}</p>}
      {e.kind && (
        <div className="ask-answer">
          <p className="ask-text">{e.answer}</p>
          {e.kind === 'records' && (
            <>
              {LIMIT[e.aiOut] && <p className="fine">{LIMIT[e.aiOut]}</p>}
              {e.brief && <BriefList items={e.brief.items.filter((i) => i.level !== 'fyi')} limit={6} />}
            </>
          )}
          {(e.proposals || []).map((p) => (
            <Proposal key={p.id} p={p} />
          ))}
          {e.sources?.length > 0 && (
            <p className="fine" data-sources>
              From: {e.sources.map((s) => `${s.source}${s.period ? ` (${s.period})` : ''}`).join('; ')}
            </p>
          )}
        </div>
      )}
    </div>
  )
}

function usePanelPlacement(open, ref) {
  useEffect(() => {
    const root = document.documentElement
    root.classList.toggle('help-open', open)
    if (!open) return
    const el = ref.current
    const place = () => root.style.setProperty('--help-h', `${el.offsetHeight}px`)
    place()
    const watch = new ResizeObserver(place)
    watch.observe(el)
    return () => {
      watch.disconnect()
      root.classList.remove('help-open')
    }
  }, [open, ref])
}

export function AdminAssistantPanel() {
  const s = useStore()
  const panel = useRef(null)
  const live = useRef(null)
  const id = useId()
  const [talk, setTalk] = useState([])
  const [q, setQ] = useState('')
  const refs = useRef({})
  const busy = talk.some((e) => !e.kind && !e.error)
  usePanelPlacement(s.open, panel)
  useEffect(() => {
    if (!s.open) return
    panel.current?.focus({ preventScroll: true })
    const onKey = (e) => e.key === 'Escape' && set({ open: false })
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [s.open])
  const ask = useCallback(
    async (question) => {
      const text = question.trim()
      if (text.length < 2) return
      setQ('')
      const history = talk.filter((e) => e.kind === 'answer' || e.kind === 'prepared').slice(-6).map((e) => ({ q: e.q, a: e.raw || e.answer }))
      setTalk((t) => [...t, { q: text }])
      const { status, data } = await api('/api/platform/assist', { method: 'POST', body: { question: text, history, refs: refs.current } })
      const entry = status === 200 && data?.kind ? { q: text, ...data } : { q: text, error: status === 0 ? 'network' : status === 429 ? 'rate_limited' : data?.error || 'failed' }
      if (data?.refs) refs.current = { ...refs.current, ...data.refs }
      setTalk((t) => [...t.slice(0, -1), entry])
      requestAnimationFrame(() => live.current?.lastElementChild?.scrollIntoView?.({ block: 'nearest' }))
    },
    [talk],
  )
  if (!s.open) return null
  const top = (s.brief?.items || []).filter((i) => i.level !== 'fyi')
  return (
    <aside className="help-panel" id={PANEL_ID} role="dialog" aria-labelledby={`${id}-title`} tabIndex={-1} ref={panel} data-admin-panel>
      <div className="help-scroll">
        <div className="help-head">
          <h2 id={`${id}-title`}>Assistant</h2>
          <button type="button" className="help-close" aria-label="Close" onClick={() => set({ open: false })}>
            <Icon name="close" size={18} />
          </button>
        </div>
        <section className="ask" aria-label="Conversation" data-ask>
          <div className="ask-answer" data-admin-brief>
            <p className="ask-text">{s.brief ? (top.length ? `This week: ${s.brief.counts.urgent} urgent and ${s.brief.counts.important} important.` : 'Nothing urgent or important this week.') : 'Couldn’t load this week’s list.'}</p>
            {top.length > 0 && <BriefList items={top} limit={5} />}
            <p className="fine">Ask about customers, billing, incidents, enrollments, partners or AI costs. I look things up and get small admin steps ready for you to approve; I never see owners’ or their customers’ contact details.</p>
          </div>
          <div className="ask-live" ref={live} role="log" aria-live="polite" aria-busy={busy}>
            {talk.map((e, i) => (
              <Entry key={i} e={e} />
            ))}
          </div>
          {!talk.length && (
            <ul className="ask-ideas" aria-label="Suggested questions">
              {IDEAS.map((x) => (
                <li key={x}>
                  <button type="button" onClick={() => ask(x)}>
                    {x}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <form
            className="ask-box"
            onSubmit={(e) => {
              e.preventDefault()
              if (!busy) ask(q)
            }}
          >
            <label className="sr-only" htmlFor={`${id}-q`}>
              Ask the assistant
            </label>
            <textarea id={`${id}-q`} rows={2} maxLength={500} value={q} placeholder="Ask about the platform…" onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && (e.preventDefault(), !busy && ask(q))} />
            <button type="submit" className="ask-send" aria-label="Send question" disabled={busy || q.trim().length < 2}>
              {busy ? <span className="ask-spin" aria-hidden="true" /> : <Icon name="arrow" size={18} />}
            </button>
          </form>
          <p className="fine">Answers come from the records and can be wrong; nothing happens without your Approve.</p>
        </section>
      </div>
    </aside>
  )
}
