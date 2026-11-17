import { useEffect, useRef, useState } from 'react'
import { api, noIndex } from '../lib/api.js'
import '../app.css'

// Public AI receptionist for one business: website chat and a browser voice call, both answered by the same engine
// on our server (real model, the business's verified facts, real calendar). Nothing here decides anything: the page
// shows what the server says.
const KEY = (id) => `gsu_rcpt_${id}`
const load = (id) => {
  try {
    return JSON.parse(sessionStorage.getItem(KEY(id)) || 'null')
  } catch {
    return null
  }
}
const save = (id, v) => {
  try {
    sessionStorage.setItem(KEY(id), JSON.stringify(v))
  } catch {
    // storage unavailable: the conversation still works, it just won't survive a reload
  }
}
const ERRORS = {
  network_error: 'Connection problem. Check your internet and try again.',
  rate_limited: 'That was a lot of messages at once. Wait a moment and try again.',
  busy: 'Still working on your last message. Try again in a moment.',
}

export default function ChatPage({ id }) {
  const [info, setInfo] = useState(null)
  const [msgs, setMsgs] = useState(() => load(id)?.msgs || [])
  const [conv, setConv] = useState(() => load(id)?.conv || null)
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState(null)
  const [booked, setBooked] = useState(() => load(id)?.booked || null)
  const [voice, setVoice] = useState({ state: 'idle' })
  const listRef = useRef(null)
  const callRef = useRef(null)

  useEffect(() => noIndex(), [])
  useEffect(() => {
    api(`/api/receptionist/${id}`).then(({ status, data }) => setInfo(status === 200 ? data : { missing: true }))
  }, [id])
  useEffect(() => save(id, { msgs, conv, booked }), [id, msgs, conv, booked])
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' })
  }, [msgs, sending, voice.lines])
  useEffect(() => () => callRef.current?.stopCall(), [])

  const send = async (value) => {
    const t = (value ?? text).trim()
    if (!t || sending) return
    setError(null)
    setSending(true)
    if (value === undefined) {
      setMsgs((m) => [...m, { who: 'customer', text: t }])
      setText('')
    }
    const { status, data } = await api(`/api/receptionist/${id}/chat`, { method: 'POST', body: { text: t, ...(conv ? { conversationId: conv.id, token: conv.token } : {}) } })
    setSending(false)
    if (status === 200) {
      setConv({ id: data.conversationId, token: data.token })
      setMsgs((m) => [...m, { who: 'receptionist', text: data.reply }])
      if (data.booked) setBooked(data.booked)
      return
    }
    if (status === 404 && data.error === 'conversation_not_found') setConv(null)
    setError({ text: t, message: ERRORS[status === 429 ? 'rate_limited' : data.error] || 'Something went wrong. Try again.' })
  }

  const startVoice = async () => {
    setVoice({ state: 'connecting', lines: [] })
    const { status, data } = await api(`/api/receptionist/${id}/voice`, { method: 'POST', body: {} })
    if (status !== 200) return setVoice({ state: 'error', message: data.error === 'voice_not_configured' ? 'Voice isn’t switched on yet.' : 'Couldn’t start the call. Try again or use chat.' })
    try {
      const { RetellWebClient } = await import('retell-client-js-sdk')
      const call = new RetellWebClient()
      callRef.current = call
      call.on('call_started', () => setVoice((v) => ({ ...v, state: 'live' })))
      call.on('agent_start_talking', () => setVoice((v) => ({ ...v, talking: true })))
      call.on('agent_stop_talking', () => setVoice((v) => ({ ...v, talking: false })))
      call.on('update', (u) => {
        if (Array.isArray(u?.transcript)) setVoice((v) => ({ ...v, lines: u.transcript.map((l) => ({ who: l.role === 'agent' ? 'receptionist' : 'customer', text: l.content })) }))
      })
      call.on('call_ended', () => {
        callRef.current = null
        setVoice((v) => ({ state: 'ended', lines: v.lines || [] }))
      })
      call.on('error', () => setVoice((v) => ({ ...v, state: 'error', message: 'The call dropped. You can try again or use chat.' })))
      await call.startCall({ accessToken: data.accessToken, callId: data.callId, transport: data.transport, iceServers: data.iceServers })
    } catch {
      setVoice({ state: 'error', message: 'Microphone or connection problem. Allow the microphone and try again.' })
    }
  }
  const endVoice = () => {
    callRef.current?.stopCall()
    callRef.current = null
    setVoice((v) => ({ state: 'ended', lines: v.lines || [] }))
  }

  if (!info) return <main className="rc-page" aria-busy="true" />
  if (info.missing) {
    return (
      <main className="rc-page">
        <p className="rc-empty">This page isn’t available.</p>
      </main>
    )
  }
  if (!info.enabled) {
    return (
      <main className="rc-page">
        <h1 className="rc-title">{info.name}</h1>
        <p className="rc-empty">
          Chat isn’t available right now. <a href={`/book/${id}`}>Book online</a>
        </p>
      </main>
    )
  }
  const voiceLive = voice.state === 'connecting' || voice.state === 'live'
  return (
    <main className="rc-page">
      <header className="rc-head">
        <div>
          <h1 className="rc-title">{info.name}</h1>
          <p className="rc-sub">AI receptionist · answers from {info.name}’s own information</p>
        </div>
        <nav className="rc-human" aria-label="Other ways to reach us">
          {info.phone && <a href={`tel:${info.phone.replace(/[^\d+]/g, '')}`}>Call {info.phone}</a>}
          <button type="button" className="link-btn" onClick={() => send('I would like to talk to a person, please.')} disabled={sending}>
            Talk to a person
          </button>
          <a href={`/book/${id}`}>Book online</a>
        </nav>
      </header>

      {booked && (
        <p className="rc-booked" role="status">
          Booked: {booked.time}. A confirmation is on its way to your email.
        </p>
      )}

      <section className="rc-list" ref={listRef} aria-label="Conversation" aria-live="polite">
        <p className="rc-msg rc-msg--receptionist">{info.greeting}</p>
        {msgs.map((m, i) => (
          <p key={i} className={`rc-msg rc-msg--${m.who}`}>
            {m.text}
          </p>
        ))}
        {sending && <p className="rc-msg rc-msg--receptionist rc-typing">Thinking…</p>}
        {voice.lines?.length > 0 && (
          <div className="rc-voice-lines" aria-label="Call transcript">
            <p className="fine">Call transcript</p>
            {voice.lines.map((l, i) => (
              <p key={i} className={`rc-msg rc-msg--${l.who}`}>
                {l.text}
              </p>
            ))}
          </div>
        )}
      </section>

      {error && (
        <p className="rc-error" role="alert">
          {error.message}{' '}
          <button type="button" className="link-btn" onClick={() => send(error.text)}>
            Retry
          </button>
        </p>
      )}

      {info.voice && (
        <div className="rc-voice">
          {voiceLive ? (
            <>
              <span className={`rc-dot${voice.talking ? ' rc-dot--talking' : ''}`} aria-hidden="true" />
              <span>{voice.state === 'connecting' ? 'Connecting…' : voice.talking ? 'Speaking…' : 'Listening — just talk'}</span>
              <button type="button" className="btn btn-sm btn-quiet" onClick={endVoice}>
                End call
              </button>
            </>
          ) : (
            <>
              <button type="button" className="btn btn-sm btn-quiet" onClick={startVoice}>
                Talk instead (uses your microphone)
              </button>
              {voice.message && <span className="fine">{voice.message}</span>}
            </>
          )}
        </div>
      )}

      <form
        className="rc-form"
        onSubmit={(e) => {
          e.preventDefault()
          send()
        }}
      >
        <label className="sr-only" htmlFor="rc-input">
          Your message
        </label>
        <input id="rc-input" value={text} onChange={(e) => setText(e.target.value)} placeholder="Ask about services, prices or a time…" maxLength={1500} autoComplete="off" disabled={voiceLive} />
        <button type="submit" className="btn btn-primary" disabled={!text.trim() || sending || voiceLive}>
          Send
        </button>
      </form>
      <p className="fine rc-foot">
        Powered by GetShowUps. Messages are kept for {info.name}. <a href="/privacy">Privacy</a>
      </p>
    </main>
  )
}
