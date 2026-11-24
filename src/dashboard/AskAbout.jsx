// The optional follow-up at the bottom of the help panel (server/assist.js). Opening help sends nothing: pressing a
// suggested question or Send asks once; focusing the box only checks whether answers are offered.
import { useEffect, useId, useRef, useState } from 'react'
import Icon from '../components/Icon.jsx'
import { api } from '../lib/api.js'
import { HELP } from '../content/help.js'

const ERRORS = {
  empty_question: 'Type a question first.',
  too_long: 'Please ask in fewer words.',
  not_answerable: 'I can’t answer that from your settings and results. The explanation above is all we have on this.',
  rate_limited: 'You’ve reached the question limit for now. The help above always works.',
  unavailable: 'Answers aren’t available right now. The help above always works.',
}
const OTHER = 'The answer included something we couldn’t confirm, so it wasn’t shown. Try asking differently.'
const BLANK = 'Why isn’t this available yet?'

export default function AskAbout({ topic, title, missing, days, loading }) {
  const id = useId()
  const checked = useRef(false)
  const asking = useRef(0)
  const live = useRef(null)
  const [off, setOff] = useState(false)
  const [q, setQ] = useState('')
  const [state, setState] = useState({})
  const check = async () => {
    if (checked.current) return
    checked.current = true
    const { status, data } = await api('/api/dashboard/assist')
    if (status === 200 && data.enabled !== true) setOff(true)
  }
  // A new period: an answer about the old one is cleared (also one still on its way). What is being typed stays.
  const [shown, setShown] = useState(days)
  if (shown !== days) {
    setShown(days)
    setState({})
  }
  useEffect(
    () => () => {
      asking.current++
    },
    [days],
  )
  const send = async (question) => {
    if (loading || state.busy || question.trim().length < 3) return
    checked.current = true
    setState({ busy: true, asked: question })
    const mine = ++asking.current
    const { status, data } = await api('/api/dashboard/assist', { method: 'POST', body: { topic, question, days } })
    if (mine !== asking.current) return
    if (status === 404) return setOff(true)
    if (status === 200) {
      setQ((now) => (now === question ? '' : now))
      setState({ answer: data.answer, days: data.days, asked: question })
    } else {
      const code = status === 429 ? 'rate_limited' : ERRORS[data.error] ? data.error : status === 422 ? 'refused' : 'unavailable'
      setState({ error: code === 'refused' ? OTHER : ERRORS[code], retry: code === 'unavailable', asked: question })
    }
  }
  // A pressed suggestion goes away: focus moves to where its answer appears (not the box, which would open a phone's keyboard).
  const suggest = (question) => {
    live.current?.focus({ preventScroll: true })
    send(question)
  }
  // The question and its outcome are brought into view inside the panel (a phone's sheet is short).
  useEffect(() => {
    if (!state.asked) return
    const smooth = !window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const el = live.current
    const scroller = el?.closest('.help-scroll')
    const head = scroller?.querySelector('.help-head')
    if (scroller) scroller.scrollTo({ top: scroller.scrollTop + el.getBoundingClientRect().top - scroller.getBoundingClientRect().top - head.offsetHeight - 16, behavior: smooth ? 'smooth' : 'auto' })
  }, [state])
  if (off)
    return (
      <p className="fine" role="status">
        Questions aren’t available for this account right now.
      </p>
    )
  const ideas = (missing ? [BLANK] : HELP[topic].ask || []).filter((x) => x && x !== state.asked).slice(0, 2)
  return (
    <section className="ask" aria-label="Ask a follow-up" data-ask>
      <p className="ask-title">
        <Icon name="sparkles" size={15} /> Ask a follow-up
      </p>
      <div className="ask-live" ref={live} tabIndex={-1} role="status" aria-busy={!!state.busy}>
        {state.asked && <p className="ask-q">{state.asked}</p>}
        {state.busy && (
          <div className="ask-wait">
            <span className="sr-only">Working on an answer…</span>
            <i />
            <i />
          </div>
        )}
        {state.error && (
          <p className="ask-error">
            {state.error}{' '}
            {state.retry && (
              <button type="button" className="link-btn" onClick={() => send(state.asked)}>
                Try again
              </button>
            )}
          </p>
        )}
        {state.answer && (
          <div className="ask-answer">
            <p className="help-tag">AI interpretation</p>
            <p>{state.answer}</p>
            <p className="fine">Based on your settings and the last {state.days} days of results. It can be wrong and can’t change anything.</p>
          </div>
        )}
      </div>
      {ideas.length > 0 && !state.busy && (
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
          send(q)
        }}
      >
        <label className="sr-only" htmlFor={id}>
          Your question about {title}
        </label>
        <textarea
          id={id}
          rows={1}
          maxLength={300}
          value={q}
          onFocus={check}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return
            e.preventDefault()
            send(q)
          }}
          placeholder="Ask in your own words"
        />
        <button type="submit" className="ask-send" aria-label="Send question" disabled={loading || state.busy || q.trim().length < 3}>
          {state.busy ? <span className="ask-spin" aria-hidden="true" /> : <Icon name="arrow" size={18} />}
        </button>
      </form>
    </section>
  )
}
