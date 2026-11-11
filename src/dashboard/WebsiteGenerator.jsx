// AI website design. "Create my website": one request writes the copy and three different designs from the
// business details; the owner picks one (previews render the stored result, no further AI calls) and it
// becomes the private draft. "Describe a change": one request revises the draft; the owner keeps it or
// goes back. The live website changes only when the owner publishes.
import { useState } from 'react'
import { api } from '../lib/api.js'
import { ScaledFrame } from './WebsiteEditor.jsx'

const FAIL = { 503: 'Our website designer is busy. Please try again in a minute.' }

const resetTime = (ms) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
// Today's AI allowance for one kind ('generation' or 'revision'), e.g. "18 of 20 left today · resets at 7:00 PM".
export function Allowance({ usage, kind, noun }) {
  const u = usage?.[kind]
  if (!u) return null
  return (
    <p className="fine" data-allowance={kind}>
      {u.remaining} of {u.limit} {noun} left today · resets at {resetTime(usage.resetsAt)}
    </p>
  )
}
// Specific, honest messages for the server's limits (manual editing is never limited).
const failText = (status, data, noun) =>
  data?.error === 'daily_limit'
    ? `You’ve used today’s ${data.limit} ${noun}. You can make more after ${resetTime(data.resetsAt)}, or edit the text below.`
    : data?.error === 'monthly_limit'
      ? 'You’ve reached this month’s AI limit. You can still edit the text and photos below.'
      : data?.error === 'rate_limited'
        ? 'That’s a lot of requests in a few minutes. Please wait a moment and try again.'
        : FAIL[status]

export default function WebsiteGenerator({ hasDraft, onApplied, intro, usage, onUsage }) {
  const [gen, setGen] = useState(null)
  const [state, setState] = useState({})
  const generate = async () => {
    setState({ busy: 'writing' })
    const { status, data } = await api('/api/dashboard/website', { method: 'POST', body: { action: 'generate' } })
    if (data?.aiUsage) onUsage?.(data.aiUsage)
    if (status === 200) {
      setGen(data.generation)
      setState({})
    } else setState({ error: failText(status, data, 'new designs') || 'We couldn’t create it just now. Please try again.' })
  }
  const choose = async (option) => {
    setState({ busy: option })
    const { status, data } = await api('/api/dashboard/website', { method: 'POST', body: { action: 'apply', generationId: gen.id, option } })
    if (status === 200) {
      setGen(null)
      setState({})
      onApplied(data)
    } else setState({ error: 'Couldn’t use that design. Please try again.' })
  }

  if (!gen) {
    return (
      <div className="generator">
        {intro && <p className="lede">{intro}</p>}
        {hasDraft && <p className="fine">This creates three new designs to choose from. Your current draft stays until you pick one, and your live website doesn’t change until you publish.</p>}
        <button type="button" className="btn btn-primary btn-lg" disabled={Boolean(state.busy)} onClick={generate}>
          {state.busy ? 'Designing your website…' : hasDraft ? 'Design it again' : 'Create my website'}
        </button>
        {state.busy ? <p className="fine" role="status">This takes about 15 seconds.</p> : <Allowance usage={usage} kind="generation" noun="new designs" />}
        {state.error && (
          <p className="form-error" role="alert">
            {state.error}
          </p>
        )}
      </div>
    )
  }
  return (
    <div className="generator">
      <p className="lede">Choose a design. You can change anything afterwards.</p>
      {gen.source === 'template' && <p className="fine">Designed from your details using our standard layouts.</p>}
      <div className="design-grid">
        {gen.designs.map((d, i) => (
          <div key={i} className="design-card">
            <ScaledFrame title={`${d.name || `Design ${i + 1}`} design`} src={`/api/dashboard/website/preview?generation=${gen.id}&option=${i}`} height={1400} />
            <div className="design-card-foot">
              <strong>{d.name || `Design ${i + 1}`}</strong>
              <button type="button" className="btn btn-primary btn-sm" disabled={state.busy != null} onClick={() => choose(i)}>
                {state.busy === i ? 'Applying…' : 'Use this design'}
              </button>
            </div>
          </div>
        ))}
      </div>
      <button type="button" className="link-btn" onClick={() => setGen(null)}>
        Cancel
      </button>
      {state.error && (
        <p className="form-error" role="alert">
          {state.error}
        </p>
      )}
    </div>
  )
}

const SUGGESTIONS = ['Make it more modern', 'Make it warmer and friendlier', 'Use my photos', 'Make it simpler', 'Try a dark look']

// "Describe a change": one AI revision of the private draft, shown before anything is saved.
export function ReviseBox({ onApplied, onPreview, usage, onUsage }) {
  const [text, setText] = useState('')
  const [rev, setRev] = useState(null)
  const [state, setState] = useState({})
  const send = async (instruction) => {
    setState({ busy: true })
    const { status, data } = await api('/api/dashboard/website', { method: 'POST', body: { action: 'revise', instruction } })
    if (data?.aiUsage) onUsage?.(data.aiUsage)
    if (status === 200) {
      setRev(data.generation)
      setState({})
      onPreview?.(data.generation)
      // Bring the new version into view.
      requestAnimationFrame(() => document.querySelector('.site-preview')?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
    } else setState({ error: failText(status, data, 'AI changes') || 'We couldn’t make that change just now. Please try again.' })
  }
  const keep = async () => {
    setState({ busy: true })
    const { status, data } = await api('/api/dashboard/website', { method: 'POST', body: { action: 'apply', generationId: rev.id, option: 0 } })
    if (status === 200) {
      setRev(null)
      setText('')
      setState({})
      onPreview?.(null)
      onApplied(data)
    } else setState({ error: 'Couldn’t save that version. Please try again.' })
  }
  if (rev) {
    return (
      <div className="revise">
        <p className="lede">Here’s the new version. Keep it?</p>
        <div className="card-actions">
          <button type="button" className="btn btn-primary" disabled={state.busy} onClick={keep}>
            Keep this
          </button>
          <button
            type="button"
            className="btn btn-quiet"
            disabled={state.busy}
            onClick={() => {
              setRev(null)
              onPreview?.(null)
            }}
          >
            Go back
          </button>
        </div>
        {state.error && (
          <p className="form-error" role="alert">
            {state.error}
          </p>
        )}
      </div>
    )
  }
  return (
    <form
      className="revise"
      onSubmit={(e) => {
        e.preventDefault()
        if (text.trim()) send(text.trim())
      }}
    >
      <label className="field">
        <span>Describe a change</span>
        <div className="revise-row">
          <input value={text} onChange={(e) => setText(e.target.value)} maxLength={240} placeholder="e.g. Make it feel more premium" disabled={state.busy} />
          <button className="btn btn-primary" disabled={state.busy || !text.trim()}>
            {state.busy ? 'Working…' : 'Apply'}
          </button>
        </div>
      </label>
      <div className="suggestions" aria-label="Suggestions">
        {SUGGESTIONS.map((s) => (
          <button key={s} type="button" className="suggest" disabled={state.busy} onClick={() => send(s)}>
            {s}
          </button>
        ))}
      </div>
      {state.busy ? <p className="fine" role="status">Updating your website… about 10 seconds.</p> : <Allowance usage={usage} kind="revision" noun="AI changes" />}
      {state.error && (
        <p className="form-error" role="alert">
          {state.error}
        </p>
      )}
    </form>
  )
}
