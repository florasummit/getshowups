// The optional question box at the bottom of the help panel (server/assist.js). Nothing is sent until Send is pressed.
import { useId, useState } from 'react'
import { api } from '../lib/api.js'

const ERRORS = {
  empty_question: 'Type a question first.',
  too_long: 'Please ask in fewer words.',
  not_answerable: 'I can’t answer that from your settings and results. The explanation above is all we have on this.',
  rate_limited: 'You’ve reached today’s questions. The help above always works.',
  unavailable: 'Answers aren’t available right now. The help above always works.',
}
const OTHER = 'The answer included something we couldn’t confirm, so it wasn’t shown. Try asking differently.'

export default function AskAbout({ topic }) {
  const id = useId()
  const [on, setOn] = useState(null) // null = not asked yet
  const [q, setQ] = useState('')
  const [state, setState] = useState({})
  // Whether answers are offered is asked only when the owner opens the box, never when help opens.
  const open = async () => {
    const { status, data } = await api('/api/dashboard/assist')
    setOn(status === 200 && data.enabled === true)
  }
  const send = async (e) => {
    e.preventDefault()
    if (state.busy) return
    setState({ busy: true })
    const { status, data } = await api('/api/dashboard/assist', { method: 'POST', body: { topic, question: q } })
    if (status === 200) setState({ answer: data.answer, asked: q })
    else setState({ error: status === 429 ? ERRORS.rate_limited : ERRORS[data.error] || (status === 422 ? OTHER : ERRORS.unavailable) })
  }
  if (on === null)
    return (
      <button type="button" className="btn btn-sm btn-quiet" onClick={open} data-ask-open>
        Ask about this
      </button>
    )
  if (on === false) return <p className="fine">Questions aren’t available for this account right now.</p>
  return (
    <form className="ask" onSubmit={send} data-ask>
      <label className="field" htmlFor={id}>
        <span>Ask about this</span>
      </label>
      <textarea id={id} rows={2} maxLength={300} value={q} onChange={(e) => setQ(e.target.value)} autoFocus placeholder="e.g. What should I do first?" />
      <button type="submit" className="btn btn-sm btn-primary" disabled={state.busy || q.trim().length < 3}>
        {state.busy ? 'Thinking…' : 'Send'}
      </button>
      <div aria-live="polite">
        {state.error && <p className="fine">{state.error}</p>}
        {state.answer && (
          <div className="ai-write-suggestion">
            <p className="fine">You asked: {state.asked}</p>
            <p>{state.answer}</p>
            <p className="fine">AI answer from your settings and counts. It can be wrong and can’t change anything.</p>
          </div>
        )}
      </div>
    </form>
  )
}
