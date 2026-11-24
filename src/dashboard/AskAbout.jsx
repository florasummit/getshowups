// The assistant's conversation (server/assist.js), at the bottom of the one panel (Help.jsx). It stays while the owner
// moves between pages and selections, lives in this page only (nothing is stored) and is gone on reload or sign-out.
// Opening anything sends nothing: pressing a suggestion or Send asks once, with the page, the selected topic and the
// period on screen. Every answer says what it is and which period it is about. A prepared change is saved only by its button.
import { useEffect, useId, useRef, useState } from 'react'
import Icon from '../components/Icon.jsx'
import { api } from '../lib/api.js'
import { HELP } from '../content/help.js'

const ERRORS = {
  empty_question: 'Type a question first.',
  too_long: 'Please ask in fewer words.',
  rate_limited: 'You’ve reached the question limit for now. Explanations on this page always work.',
  unavailable: 'Answers aren’t available right now. Explanations on this page always work.',
}
const OTHER = 'The answer included something we couldn’t confirm, so it wasn’t shown. Try asking differently.'
const BLANK = 'Why isn’t this available yet?'
const TAG = { business: 'AI interpretation', general: 'General information', help: 'From the help text', prepared: 'Prepared for you' }
const IDEAS = {
  overview: ['Why are my leads not becoming booked jobs?', 'What should I look at first?'],
  appointments: ['Help me improve my service area', 'What can I do about no-shows?'],
  followups: ['How should I answer people who haven’t booked?', 'Why are my leads not becoming booked jobs?'],
  receptionist: ['What does the receptionist use to answer?', 'How many conversations led to a booking?'],
  teach: ['What is worth teaching first?'],
  website: ['What should a small business website say first?'],
  ads: ['Why are my leads not becoming booked jobs?', 'Do I have enough leads to judge my ads?'],
  settings: ['Help me improve my service area', 'Are my booking hours limiting bookings?'],
}
const VIEW = { overview: 'Overview', appointments: 'Appointments', followups: 'Follow-ups', receptionist: 'Receptionist', teach: 'Teach Your AI', website: 'Website', ads: 'Ads', settings: 'Settings' }

function Proposal({ p }) {
  const [state, setState] = useState({})
  if (state.gone) return <p className="fine">Discarded. Nothing was changed.</p>
  const save = async () => {
    // A form open on the page still holds the old list; saving it later would undo this.
    if (document.querySelector('.app-main form[data-dirty]')) return setState({ error: 'Save or discard what you’re editing on this page first.' })
    setState({ busy: true })
    const { status, data } = await api('/api/dashboard/proposal', { method: 'POST', body: { type: p.type, before: p.before, after: p.after, confirm: true } })
    if (status !== 200) return setState({ error: status === 409 ? 'Your ZIP codes changed since this was prepared, so nothing was saved. Ask again for a fresh one.' : status === 429 ? 'Too many changes at once. Try again in a few minutes.' : 'This wasn’t saved. Please try again.', stale: status === 409 })
    setState({ saved: data.serviceZips })
    window.dispatchEvent(new CustomEvent('gsu:changed'))
  }
  return (
    <div className="ask-proposal" data-proposal={state.saved ? 'saved' : 'review'}>
      <p className="ask-proposal-title">Service area ZIP codes</p>
      <dl>
        <div>
          <dt>Now</dt>
          <dd>{p.before.join(', ') || 'Everyone can book'}</dd>
        </div>
        <div>
          <dt>After</dt>
          <dd>
            {p.after.map((z) => (
              <span key={z} className={p.add.includes(z) ? 'is-new' : ''}>
                {p.add.includes(z) ? `+ ${z}` : z}
              </span>
            ))}
            {p.remove.map((z) => (
              <del key={z}>{z}</del>
            ))}
          </dd>
        </div>
      </dl>
      <p className="fine">{p.why}</p>
      <ul className="ask-list">
        {p.effects.map((x) => (
          <li key={x}>{x}</li>
        ))}
      </ul>
      <div role="status">
        {state.error && <p className="ask-error">{state.error}</p>}
        {state.saved && <p className="ask-saved">Saved. Your ZIP codes are now {state.saved.join(', ')}.</p>}
      </div>
      {!state.saved && !state.stale && (
        <div className="ask-proposal-actions">
          <button type="button" className="btn btn-sm btn-primary" disabled={state.busy} onClick={save}>
            {state.busy ? 'Saving…' : 'Save these ZIP codes'}
          </button>
          <button type="button" className="btn btn-sm btn-quiet" disabled={state.busy} onClick={() => setState({ gone: true })}>
            Don’t change
          </button>
        </div>
      )}
    </div>
  )
}

function Entry({ e, retry }) {
  return (
    <div className="ask-entry">
      <p className="ask-q">
        <span className="sr-only">You asked: </span>
        {e.q}
        <small>{[e.about, e.days && (e.ctx.days || e.evidence || e.kind === 'business') && `last ${e.days} days`].filter(Boolean).join(' · ')}</small>
      </p>
      {e.busy && (
        <div className="ask-wait">
          <span className="sr-only">Working on an answer…</span>
          <i />
          <i />
        </div>
      )}
      {e.evidence && (
        <div className="ask-evidence">
          <p className="help-tag">From your records</p>
          <ul className="ask-list">
            {e.evidence.known.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
          <details>
            <summary>What this can’t show</summary>
            <ul className="ask-list">
              {e.evidence.unknown.map((x) => (
                <li key={x}>{x}</li>
              ))}
            </ul>
          </details>
        </div>
      )}
      {e.error && (
        <p className="ask-error">
          {e.error}{' '}
          {e.retry && (
            <button type="button" className="link-btn" onClick={retry}>
              Try again
            </button>
          )}
        </p>
      )}
      {e.answer && (
        <div className="ask-answer">
          {TAG[e.kind] && <p className="help-tag">{TAG[e.kind]}</p>}
          <p>{e.answer}</p>
          {e.note && <p className="fine">{e.note}</p>}
          {e.kind === 'business' && <p className="fine">Based on your settings and the last {e.days} days of results. It can be wrong and can’t change anything.</p>}
          {e.proposal && <Proposal p={e.proposal} />}
        </div>
      )}
    </div>
  )
}

export default function Assistant({ topic, title, missing, days, loading, view, first, onSent }) {
  const id = useId()
  const live = useRef(null)
  const [off, setOff] = useState(false)
  const [q, setQ] = useState('')
  const [talk, setTalk] = useState([])
  const busy = talk.some((e) => e.busy)
  const send = async (question, { replace = null, fromBox = false } = {}) => {
    if (loading || busy || question.trim().length < 3) return
    const key = replace?.id ?? `${Date.now()}-${talk.length}`
    const ctx = replace?.ctx ?? { topic, view, days }
    const entry = { id: key, ctx, q: question, about: replace ? replace.about : title || VIEW[view], days: ctx.days, busy: true }
    const history = talk.filter((e) => e.answer && e.id !== key).slice(-4).map((e) => ({ q: e.q, a: e.answer }))
    setTalk((t) => (replace ? t.map((e) => (e.id === key ? entry : e)) : [...t.slice(-19), entry]))
    const { status, data } = await api('/api/dashboard/assist', { method: 'POST', body: { ...ctx, question, history } })
    if (status === 404) setOff(true)
    const code = status === 429 ? 'rate_limited' : ERRORS[data.error] ? data.error : status === 422 ? 'refused' : 'unavailable'
    const done =
      status === 200
        ? { kind: data.kind, answer: data.answer, note: data.note, days: data.days, evidence: data.evidence, proposal: data.proposal }
        : { error: code === 'refused' ? OTHER : ERRORS[code], retry: code === 'unavailable', evidence: data.evidence, days: data.days ?? ctx.days }
    setTalk((t) => t.map((e) => (e.id === key ? { ...entry, busy: false, ...done } : e)))
    if (status === 200 && fromBox) setQ((now) => (now === question ? '' : now))
  }
  const suggest = (question) => {
    live.current?.focus({ preventScroll: true }) // not the box, which would open a phone's keyboard
    send(question)
  }
  // Opened with a question (a pressed insight): ask it once.
  const asked = useRef(null)
  useEffect(() => {
    if (!first || asked.current === first) return
    asked.current = first
    suggest(first)
    onSent?.()
  }) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!first) asked.current = null
  }, [first])
  // The newest question and its outcome are brought into view inside the panel (a phone's sheet is short).
  const last = talk.at(-1)
  useEffect(() => {
    const el = live.current?.lastElementChild
    const scroller = el?.closest('.help-scroll')
    if (!last || !scroller) return
    const smooth = !window.matchMedia('(prefers-reduced-motion: reduce)').matches
    scroller.scrollTo({ top: scroller.scrollTop + el.getBoundingClientRect().top - scroller.getBoundingClientRect().top - scroller.querySelector('.help-head').offsetHeight - 16, behavior: smooth ? 'smooth' : 'auto' })
  }, [last])
  if (off)
    return (
      <p className="fine" role="status">
        Questions aren’t available for this account right now.
      </p>
    )
  const pool = topic ? (missing ? [BLANK] : HELP[topic].ask || []) : IDEAS[view] || IDEAS.overview
  const recent = talk.filter((e) => e.about === (title || VIEW[view]) && e.ctx.days === days).map((e) => e.q)
  const ideas = pool.filter((x) => !recent.includes(x)).slice(0, 2)
  return (
    <section className="ask" aria-label="Conversation" data-ask data-ask-talking={talk.length || q ? '' : undefined}>
      <p className="ask-title">
        <Icon name="sparkles" size={15} /> {topic ? 'Ask a follow-up' : 'Ask about your business'}
      </p>
      {!topic && !talk.length && <p className="fine">I can look at your inquiries, bookings, ads and settings, explain how things work, and prepare changes for you to approve.</p>}
      <div className="ask-live" ref={live} tabIndex={-1} role="log" aria-live="polite" aria-busy={busy}>
        {talk.map((e) => (
          <Entry key={e.id} e={e} retry={() => send(e.q, { replace: e })} />
        ))}
      </div>
      {ideas.length > 0 && !busy && (
        <ul className="ask-ideas" aria-label="Suggested questions">
          {ideas.map((x) => (
            <li key={x}>
              <button type="button" disabled={loading} onClick={() => suggest(x)} data-ask-idea>
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
          send(q, { fromBox: true })
        }}
      >
        <label className="sr-only" htmlFor={id}>
          {title ? `Your question about ${title}` : 'Your question'}
        </label>
        <textarea
          id={id}
          rows={1}
          maxLength={500}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return
            e.preventDefault()
            send(q, { fromBox: true })
          }}
          placeholder="Ask in your own words"
        />
        <button type="submit" className="ask-send" aria-label="Send question" disabled={loading || busy || q.trim().length < 3}>
          {busy ? <span className="ask-spin" aria-hidden="true" /> : <Icon name="arrow" size={18} />}
        </button>
      </form>
      <p className="fine">
        Need a person? <a href="mailto:hello@getshowups.com?subject=GetShowUps%20help">Email us</a>
      </p>
    </section>
  )
}
