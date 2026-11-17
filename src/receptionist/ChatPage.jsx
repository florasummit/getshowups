import { useCallback, useEffect, useRef, useState } from 'react'
import { api, noIndex } from '../lib/api.js'
import '../app.css'

// Public AI receptionist for one business: one conversation the customer can type in and/or talk in (browser voice).
// The server is the source of truth for what was said and what happened (booked / callback recorded / ended); this page
// only shows it. Ending a conversation closes it on the server and clears this browser's copy.
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
    if (v) sessionStorage.setItem(KEY(id), JSON.stringify(v))
    else sessionStorage.removeItem(KEY(id))
  } catch {
    // storage unavailable: the conversation still works, it just won't survive a reload
  }
}
const ERRORS = {
  network_error: 'Connection problem. Check your internet and try again.',
  rate_limited: 'That was a lot of messages at once. Wait a moment, then try again.',
  busy: 'Still working on your last message. Try again in a moment.',
}
const VOICE_ERRORS = {
  voice_not_configured: 'Voice isn’t available right now. You can keep typing.',
  conversation_ended: 'This conversation has ended. Start a new one to call.',
  mic: 'We couldn’t use your microphone. Allow microphone access in your browser, or keep typing.',
  dropped: 'The call dropped. You can call again or keep typing.',
  start: 'Couldn’t start the call. Try again or keep typing.',
}

export default function ChatPage({ id }) {
  const [info, setInfo] = useState(null)
  const [conv, setConv] = useState(() => load(id))
  const [lines, setLines] = useState([])
  const [outcome, setOutcome] = useState({ booked: null, request: null, ended: false })
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState(null)
  const [voice, setVoice] = useState({ state: 'idle', live: [] })
  const [confirmEnd, setConfirmEnd] = useState(false)
  const listRef = useRef(null)
  const inputRef = useRef(null)
  const callRef = useRef(null)

  useEffect(() => noIndex(), [])
  useEffect(() => {
    api(`/api/receptionist/${id}`).then(({ status, data }) => setInfo(status === 200 ? data : { missing: true }))
  }, [id])
  useEffect(() => save(id, conv), [id, conv])
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' })
  }, [lines, sending, voice.live])
  useEffect(() => () => callRef.current?.stopCall(), [])

  const applyState = (d) => setOutcome({ booked: d.booked || null, request: d.request || null, ended: Boolean(d.ended) })
  // The server's record of this conversation (what was typed AND said on calls).
  const refresh = useCallback(
    async (c = conv) => {
      if (!c) return
      const { status, data } = await api(`/api/receptionist/${id}/conversation`, { method: 'POST', body: { action: 'view', conversationId: c.id, token: c.token } })
      if (status === 200) {
        setLines(data.transcript)
        applyState(data)
      } else if (status === 404) {
        setConv(null)
        setLines([])
      }
    },
    [conv, id],
  )
  // Restore after a reload.
  useEffect(() => {
    if (conv) api(`/api/receptionist/${id}/conversation`, { method: 'POST', body: { action: 'view', conversationId: conv.id, token: conv.token } }).then(({ status, data }) => {
      if (status === 200) {
        setLines(data.transcript)
        applyState(data)
      } else if (status === 404) setConv(null)
    })
    // only on first load
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  const send = async (value) => {
    const t = (value ?? text).trim()
    if (!t || sending || outcome.ended) return
    setError(null)
    setSending(true)
    if (value === undefined) setText('')
    setLines((l) => [...l, { who: 'customer', text: t, channel: 'chat' }])
    const { status, data } = await api(`/api/receptionist/${id}/chat`, { method: 'POST', body: { text: t, ...(conv ? { conversationId: conv.id, token: conv.token } : {}) } })
    setSending(false)
    if (status === 200) {
      setConv({ id: data.conversationId, token: data.token })
      setLines((l) => [...l, { who: 'receptionist', text: data.reply, channel: 'chat' }])
      applyState(data)
      inputRef.current?.focus()
      return
    }
    setLines((l) => l.slice(0, -1))
    if (status === 410) return refresh()
    if (status === 404 && data.error === 'conversation_not_found') setConv(null)
    setError({ text: t, message: ERRORS[status === 429 ? 'rate_limited' : data.error] || 'Something went wrong. Try again.' })
  }

  const startVoice = async () => {
    if (voice.state === 'connecting' || voice.state === 'live' || outcome.ended) return
    setVoice({ state: 'connecting', live: [] })
    const { status, data } = await api(`/api/receptionist/${id}/voice`, { method: 'POST', body: conv ? { conversationId: conv.id, token: conv.token } : {} })
    if (status !== 200) return setVoice({ state: 'error', live: [], message: VOICE_ERRORS[data.error] || VOICE_ERRORS.start })
    const c = { id: data.conversationId, token: data.token }
    setConv(c)
    try {
      const { RetellWebClient } = await import('retell-client-js-sdk')
      const call = new RetellWebClient()
      callRef.current = call
      call.on('call_started', () => setVoice((v) => ({ ...v, state: 'live' })))
      call.on('agent_start_talking', () => setVoice((v) => ({ ...v, talking: true })))
      call.on('agent_stop_talking', () => setVoice((v) => ({ ...v, talking: false })))
      call.on('update', (u) => {
        if (Array.isArray(u?.transcript)) setVoice((v) => ({ ...v, live: u.transcript.map((l) => ({ who: l.role === 'agent' ? 'receptionist' : 'customer', text: l.content, channel: 'voice' })) }))
      })
      call.on('call_ended', () => {
        callRef.current = null
        setVoice({ state: 'ended', live: [] })
        refresh(c)
      })
      call.on('error', () => {
        callRef.current = null
        setVoice({ state: 'error', live: [], message: VOICE_ERRORS.dropped })
        refresh(c)
      })
      await call.startCall({ accessToken: data.accessToken, callId: data.callId, transport: data.transport, iceServers: data.iceServers })
    } catch (err) {
      callRef.current = null
      setVoice({ state: 'error', live: [], message: err?.name === 'NotAllowedError' || /permission|microphone/i.test(String(err?.message)) ? VOICE_ERRORS.mic : VOICE_ERRORS.start })
    }
  }
  const endVoice = () => {
    callRef.current?.stopCall()
  }

  const endConversation = async () => {
    setConfirmEnd(false)
    callRef.current?.stopCall()
    if (conv) {
      const { status, data } = await api(`/api/receptionist/${id}/conversation`, { method: 'POST', body: { action: 'end', conversationId: conv.id, token: conv.token } })
      if (status === 200) {
        setLines(data.transcript)
        applyState(data)
        return
      }
    }
    setOutcome((o) => ({ ...o, ended: true }))
  }
  const startNew = () => {
    callRef.current?.stopCall()
    callRef.current = null
    setConv(null)
    setLines([])
    setOutcome({ booked: null, request: null, ended: false })
    setVoice({ state: 'idle', live: [] })
    setError(null)
    setText('')
    setTimeout(() => inputRef.current?.focus(), 0)
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
          {info.phone && (
            <>
              {' '}
              or call <a href={`tel:${info.phone.replace(/[^\d+]/g, '')}`}>{info.phone}</a>
            </>
          )}
        </p>
      </main>
    )
  }
  const onCall = voice.state === 'connecting' || voice.state === 'live'
  const started = Boolean(conv) || lines.length > 0
  return (
    <main className="rc-page">
      <header className="rc-head">
        <div>
          <h1 className="rc-title">{info.name}</h1>
          <p className="rc-sub">AI receptionist</p>
        </div>
        {started && !outcome.ended && (
          <div className="rc-end">
            {confirmEnd ? (
              <>
                <button type="button" className="btn btn-sm btn-quiet" onClick={endConversation}>
                  End conversation
                </button>
                <button type="button" className="link-btn" onClick={() => setConfirmEnd(false)}>
                  Keep going
                </button>
              </>
            ) : (
              <button type="button" className="link-btn" onClick={() => setConfirmEnd(true)}>
                End conversation
              </button>
            )}
          </div>
        )}
      </header>

      {outcome.booked && (
        <p className="rc-banner rc-banner--ok" role="status">
          Booked: {outcome.booked.time}.
        </p>
      )}
      {outcome.request && !outcome.booked && (
        <p className="rc-banner" role="status">
          {outcome.request === 'callback' ? 'Your callback request is recorded for the team.' : 'Your message is recorded for the team.'}
        </p>
      )}

      <section className="rc-list" ref={listRef} aria-label="Conversation" aria-live="polite">
        <p className="rc-msg rc-msg--receptionist">{info.greeting}</p>
        {lines.map((m, i) => (
          <p key={i} className={`rc-msg rc-msg--${m.who}`}>
            {m.channel === 'voice' && <span className="rc-tag">said</span>}
            {m.text}
          </p>
        ))}
        {voice.live.map((m, i) => (
          <p key={`v${i}`} className={`rc-msg rc-msg--${m.who} rc-msg--live`}>
            <span className="rc-tag">said</span>
            {m.text}
          </p>
        ))}
        {sending && <p className="rc-msg rc-msg--receptionist rc-typing">Typing…</p>}
      </section>

      {error && (
        <p className="rc-error" role="alert">
          {error.message}{' '}
          <button type="button" className="link-btn" onClick={() => send(error.text)}>
            Retry
          </button>
        </p>
      )}

      {outcome.ended ? (
        <section className="rc-done" aria-label="Conversation ended">
          <p>
            <strong>This conversation has ended.</strong> {outcome.booked ? `Your appointment is booked for ${outcome.booked.time}.` : outcome.request === 'callback' ? 'Your callback request is recorded.' : ''}
          </p>
          <button type="button" className="btn btn-primary" onClick={startNew}>
            Start a new conversation
          </button>
        </section>
      ) : (
        <>
          {info.voice && (
            <div className="rc-voice" aria-live="polite">
              {onCall ? (
                <>
                  <span className={`rc-dot${voice.talking ? ' rc-dot--talking' : ''}`} aria-hidden="true" />
                  <span>{voice.state === 'connecting' ? 'Connecting your microphone…' : voice.talking ? 'Speaking…' : 'On a call: just talk. You can also type below.'}</span>
                  <button type="button" className="btn btn-sm btn-quiet" onClick={endVoice}>
                    End call
                  </button>
                </>
              ) : (
                <>
                  <button type="button" className="btn btn-sm btn-quiet" onClick={startVoice}>
                    {voice.state === 'ended' ? 'Call again' : 'Talk instead (uses your microphone)'}
                  </button>
                  {voice.state === 'ended' && <span className="fine">Call ended. Your microphone is off; you can keep typing.</span>}
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
            <input
              id="rc-input"
              ref={inputRef}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={onCall ? 'Type while you talk, for example your phone number' : 'Ask about services, prices or a time…'}
              maxLength={1500}
              autoComplete="off"
            />
            <button type="submit" className="btn btn-primary" disabled={!text.trim() || sending}>
              Send
            </button>
          </form>
          <p className="fine rc-foot">
            Want a person?{' '}
            <button type="button" className="link-btn" onClick={() => send('I’d like to talk to a person, please.')} disabled={sending}>
              Ask for a person
            </button>
            {info.phone && (
              <>
                {' · '}
                <a href={`tel:${info.phone.replace(/[^\d+]/g, '')}`}>Call {info.phone}</a>
              </>
            )}
            {' · '}
            <a href={`/book/${id}`}>Book online</a>
          </p>
        </>
      )}
      <p className="fine rc-foot">
        Powered by GetShowUps. Conversations are kept for {info.name}. <a href="/privacy">Privacy</a>
      </p>
    </main>
  )
}
