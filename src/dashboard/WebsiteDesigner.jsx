// The AI website designer: describe the website you want, the AI designs it (pages, layout, type, colours, imagery,
// words), and every reply updates the PRIVATE draft shown in the preview. Ask for changes in your own words; undo the
// last change; publish when you're happy. Runs on the business's own Claude or OpenAI key.
import { useEffect, useRef, useState } from 'react'
import { api } from '../lib/api.js'
import AiKeySettings from './AiKeySettings.jsx'

const ERRORS = {
  key_required: 'Connect your Claude or OpenAI API key first.',
  invalid_key: 'Your AI API key isn’t working any more. Replace it below.',
  provider_billing: 'Your AI provider account has no credit or has hit its spending limit. Add credit in your provider’s billing settings, then try again. Waiting won’t fix this.',
  provider_rejected: 'Your AI provider couldn’t accept this request. Please try again later; if it keeps happening, contact us.',
  provider_rate_limited: 'Your AI provider says you’ve hit its rate limit. Please wait a minute and try again.',
  ai_declined: 'The AI declined this request. Try describing it differently.',
  ai_invalid_output: 'The AI’s design couldn’t be used. Please try again.',
  provider_unavailable: 'Your AI provider isn’t responding right now. Please try again in a minute.',
  daily_limit: 'You’ve reached today’s design limit. You can keep editing by hand.',
  model_unavailable: 'Your chosen AI model is no longer offered on your account. Choose another under “AI model and monthly limit”.',
  no_tested_model: 'Auto has no tested model on your account yet. Choose a model under “AI model and monthly limit”.',
  budget_reached: 'This would go over your monthly AI limit. Raise it under “AI model and monthly limit”, or edit by hand.',
  rate_limited: 'That’s a lot of requests in a few minutes. Please wait a moment.',
  ai_design_incomplete: 'That design didn’t come out complete, so nothing was changed. Please try again.',
}
const FIRST = ['Design a modern, premium website from my current website’s content', 'Design a bright, friendly one-page site that makes booking easy', 'Design an elegant site with a separate Services page']
const NEXT = ['Make it feel more premium', 'Make booking more prominent', 'Try a darker palette', 'Add a Services page', 'Simplify the home page']

export default function WebsiteDesigner({ onChanged }) {
  const [data, setData] = useState(undefined)
  const [text, setText] = useState('')
  const [state, setState] = useState({})
  const end = useRef(null)
  const load = () => api('/api/dashboard/website/designer').then(({ status, data: d }) => setData(status === 200 ? d : { failed: true }))
  useEffect(() => {
    load()
  }, [])
  // Block body: scroll methods may return a Promise, and an effect must return nothing (or a cleanup function).
  useEffect(() => {
    end.current?.scrollIntoView?.({ block: 'nearest' })
  }, [data?.turns?.length, state.busy])
  if (data === undefined) return <div aria-busy="true" />
  if (data.failed) return <p className="form-error">Couldn’t load the designer. Please refresh.</p>

  // action 'different': a fresh design in a genuinely different direction (the server enforces that it differs).
  const send = async (message, action = 'message') => {
    if (!message.trim() || state.busy) return
    setState({ busy: true, chars: 0, pending: message })
    setText('')
    try {
      const res = await fetch('/api/dashboard/website/designer', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, message }) })
      if (!res.ok || !res.body) {
        const d = await res.json().catch(() => ({}))
        return setState({ error: ERRORS[d.error] || 'Something went wrong. Please try again.' })
      }
      const reader = res.body.getReader()
      const dec = new TextDecoder()
      let buf = ''
      let result = null
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        let i
        while ((i = buf.indexOf('\n')) >= 0) {
          const ev = JSON.parse(buf.slice(0, i))
          buf = buf.slice(i + 1)
          if (ev.type === 'progress') setState((st) => ({ ...st, chars: ev.chars }))
          else result = ev
        }
      }
      if (result?.type === 'done') {
        setState(result.removed ? { note: `${result.removed} item(s) were left out because they weren’t allowed (for example promises we can’t verify).` } : {})
        await load()
        onChanged?.()
      } else setState({ error: ERRORS[result?.error] || 'Something went wrong. Please try again.' })
    } catch {
      setState({ error: 'The connection dropped. Your draft is unchanged unless a reply appears; please try again.' })
    }
  }
  const undo = async (generationId) => {
    setState({ busy: true })
    const { status } = await api('/api/dashboard/website/designer', { method: 'POST', body: { action: 'undo', generationId } })
    setState(status === 200 ? {} : { error: 'Couldn’t undo. Please try again.' })
    await load()
    onChanged?.()
  }

  if (!data.key || data.key.status !== 'ok') {
    return (
      <div className="form">
        <p>The AI designer creates an original website for your business (pages, layout, colours, type, images and words) and changes it whenever you ask. It uses your own Claude or OpenAI API account.</p>
        <AiKeySettings onChange={load} />
      </div>
    )
  }
  const lastTurn = [...data.turns].reverse().find((t) => t.role === 'designer' && t.generationId)
  const chips = data.hasSite ? NEXT : FIRST
  return (
    <div className="designer">
      {data.turns.length > 0 && (
        <ol className="chat" aria-label="Conversation with the designer">
          {data.turns.map((t, i) => (
            <li key={i} className={`chat-${t.role}`}>
              <span className="chat-who">{t.role === 'owner' ? 'You' : 'Designer'}</span>
              <p>{t.text}</p>
              {t === lastTurn && !state.busy && (
                <button type="button" className="link-btn" onClick={() => undo(t.generationId)}>
                  Undo this change
                </button>
              )}
            </li>
          ))}
          {state.busy && state.pending && (
            <>
              <li className="chat-owner">
                <span className="chat-who">You</span>
                <p>{state.pending}</p>
              </li>
              <li className="chat-designer" aria-live="polite">
                <span className="chat-who">Designer</span>
                <p className="fine">{state.chars ? `Designing… (${Math.round(state.chars / 100) / 10}k characters of design written)` : 'Thinking about your website…'} This usually takes one to three minutes.</p>
              </li>
            </>
          )}
          <li ref={end} aria-hidden="true" />
        </ol>
      )}
      {!data.turns.length && <p className="fine">Describe the website you want: the feel, who your customers are, what matters most. The designer uses your business details{data.hasSite ? '' : ' and your imported website, if you brought one'}. Nothing goes live until you publish.</p>}
      {data.hasSite && data.direction && (
        <p className="fine designer-direction">
          <strong>Design idea:</strong> {data.direction}
        </p>
      )}
      {data.hasSite && (
        <button type="button" className="btn btn-quiet btn-sm" disabled={state.busy} onClick={() => send('Show me a different direction', 'different')}>
          Show me a different direction
        </button>
      )}
      <div className="chips">
        {chips.map((c) => (
          <button key={c} type="button" className="chip" disabled={state.busy} onClick={() => send(c)}>
            {c}
          </button>
        ))}
      </div>
      <form
        className="designer-input"
        onSubmit={(e) => {
          e.preventDefault()
          send(text)
        }}
      >
        <label className="field">
          <span>{data.hasSite ? 'Ask for a change' : 'Describe your website'}</span>
          <textarea rows={3} maxLength={1200} value={text} onChange={(e) => setText(e.target.value)} placeholder={data.hasSite ? 'e.g. Make the home page feel calmer and add a page about weekly service' : 'e.g. Modern and premium, lots of water and light, booking front and centre'} />
        </label>
        <button className="btn btn-primary" disabled={state.busy || !text.trim()}>
          {state.busy ? 'Designing…' : data.hasSite ? 'Send' : 'Design my website'}
        </button>
      </form>
      {state.note && (
        <p className="fine" role="status">
          {state.note}
        </p>
      )}
      {state.error && (
        <p className="form-error" role="alert">
          {state.error}
        </p>
      )}
      <details className="designer-key">
        <summary>
          AI model and monthly limit · {data.key.model === 'auto' ? `Auto${data.key.autoModel ? ` (${data.key.autoModel})` : ''}` : data.key.model}
        </summary>
        <AiKeySettings onChange={load} />
      </details>
      <p className="fine">Each request runs on your {data.key.label} account and is billed by them.</p>
    </div>
  )
}
