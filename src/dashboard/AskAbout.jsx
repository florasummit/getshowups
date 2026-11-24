// The assistant's conversation (server/assist.js), at the bottom of the one panel (Help.jsx). It stays while the owner
// moves between pages and selections, lives in this page only (nothing is stored) and is gone on reload or sign-out.
// Opening anything sends nothing: pressing a suggestion or Send asks once, with the page, the selected topic and the
// period on screen. Every answer says what it is and which period it is about. A prepared change is saved only by its button.
import { useEffect, useId, useRef, useState } from 'react'
import Icon from '../components/Icon.jsx'
import { api } from '../lib/api.js'
import { HELP } from '../content/help.js'
import { setDraft } from './assistant-store.js'

const ERRORS = {
  empty_question: 'Type a question first.',
  too_long: 'Please ask in fewer words.',
  rate_limited: 'You’ve reached the question limit for now. Explanations on this page always work.',
  unavailable: 'The AI couldn’t be reached just now. Try again in a minute.',
  busy: 'The AI is busy just now. Try again in a minute.',
  timeout: 'The AI took too long. Try again, or ask for one thing at a time.',
  setup: 'AI answers are switched off until GetShowUps fixes its AI account. Trying again won’t help. Your pages and records work as usual.',
  quota: 'AI answers are paused because today’s shared AI allowance is used up. Trying again won’t help.',
}
const NOT_READ = {
  rate_limited: 'You’ve reached today’s AI answers, so this is straight from your records, without analysis.',
  unchecked: 'The AI’s wording didn’t match your records, so only the records are shown.',
}
const OUT = 'The AI isn’t available, so this is only a list from your records, without analysis or advice.'
const OTHER = 'The answer included something we couldn’t confirm, so it wasn’t shown. Try asking differently.'
const BLANK = 'Why isn’t this available yet?'
const TAG = { general: 'General information', help: 'From the help text', prepared: 'Prepared for you', records: 'From your records' }
const IDEAS = {
  overview: ['What should I fix first?', 'What’s coming up?'],
  appointments: ['What’s on this week?', 'Which visits still need an outcome?'],
  followups: ['Who hasn’t been answered?', 'Draft a follow-up for me'],
  receptionist: ['Who asked recently?', 'What should I fix first?'],
  teach: ['What do people ask me for?'],
  website: ['Who asked recently?'],
  ads: ['What did my ads bring in?', 'Compare the last 30 days with the 30 before'],
  settings: ['Who asks from outside my area?', 'What are my hours?'],
}
const VIEW = { overview: 'Overview', appointments: 'Appointments', followups: 'Follow-ups', receptionist: 'Receptionist', teach: 'Teach Your AI', website: 'Website', ads: 'Ads', settings: 'Settings' }

const goTo = (where) => window.dispatchEvent(new CustomEvent('gsu:go', { detail: where }))

// A change waiting for the owner. Only its button saves it; a withdrawn or saved one can't be pressed again.
function Proposal({ p, onState }) {
  const [state, setState] = useState({})
  const [text, setText] = useState(p.message || '')
  if (p.state === 'withdrawn') return <p className="fine">Not changed.</p>
  const gone = () => onState(p, 'withdrawn')
  if (p.type === 'follow_up')
    return (
      <div className="ask-proposal" data-proposal="draft">
        <p className="ask-proposal-title">Draft for {p.name || 'this person'}</p>
        <textarea aria-label="Follow-up draft" rows={4} maxLength={1000} value={text} onChange={(e) => setText(e.target.value)} />
        <ul className="ask-list">
          {p.effects.map((x) => (
            <li key={x}>{x}</li>
          ))}
        </ul>
        <div className="ask-proposal-actions">
          <button
            type="button"
            className="btn btn-sm btn-primary"
            disabled={!text.trim()}
            onClick={() => {
              setDraft({ leadId: p.id, text })
              goTo('followups')
            }}
          >
            Open in Follow-ups
          </button>
          <button type="button" className="btn btn-sm btn-quiet" onClick={gone}>
            Discard
          </button>
        </div>
      </div>
    )
  const zips = p.type === 'service_zips'
  const save = async () => {
    // A form open on the page still holds the old values; saving it later would undo this.
    if (document.querySelector('.app-main form[data-dirty]')) return setState({ error: 'Save or discard what you’re editing on this page first.' })
    setState({ busy: true })
    const body = p.type === 'outcome' ? { type: p.type, id: p.id, outcome: p.outcome, before: p.before, confirm: true } : { type: p.type, before: p.before, after: p.after, confirm: true }
    const { status, data } = await api('/api/dashboard/proposal', { method: 'POST', body })
    if (status !== 200)
      return setState({ error: status === 409 ? 'This changed since it was prepared, so nothing was saved. Ask again for a fresh one.' : status === 404 ? 'That appointment isn’t there any more. Nothing was saved.' : status === 429 ? 'Too many changes at once. Try again in a few minutes.' : 'This wasn’t saved. Please try again.', stale: [404, 409].includes(status) })
    setState({ saved: data.already ? 'It was already saved.' : zips ? `Saved. Your ZIP codes are now ${data.serviceZips.join(', ')}.` : `Saved: ${data.state}.` })
    onState(p, 'saved')
    window.dispatchEvent(new CustomEvent('gsu:changed'))
  }
  return (
    <div className="ask-proposal" data-proposal={state.saved ? 'saved' : 'review'}>
      <p className="ask-proposal-title">{zips ? 'Service area ZIP codes' : p.type === 'hours' ? 'Booking hours' : `Outcome: ${p.name || 'appointment'}`}</p>
      {p.when && <p className="fine">{p.when}</p>}
      <dl>
        <div>
          <dt>Now</dt>
          <dd>{zips ? p.before.join(', ') || 'Everyone can book' : p.from}</dd>
        </div>
        <div>
          <dt>After</dt>
          <dd>
            {zips ? (
              <>
                {p.after.map((z) => (
                  <span key={z} className={p.add.includes(z) ? 'is-new' : ''}>
                    {p.add.includes(z) ? `+ ${z}` : z}
                  </span>
                ))}
                {p.remove.map((z) => (
                  <del key={z}>{z}</del>
                ))}
              </>
            ) : (
              <span className="is-new">{p.to}</span>
            )}
          </dd>
        </div>
      </dl>
      {p.why && <p className="fine">{p.why}</p>}
      <ul className="ask-list">
        {p.effects.map((x) => (
          <li key={x}>{x}</li>
        ))}
      </ul>
      <div role="status">
        {state.error && <p className="ask-error">{state.error}</p>}
        {state.saved && <p className="ask-saved">{state.saved}</p>}
      </div>
      {!state.saved && !state.stale && (
        <div className="ask-proposal-actions">
          <button type="button" className="btn btn-sm btn-primary" disabled={state.busy} onClick={save}>
            {state.busy ? 'Saving…' : zips ? 'Save these ZIP codes' : 'Approve'}
          </button>
          <button type="button" className="btn btn-sm btn-quiet" disabled={state.busy} onClick={gone}>
            Don’t change
          </button>
        </div>
      )}
    </div>
  )
}

// The records an answer is about, as they are now. Names and contact details come from the app, not the AI.
function Records({ list }) {
  return (
    <ul className="ask-records" aria-label="Records">
      {list.map((r) => (
        <li key={r.ref}>
          <details>
            <summary>
              <strong>{r.name}</strong>
              <span>{r.kind === 'appointment' ? r.when : `asked ${r.when}`}</span>
            </summary>
            <p>{r.what}</p>
            <p className="fine">{r.state}</p>
            {r.contact?.map((x) => (
              <a key={x} href={x.includes('@') ? `mailto:${x}` : `tel:${x.replace(/[^\d+]/g, '')}`}>
                {x}
              </a>
            ))}
            <button type="button" className="link-btn" onClick={() => goTo(r.go)}>
              Open in {r.go === 'appointments' ? 'Appointments' : 'Follow-ups'}
            </button>
          </details>
        </li>
      ))}
    </ul>
  )
}

function Entry({ e, retry, ask, onState }) {
  return (
    <div className="ask-entry">
      <p className="ask-q">
        <span className="sr-only">You asked: </span>
        {e.q}
        <small>{[e.about, e.ctx.days && `last ${e.days} days`].filter(Boolean).join(' · ')}</small>
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
          {e.resumesAt && <>They’re back {new Date(e.resumesAt).toLocaleString([], { weekday: 'long', hour: 'numeric', minute: '2-digit' })}. </>}
          {e.retry && (
            <button type="button" className="link-btn" onClick={retry}>
              Try again
            </button>
          )}
        </p>
      )}
      {e.error && e.tries?.length > 0 && (
        <div data-ask-works>
          <p className="fine">These work without AI:</p>
          <ul className="ask-ideas">
            {e.tries.map((x) => (
              <li key={x}>
                <button type="button" onClick={() => ask(x)}>
                  {x}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {e.answer && (
        <div className="ask-answer">
          {TAG[e.kind] && <p className="help-tag">{TAG[e.kind]}</p>}
          <p className="ask-text">{e.answer}</p>
          {e.records?.length > 0 && <Records list={e.records} />}
          {e.proposals?.map((p) => (
            <Proposal key={p.key} p={p} onState={(x, st) => onState(e.id, x, st)} />
          ))}
          {e.go && (
            <button type="button" className="btn btn-sm btn-quiet" onClick={() => goTo(e.go)}>
              Open {VIEW[e.go]}
            </button>
          )}
          {e.note && <p className="fine">{e.note}</p>}
          {e.aiOut && (
            <p className="fine" data-ai-out>
              {NOT_READ[e.aiOut] || OUT}
              {e.resumesAt && <> AI answers are back {new Date(e.resumesAt).toLocaleString([], { weekday: 'long', hour: 'numeric', minute: '2-digit' })}.</>}
            </p>
          )}
          {e.kind === 'business' && <p className="fine">From your records. The wording is AI and can be wrong.</p>}
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
  const looked = useRef([]) // the lookups behind the last answer, read again for a follow-up question
  const refs = useRef({}) // which records A1, L2… are, for this conversation
  const onState = (id, p, state) => setTalk((t) => t.map((e) => (e.id === id ? { ...e, proposals: e.proposals.map((x) => (x.key === p.key ? { ...x, state } : x)) } : e)))
  const busy = talk.some((e) => e.busy)
  const send = async (question, { replace = null, fromBox = false } = {}) => {
    if (loading || busy || question.trim().length < 2) return
    const key = replace?.id ?? `${Date.now()}-${talk.length}`
    const ctx = replace?.ctx ?? { topic, view, days }
    const entry = { id: key, ctx, q: question, about: replace ? replace.about : title || VIEW[view], days: ctx.days, busy: true }
    // A question the AI couldn't answer still counts as said, and a bare list is never replayed as the AI's own reading.
    const history = talk.filter((e) => (e.answer || e.error) && e.id !== key).slice(-6).map((e) => ({ q: e.q, a: e.error ? '(not answered: the AI was unavailable)' : `${e.aiOut ? '(the AI was unavailable; records were only listed) ' : ''}${e.raw || e.answer}` }))
    const pending = talk.flatMap((e) => e.proposals || []).filter((p) => !p.state).slice(-4).map((p) => ({ type: p.type, ref: p.ref, change: p.to || p.message || (p.after ? `ZIPs ${p.before.join(' ')} -> ${p.after.join(' ')}` : '') }))
    setTalk((t) => (replace ? t.map((e) => (e.id === key ? entry : e)) : [...t.slice(-19), entry]))
    const { status, data } = await api('/api/dashboard/assist', { method: 'POST', body: { ...ctx, question, history, refs: refs.current, looked: looked.current, pending } })
    if (data.refs) refs.current = data.refs
    if (data.lookups) looked.current = data.lookups
    if (status === 200 && data.withdraw) setTalk((t) => t.map((e) => ({ ...e, proposals: e.proposals?.map((p) => (p.state ? p : { ...p, state: 'withdrawn' })) })))
    if (status === 404) setOff(true)
    const code = status === 429 ? 'rate_limited' : ERRORS[data.error] ? data.error : status === 422 ? 'refused' : 'unavailable'
    const done =
      status === 200
        ? { kind: data.kind, answer: data.answer, raw: data.raw, note: data.note, days: data.days, evidence: data.evidence, records: data.records, go: data.go, limited: data.limited, aiOut: data.aiOut, resumesAt: data.resumesAt, proposals: (data.proposals || []).map((p, i) => ({ ...p, key: `${key}-${i}` })) }
        : { error: code === 'refused' ? OTHER : ERRORS[code], retry: ['unavailable', 'busy', 'timeout'].includes(code), resumesAt: code === 'quota' ? data.resumesAt : null, tries: data.try, evidence: data.evidence, days: data.days ?? ctx.days }
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
      {!topic && !talk.length && <p className="fine">Ask in your own words. I look up your appointments, inquiries, numbers and settings, and get changes ready for you to approve.</p>}
      <div className="ask-live" ref={live} tabIndex={-1} role="log" aria-live="polite" aria-busy={busy}>
        {talk.map((e) => (
          <Entry key={e.id} e={e} retry={() => send(e.q, { replace: e })} ask={suggest} onState={onState} />
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
        <button type="submit" className="ask-send" aria-label="Send question" disabled={loading || busy || q.trim().length < 2}>
          {busy ? <span className="ask-spin" aria-hidden="true" /> : <Icon name="arrow" size={18} />}
        </button>
      </form>
      <p className="fine">
        Need a person? <a href="mailto:hello@getshowups.com?subject=GetShowUps%20help">Email us</a>
      </p>
    </section>
  )
}
