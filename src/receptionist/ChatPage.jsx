import { useCallback, useEffect, useRef, useState } from 'react'
import { api, noIndex } from '../lib/api.js'
import { Pill } from '../dashboard/ui.jsx'
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
  conversation_ended: 'This conversation has ended. Start a new one to talk.',
  mic: 'We couldn’t use your microphone. Allow microphone access in your browser, or keep typing.',
  dropped: 'The call dropped. You can talk again or keep typing.',
  start: 'Couldn’t start talking. Try again or keep typing.',
}
const tel = (p) => `tel:${p.replace(/[^\d+]/g, '')}`
// The ad parameters this page was opened with (a website link from an ad carries them); validated on the server.
const adParams = () => {
  const q = new URLSearchParams(window.location.search)
  const out = {}
  for (const k of ['utm_source', 'utm_medium', 'utm_campaign', 'gclid']) if (q.get(k)) out[k] = q.get(k).slice(0, 200)
  return out
}

function Mic() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
    </svg>
  )
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
  const newRef = useRef(null)

  useEffect(() => noIndex(), [])
  useEffect(() => {
    api(`/api/receptionist/${id}`).then(({ status, data }) => setInfo(status === 200 ? data : { missing: true }))
  }, [id])
  useEffect(() => save(id, conv), [id, conv])
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' })
  }, [lines, sending, voice.live, outcome])
  useEffect(() => () => callRef.current?.stopCall(), [])
  useEffect(() => {
    if (outcome.ended) newRef.current?.focus()
  }, [outcome.ended])

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
    if (conv) refresh(conv)
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
    const { status, data } = await api(`/api/receptionist/${id}/chat`, { method: 'POST', body: { text: t, ...(conv ? { conversationId: conv.id, token: conv.token } : { attribution: adParams() }) } })
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
    const { status, data } = await api(`/api/receptionist/${id}/voice`, { method: 'POST', body: conv ? { conversationId: conv.id, token: conv.token } : { attribution: adParams() } })
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
  const endVoice = () => callRef.current?.stopCall()

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

  if (!info) return <main className="rcp" aria-busy="true" />
  if (info.missing) {
    return (
      <main className="rcp rcp--notice">
        <p className="rc-empty">This page isn’t available.</p>
      </main>
    )
  }
  if (!info.enabled) {
    return (
      <main className="rcp rcp--notice">
        <h1 className="chat-name">{info.name}</h1>
        <p className="rc-empty">
          Chat isn’t available right now. <a href={`/book/${id}`}>Book online</a>
          {info.phone && (
            <>
              {' '}
              or call <a href={tel(info.phone)}>{info.phone}</a>
            </>
          )}
        </p>
      </main>
    )
  }
  const onCall = voice.state === 'connecting' || voice.state === 'live'
  const started = Boolean(conv) || lines.length > 0
  return (
    <div className="rcp">
      <header className="chat-head">
        <div className="chat-col chat-head-row">
          <span className="chat-avatar" aria-hidden="true">
            {info.name.trim().charAt(0).toUpperCase()}
          </span>
          <div className="chat-id">
            <h1 className="chat-name">{info.name}</h1>
            <p className="chat-sub">AI assistant · answers questions and books appointments</p>
          </div>
          <div className="chat-head-actions">
            {info.website && (
              <a className="link-btn" href={info.website}>
                Website
              </a>
            )}
            {started && !outcome.ended && !confirmEnd && (
              <button type="button" className="link-btn" onClick={() => setConfirmEnd(true)}>
                End conversation
              </button>
            )}
          </div>
        </div>
        {confirmEnd && (
          <div className="chat-col chat-confirm" role="group" aria-label="End this conversation?">
            <span>End this conversation? You can start a new one after.</span>
            <span className="chat-confirm-actions">
              <button type="button" className="btn btn-sm btn-quiet" onClick={endConversation}>
                End conversation
              </button>
              <button type="button" className="link-btn" onClick={() => setConfirmEnd(false)}>
                Keep going
              </button>
            </span>
          </div>
        )}
      </header>

      <main className="chat-scroll" ref={listRef}>
        <section className="chat-col chat-msgs" aria-label="Conversation" aria-live="polite">
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
          {sending && (
            <p className="rc-msg rc-msg--receptionist rc-typing">
              <span className="dots" aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
              <span className="sr-only">Typing…</span>
            </p>
          )}
          {outcome.booked && (
            <section className="chat-card chat-card--ok" role="status" aria-label="Appointment booked">
              <p className="chat-card-title">
                <Pill tone="ok">Booked</Pill> Your appointment is booked
              </p>
              <dl className="chat-facts">
                {outcome.booked.service && (
                  <div>
                    <dt>Service</dt>
                    <dd>{outcome.booked.service}</dd>
                  </div>
                )}
                <div>
                  <dt>When</dt>
                  <dd>{outcome.booked.time}</dd>
                </div>
                {outcome.booked.address && (
                  <div>
                    <dt>Where</dt>
                    <dd>{outcome.booked.address}</dd>
                  </div>
                )}
              </dl>
              <p className="ui-hint">It’s on the {info.name} calendar.</p>
            </section>
          )}
          {outcome.request && !outcome.booked && (
            <section className="chat-card" role="status" aria-label="Request recorded">
              <p className="chat-card-title">
                <Pill tone="info">Recorded</Pill> {outcome.request === 'callback' ? 'Your callback request is recorded for the team.' : 'Your message is recorded for the team.'}
              </p>
              <p className="ui-hint">
                The {info.name} team will see it.{info.phone ? ` If it’s urgent, you can also call ${info.phone}.` : ''}
              </p>
            </section>
          )}
          {error && (
            <p className="rc-error" role="alert">
              {error.message}{' '}
              <button type="button" className="link-btn" onClick={() => send(error.text)}>
                Retry
              </button>
            </p>
          )}
        </section>
      </main>

      <footer className="chat-dock">
        <div className="chat-col">
          {outcome.ended ? (
            <section className="chat-ended" aria-label="Conversation ended">
              <p>
                <strong>This conversation has ended.</strong>{' '}
                {outcome.booked ? `Your appointment is booked for ${outcome.booked.time}.` : outcome.request === 'callback' ? 'Your callback request is recorded.' : 'Thanks for reaching out.'}
              </p>
              <button ref={newRef} type="button" className="btn btn-primary" onClick={startNew}>
                Start a new conversation
              </button>
            </section>
          ) : (
            <>
              {(onCall || voice.message || voice.state === 'ended') && (
                <div className={`callbar${onCall ? ' callbar--live' : ''}`} aria-live="polite">
                  {onCall ? (
                    <>
                      <span className={`rc-dot${voice.talking ? ' rc-dot--talking' : ''}`} aria-hidden="true" />
                      <span className="callbar-text">{voice.state === 'connecting' ? 'Connecting your microphone…' : voice.talking ? 'Speaking…' : 'Listening. Just talk, or type below.'}</span>
                      <button type="button" className="btn btn-sm btn-danger" onClick={endVoice}>
                        End call
                      </button>
                    </>
                  ) : (
                    <span className="callbar-text">{voice.message || 'Call ended. Your microphone is off; you can keep typing.'}</span>
                  )}
                </div>
              )}
              <form
                className="composer"
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
                  placeholder={onCall ? 'Type while you talk, e.g. your phone number' : 'Ask about services, prices or a time…'}
                  maxLength={1500}
                  autoComplete="off"
                  enterKeyHint="send"
                />
                {info.voice && !onCall && (
                  <button type="button" className="composer-mic" onClick={startVoice} aria-label={voice.state === 'ended' ? 'Talk again (uses your microphone)' : 'Talk instead (uses your microphone)'} title="Talk instead">
                    <Mic />
                  </button>
                )}
                <button type="submit" className="btn btn-primary composer-send" disabled={!text.trim() || sending}>
                  Send
                </button>
              </form>
              <p className="chat-links">
                <button type="button" className="link-btn" onClick={() => send('I’d like to talk to a person, please.')} disabled={sending}>
                  Ask for a person
                </button>
                {info.phone && <a href={tel(info.phone)}>Call {info.phone}</a>}
                <a href={`/book/${id}`}>Book online</a>
              </p>
            </>
          )}
          <p className="chat-legal">
            AI assistant for {info.name}, powered by GetShowUps. It can’t transfer calls. <a href="/privacy">Privacy</a>
          </p>
        </div>
      </footer>
    </div>
  )
}
