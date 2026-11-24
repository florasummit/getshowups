// Writing help under one text field (server/writing.js): Draft / Improve / Shorten → a suggestion the owner accepts or
// discards. Placed right after the field's <label>; works for controlled and uncontrolled fields (the accepted text is
// entered like typing, so the form's own state, limits and Save apply). Hidden when the business doesn't have it.
import { useEffect, useRef, useState } from 'react'
import { api } from '../lib/api.js'

let availability = null
const available = () =>
  (availability ??= api('/api/dashboard/write').then(({ status, data }) => {
    if (status !== 200) availability = null // ask again next time
    return status === 200 && data.enabled === true
  }))

const ERRORS = {
  nothing_to_improve: 'Write a few words first.',
  too_long: 'This is too long to rewrite. Shorten it a little first.',
  rate_limited: 'You’ve used today’s suggestions. Try again later.',
  unavailable: 'Suggestions aren’t available right now. Your text is unchanged.',
}
const OTHER = 'That suggestion added something we couldn’t confirm, so it wasn’t shown. Try again or write it yourself.'
const LABEL = { draft: 'Draft for me', improve: 'Improve', shorten: 'Shorten' }

export default function AiWrite({ field, draft = false }) {
  const root = useRef(null)
  const [on, setOn] = useState(false)
  const [state, setState] = useState({})
  useEffect(() => {
    let live = true
    available().then((v) => live && setOn(v))
    return () => {
      live = false
    }
  }, [])
  const box = () => root.current?.previousElementSibling?.querySelector('textarea, input')
  const put = (value) => {
    const el = box()
    if (!el) return
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.focus()
  }
  const ask = async (action) => {
    const text = box()?.value || ''
    setState({ busy: action })
    const { status, data } = await api('/api/dashboard/write', { method: 'POST', body: { field, action, text } })
    if (status === 200) setState({ text: data.text, before: text })
    else setState({ error: status === 429 ? ERRORS.rate_limited : ERRORS[data.error] || (status === 422 ? OTHER : ERRORS.unavailable) })
  }
  if (!on) return <div ref={root} hidden />
  return (
    <div ref={root} className="ai-write" data-ai-write={field}>
      <div className="ai-write-row">
        {(draft ? ['draft', 'improve', 'shorten'] : ['improve', 'shorten']).map((a) => (
          <button key={a} type="button" className="link-btn" disabled={Boolean(state.busy)} onClick={() => ask(a)} data-ai-action={a}>
            {state.busy === a ? 'Writing…' : LABEL[a]}
          </button>
        ))}
      </div>
      {state.error && (
        <p className="fine" role="alert">
          {state.error}
        </p>
      )}
      {state.text && (
        <div className="ai-write-suggestion" role="status">
          <p>{state.text}</p>
          <p className="fine">AI suggestion. Check it before you save.</p>
          <div className="ai-write-row">
            <button
              type="button"
              className="btn btn-sm btn-quiet"
              onClick={() => {
                const el = box()
                const before = el?.value ?? ''
                put(state.text)
                setState({ undo: before })
              }}
            >
              Use this
            </button>
            <button type="button" className="link-btn" onClick={() => setState({})}>
              Discard
            </button>
          </div>
        </div>
      )}
      {state.undo !== undefined && (
        <p className="fine" role="status">
          Added, not saved yet.{' '}
          <button
            type="button"
            className="link-btn"
            onClick={() => {
              put(state.undo)
              setState({})
            }}
          >
            Undo
          </button>
        </p>
      )}
    </div>
  )
}
