// AI website design. "Create my website": one request writes the copy and three different designs from the
// business details; the owner picks one (previews render the stored result, no further AI calls) and it
// becomes the private draft. "Describe a change": one request revises the draft; the owner keeps it or
// goes back. The live website changes only when the owner publishes.
import { useEffect, useRef, useState } from 'react'
import { api } from '../lib/api.js'
import { ScaledFrame } from './WebsiteEditor.jsx'
import { recallPending, rememberPending, setPendingRevision } from './website-data.js'

const FAIL = { 503: 'Our website designer is busy. Please try again in a minute.' }
// Errors from the business's own Claude/OpenAI key, in plain words.
const OWN_KEY = {
  invalid_key: 'Your AI API key isn’t working any more. Replace it under “Your own AI key”, or remove it to use the included writer.',
  provider_billing: 'Your AI provider account has no credit or has hit its spending limit. Add credit in your provider’s billing settings, then try again. Waiting won’t fix this.',
  provider_rejected: 'Your AI provider couldn’t accept this request. Please try again later; if it keeps happening, contact us.',
  provider_rate_limited: 'Your AI provider says you’ve hit its rate limit. Please wait a minute and try again.',
  ai_declined: 'The AI declined this request. Try describing the change differently.',
  ai_invalid_output: 'The AI’s answer couldn’t be used. Please try again.',
  provider_unavailable: 'Your AI provider isn’t responding right now. Please try again in a minute.',
  model_unavailable: 'Your chosen AI model is no longer offered on your account. Choose another under “Your own AI key”.',
  no_tested_model: 'Auto has no tested model on your account yet. Choose a model under “Your own AI key”.',
  budget_reached: 'This would go over your monthly AI limit. Raise the limit under “Your own AI key”, or edit by hand.',
}

const resetTime = (ms) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
// Today's AI allowance for one kind ('generation' or 'revision'), e.g. "18 of 20 left today · resets at 7:00 PM".
// The count is always GetShowUps' own daily limit; who pays for the AI work depends on whether the business uses its own
// key (`ownKey`: 'anthropic' | 'openai' | null), so the second line says which.
const BILLER = { anthropic: ['Claude', 'Anthropic'], openai: ['OpenAI', 'OpenAI'] }
export function Allowance({ usage, kind, noun, ownKey = null }) {
  const u = usage?.[kind]
  if (!u) return null
  const own = BILLER[ownKey]
  return (
    <>
      <p className="fine" data-allowance={kind}>
        {u.remaining} of {u.limit} {noun} left today · resets at {resetTime(usage.resetsAt)}
      </p>
      <p className="fine" data-allowance-note={kind}>
        {own
          ? `This is a GetShowUps daily safety limit, not your ${own[1]} credit. These run on your own ${own[0]} API key and ${own[1]} bills you for them.`
          : 'Included with GetShowUps at no extra cost. Editing by hand is never limited.'}
      </p>
    </>
  )
}
const DESIGNED_SITE = 'Your website changed while this version was being made, so it wasn’t used. Refresh the page and ask again.'
// Specific, honest messages for the server's limits (manual editing is never limited).
const failText = (status, data, noun) =>
  data?.error === 'daily_limit'
    ? `You’ve used today’s ${data.limit} ${noun}. You can make more after ${resetTime(data.resetsAt)}, or edit the text below.`
    : data?.error === 'monthly_limit'
      ? 'You’ve reached this month’s AI limit. You can still edit the text and photos below.'
      : data?.error === 'rate_limited'
        ? 'That’s a lot of requests in a few minutes. Please wait a moment and try again.'
        : OWN_KEY[data?.error] || FAIL[status]

// `studio`: the chosen design becomes the multi-page website the full editor uses (Website tab, a business with no
// website yet); the three previews then show exactly that. `storeKey`: this business (so an unanswered set of designs
// is still offered after a reload). `onFallback`: offered when designs can't be made. `bare` + `trigger`: the caller owns
// the start button (the Website tab's start cards): nothing is shown until designs are asked for (trigger counts up).
export default function WebsiteGenerator({ hasDraft, onApplied, intro, usage, onUsage, templates = false, ownKey = null, studio = false, storeKey = null, onFallback = null, bare = false, trigger = 0, onBusy = null }) {
  const [gen, setGenState] = useState(null)
  const [state, setState] = useState({})
  const grid = useRef(null)
  const setGen = (g) => {
    setGenState(g)
    // The standard layouts cost nothing and are made again in a moment: only AI designs are remembered.
    if (!templates) rememberPending('designs', storeKey, g)
  }
  // Designs made before a reload are still offered (they already counted against today's allowance).
  useEffect(() => {
    let live = true
    if (templates) return undefined
    recallPending('designs', storeKey, studio ? 'studio=1&' : '').then((kept) => live && kept?.designs?.length && setGenState((g) => g || kept))
    return () => {
      live = false
    }
  }, [storeKey, studio, templates])
  // The designs (and the first "Use this design") come into view when they arrive.
  useEffect(() => {
    if (gen) grid.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' })
  }, [gen])
  const generate = async () => {
    setState({ busy: 'writing' })
    onBusy?.(true)
    const { status, data } = await api('/api/dashboard/website', { method: 'POST', body: { action: templates ? 'template' : 'generate' } })
    onBusy?.(false)
    if (data?.aiUsage) onUsage?.(data.aiUsage)
    if (status === 200) {
      setGen(data.generation)
      setState({})
    } else setState({ error: failText(status, data, 'new designs') || 'We couldn’t create it just now. Please try again.' })
  }
  const asked = useRef(trigger)
  useEffect(() => {
    if (trigger === asked.current) return
    asked.current = trigger
    generate()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per press of the caller's button
  }, [trigger])
  const choose = async (option) => {
    setState({ busy: option })
    const { status, data } = await api('/api/dashboard/website', { method: 'POST', body: { action: 'apply', generationId: gen.id, option, ...(studio ? { studio: true } : {}) } })
    if (status === 200) {
      setGen(null)
      setState({})
      onApplied(data)
    } else if (status === 404) {
      setGen(null)
      setState({ error: 'Those designs are no longer available. Please create them again.' })
    } else setState({ error: data?.error === 'designed_site' ? DESIGNED_SITE : 'Couldn’t use that design. Please try again.' })
  }

  if (!gen && bare) {
    if (!state.busy && !state.error) return null
    return (
      <div className="generator">
        {state.busy && <p className="fine" role="status">Designing your website… this takes about 15 seconds.</p>}
        {state.error && (
          <p className="form-error" role="alert">
            {state.error}
          </p>
        )}
        {state.error && onFallback && (
          <button type="button" className="btn btn-quiet" onClick={onFallback}>
            Build it from my business details instead
          </button>
        )}
      </div>
    )
  }
  if (!gen) {
    return (
      <div className="generator">
        {intro && <p className="lede">{intro}</p>}
        {hasDraft && <p className="fine">This creates three new designs to choose from. Your current draft stays until you pick one, and your live website doesn’t change until you publish.</p>}
        <button type="button" className="btn btn-primary btn-lg" disabled={Boolean(state.busy)} onClick={generate}>
          {state.busy ? 'Designing your website…' : templates ? 'Show me the designs' : hasDraft ? 'Design it again' : 'Create my website'}
        </button>
        {templates ? null : state.busy ? <p className="fine" role="status">This takes about 15 seconds.</p> : <Allowance usage={usage} kind="generation" noun="new designs" ownKey={ownKey} />}
        {state.error && (
          <p className="form-error" role="alert">
            {state.error}
          </p>
        )}
        {state.error && onFallback && (
          <button type="button" className="btn btn-quiet" onClick={onFallback}>
            Build it from my business details instead
          </button>
        )}
      </div>
    )
  }
  return (
    <div className="generator" ref={grid}>
      <p className="lede">Choose a design. You can change anything afterwards.</p>
      {gen.source === 'template' && <p className="fine">Designed from your details using our standard layouts.</p>}
      <div className="design-grid">
        {gen.designs.map((d, i) => (
          <div key={i} className="design-card">
            {/* Name and button first: the choice is on screen without scrolling past a tall preview (ONB-07). */}
            <div className="design-card-foot design-card-head">
              <strong>{d.name || `Design ${i + 1}`}</strong>
              <button type="button" className="btn btn-primary btn-sm" disabled={state.busy != null} onClick={() => choose(i)} aria-label={`Use this design: ${d.name || `Design ${i + 1}`}`}>
                {state.busy === i ? 'Applying…' : 'Use this design'}
              </button>
            </div>
            <ScaledFrame title={`${d.name || `Design ${i + 1}`} design`} src={`/api/dashboard/website/preview?generation=${gen.id}&option=${i}${studio ? '&studio=1' : ''}`} height={1400} />
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

// For a multi-page website: only requests the change can carry out there (see data-revise-scope below).
const PAGE_SUGGESTIONS = ['Make it more modern', 'Make it warmer and friendlier', 'Try a dark look', 'Make the introduction shorter']
const SUGGESTIONS = ['Make it more modern', 'Make it warmer and friendlier', 'Use my photos', 'Make it simpler', 'Try a dark look']

// "Describe a change": one AI revision of the private draft, shown before anything is saved.
// The version waiting for an answer is announced to the rest of the page (setPendingRevision), so nothing claims
// "All changes saved" or lets the owner walk past it meanwhile, and it is still offered after a reload (`storeKey`).
// `pages`: the draft is a multi-page website (full editor): the box says what a change can and cannot touch, and offers
// only suggestions that work there. `hold`: a reason the box must wait (e.g. the editor is still saving).
export function ReviseBox({ onApplied, onPreview, usage, onUsage, ownKey = null, storeKey = null, pages = false, hold = null }) {
  const [text, setText] = useState('')
  const [rev, setRevState] = useState(null)
  const [state, setState] = useState({})
  const preview = useRef(onPreview)
  useEffect(() => {
    preview.current = onPreview
  })
  const setRev = (r) => {
    setRevState(r)
    rememberPending('revision', storeKey, r)
    setPendingRevision(r)
    preview.current?.(r)
  }
  useEffect(() => {
    let live = true
    recallPending('revision', storeKey).then((kept) => {
      if (!live || !kept) return
      setRevState(kept)
      setPendingRevision(kept)
      preview.current?.(kept)
    })
    return () => {
      live = false
      setPendingRevision(null)
    }
  }, [storeKey])
  const send = async (instruction) => {
    setState({ busy: true })
    const { status, data } = await api('/api/dashboard/website', { method: 'POST', body: { action: 'revise', instruction } })
    if (data?.aiUsage) onUsage?.(data.aiUsage)
    if (status === 200) {
      setRev(data.generation)
      setState({})
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
      onApplied(data)
    } else if (status === 404) {
      setRev(null)
      setState({ error: 'That version is no longer available. Please ask for the change again.' })
    } else setState({ error: data?.error === 'designed_site' ? DESIGNED_SITE : 'Couldn’t save that version. Please try again.' })
  }
  if (rev) {
    return (
      <div className="revise">
        <p className="lede">Here’s the new version. Keep it?</p>
        <p className="fine">It isn’t saved yet. Keep it, or go back to your draft as it was.</p>
        <div className="card-actions">
          <button type="button" className="btn btn-primary" disabled={state.busy} onClick={keep}>
            Keep this
          </button>
          <button
            type="button"
            className="btn btn-quiet"
            disabled={state.busy}
            onClick={() => setRev(null)}
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
          <button className="btn btn-primary" disabled={state.busy || !text.trim() || Boolean(hold)}>
            {state.busy ? 'Working…' : 'Apply'}
          </button>
        </div>
      </label>
      <div className="suggestions" aria-label="Suggestions">
        {(pages ? PAGE_SUGGESTIONS : SUGGESTIONS).map((s) => (
          <button key={s} type="button" className="suggest" disabled={state.busy || Boolean(hold)} onClick={() => send(s)}>
            {s}
          </button>
        ))}
      </div>
      {pages && (
        <p className="fine" data-revise-scope>
          It can reword your first screen’s headline and introduction, your About text and service descriptions, and change colours, lettering, corner shape and the first photo. It doesn’t add, remove or move pages and sections, and never touches your privacy or terms pages. You see the result before anything is saved.
        </p>
      )}
      {hold && <p className="fine">{hold}</p>}
      {state.busy ? <p className="fine" role="status">Updating your website… about 10 seconds.</p> : <Allowance usage={usage} kind="revision" noun="AI changes" ownKey={ownKey} />}
      {state.error && (
        <p className="form-error" role="alert">
          {state.error}
        </p>
      )}
    </form>
  )
}
