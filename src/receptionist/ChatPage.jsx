import { useCallback, useEffect, useRef, useState } from 'react'
import { api, noIndex, phoneText } from '../lib/api.js'
import { publicHead, telHref } from '../public/head.js'
import { BrandMark } from '../public/PublicShell.jsx'
import { accentVars } from '../public/color.js'
import './chat.css'

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
  noMic: 'No microphone was found. Connect one, or keep typing.',
  voice_not_available: 'Talking by voice isn’t available for this business yet. You can keep typing.',
  dropped: 'The call dropped. You can talk again or keep typing.',
  start: 'Couldn’t start talking. Try again or keep typing.',
  voice_busy: 'All voice lines are busy right now. Try again in a minute, or keep typing.',
  voice_limit: 'Voice isn’t available right now. You can keep typing.',
  test_limit: 'This test business has used its testing minutes for today (VOICE_TEST_DAILY_MINUTES). Try again tomorrow or raise the limit.',
  voice_unavailable: 'Voice isn’t available right now. You can keep typing.',
  voice_unreachable: 'Voice isn’t available right now. You can keep typing.',
  voice_in_progress: 'A call is already running in this conversation.',
  test_not_allowed: 'Test sessions are for signed-in platform admins only.',
  not_test_business: 'Test sessions run only on a test business.',
  // How a call ended when it did not end cleanly (src/voice/elevenlabs.js disconnectInfo codes): what happened and what
  // to do, in the caller's words; the technical record (close code, the provider's reason) goes to the session record
  // and is shown on an admin test page only.
  provider_refused: 'The voice service refused this call before it started. You can try again or keep typing.',
  closed_before_start: 'The voice service hung up before the call started. You can try again or keep typing.',
  socket_closed: 'The call dropped: the connection to the voice service closed. Check your internet and try again, or keep typing.',
  socket_error: 'We couldn’t reach the voice service. Check your internet and try again, or keep typing.',
  connect_timeout: 'The voice service didn’t answer in time. You can try again or keep typing.',
  payload_too_large: 'Couldn’t start talking (the call setup was too large). You can keep typing.',
  provider_error: 'The voice service ended the call with an error. You can try again or keep typing.',
  provider_closed: 'The voice service ended the call. You can try again or keep typing.',
  connection_lost: 'The call dropped. You can talk again or keep typing.',
  disconnected: 'The call dropped and reconnecting didn’t work. You can talk again or keep typing.',
  reconnect_failed: 'The call dropped and reconnecting didn’t work. You can talk again or keep typing.',
  connect_failed: 'Couldn’t start talking. Try again or keep typing.',
  rate_limited: 'Too many calls were started at once. Wait a moment, then try again.',
  session_expired: 'This call reached its time limit. You can talk again or keep typing.',
  reconnect_limit: 'The call dropped too many times. You can talk again or keep typing.',
}
// Why the server refused to open the page as an admin test (codes only).
const TEST_REFUSED = {
  test_not_allowed: 'Test sessions open only for a signed-in platform admin. Sign in to the Admin Console first, then open this page again.',
  not_test_business: 'This is not an admin-marked test business, so no test session can run here. Mark a test business in the Admin Console and test there.',
  invalid_provider: 'Unknown provider in the test link.',
  voice_not_configured: 'This provider is not configured on the platform (credentials missing), so it cannot be tested.',
  voice_unavailable: 'This provider is switched off on the platform, so it cannot be tested.',
  mic_denied: 'We couldn’t use your microphone. Allow microphone access in your browser, or keep typing.',
  connection_lost: 'The call dropped. You can talk again or keep typing.',
}
// ?test=<provider>: a platform admin testing a candidate provider on a test business (server-checked; dry run).
const testProvider = () => {
  const v = new URLSearchParams(window.location.search).get('test') || ''
  return /^[a-z]{3,20}$/.test(v) ? v : ''
}
const testVoice = () => {
  const v = new URLSearchParams(window.location.search).get('voice') || ''
  return /^[A-Za-z0-9_.:-]{1,120}$/.test(v) ? v : ''
}
const tel = telHref
// The longest message the server takes (functions/api/receptionist/[customer]/chat.js). The box never cuts text off:
// it counts down near the limit and says by how much a message is too long (CHAT-01).
const LIMIT = 1500
const NEAR_LIMIT = 1300
// The ad parameters this page was opened with (a website link from an ad carries them); validated on the server.
const adParams = () => {
  const q = new URLSearchParams(window.location.search)
  const out = {}
  for (const k of ['utm_source', 'utm_medium', 'utm_campaign', 'gclid']) if (q.get(k)) out[k] = q.get(k).slice(0, 200)
  return out
}

// Quick replies: natural sentences the customer can send with one tap, from the business's own offered services (never a
// service it doesn't list). Free text always stays available; the replies disappear once the conversation starts.
function quickReplies(info) {
  if (info.brand?.product) return ['How does it work?', 'What does it cost?', 'Is it a fit for a pool company?', 'Book a demo']
  const named = (info.services || []).slice(0, 3).map((s) => (s.flow === 'request' ? `I’d like a quote for ${s.name.toLowerCase()}` : `I’d like to book ${s.name.toLowerCase()}`))
  return [...named, 'What times are open this week?', ...(named.length ? [] : ['What do you offer?'])].slice(0, 4)
}
const embedMode = () => new URLSearchParams(window.location.search).get('embed') === '1'

function Send() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 19V5M5 12l7-7 7 7" />
    </svg>
  )
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
  const [loadFailed, setLoadFailed] = useState(false) // the conversation so far could not be fetched (CHAT-04)
  const [voice, setVoice] = useState({ state: 'idle', live: [] })
  const [confirmEnd, setConfirmEnd] = useState(false)
  const listRef = useRef(null)
  const inputRef = useRef(null)
  const callRef = useRef(null) // Retell SDK call, or the adapter of another provider (both expose stopCall())
  const newRef = useRef(null)
  const [audioBlocked, setAudioBlocked] = useState(false)
  const test = testProvider()

  useEffect(() => noIndex(), [])
  useEffect(() => {
    // ?test=<provider>: the server decides whether this is an authorized admin test (signed-in platform admin, test business).
    api(`/api/receptionist/${id}${test ? `?test=${encodeURIComponent(test)}` : ''}`).then(({ status, data }) => {
      setInfo(status === 200 ? data : { missing: true })
      // The tab names the business (never GetShowUps' marketing title or price on a customer's page).
      if (status === 200 && data.name) publicHead(data.brand?.product ? 'Chat · GetShowUps' : `Chat with ${data.name}`, data.brand?.product ? 'Ask about GetShowUps, or book a demo.' : `Ask ${data.name} a question or book an appointment.`)
    })
  }, [id, test])
  useEffect(() => save(id, conv), [id, conv])
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' })
  }, [lines, sending, voice.live, outcome])
  useEffect(() => () => callRef.current?.stopCall(), [])
  useEffect(() => {
    if (outcome.ended) newRef.current?.focus()
  }, [outcome.ended])
  // The message box grows with what is typed (one line when empty, up to about five; then it scrolls).
  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 132)}px`
  }, [text, info])

  const applyState = (d) => setOutcome({ booked: d.booked || null, request: d.request || null, ended: Boolean(d.ended) })
  // The server's record of this conversation (what was typed AND said on calls).
  const refresh = useCallback(
    async (c = conv) => {
      if (!c) return
      const { status, data } = await api(`/api/receptionist/${id}/conversation`, { method: 'POST', body: { action: 'view', conversationId: c.id, token: c.token } })
      setLoadFailed(status !== 200 && status !== 404)
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
    if (!t || t.length > LIMIT || sending || outcome.ended) return
    setError(null)
    setSending(true)
    if (value === undefined) setText('')
    // A retry replaces the unsent copy of the same message; other unsent messages stay, marked "Not sent".
    setLines((l) => [...l.filter((m) => !(m.failed && m.text === t)), { who: 'customer', text: t, channel: 'chat' }])
    const { status, data } = await api(`/api/receptionist/${id}/chat`, { method: 'POST', body: { text: t, ...(conv ? { conversationId: conv.id, token: conv.token } : { attribution: adParams() }) } })
    setSending(false)
    if (status === 200) {
      setConv({ id: data.conversationId, token: data.token })
      setLines((l) => [...l, { who: 'receptionist', text: data.reply, channel: 'chat' }])
      applyState(data)
      inputRef.current?.focus()
      return
    }
    if (status === 410) {
      setLines((l) => l.slice(0, -1))
      return refresh()
    }
    // The message stays where the customer put it, marked "Not sent" (CHAT-04); nothing typed is lost.
    setLines((l) => l.map((m, i) => (i === l.length - 1 ? { ...m, failed: true } : m)))
    if (status === 404 && data.error === 'conversation_not_found') setConv(null)
    setError({ text: t, message: ERRORS[status === 429 ? 'rate_limited' : data.error] || 'Something went wrong. Try again.' })
  }

  const startVoice = async () => {
    if (voice.state === 'connecting' || voice.state === 'live' || outcome.ended) return
    // A retry keeps the last call's disconnect record on the page until a new result replaces it.
    setVoice((v) => ({ state: 'connecting', live: [], diag: v.diag || null }))
    // Microphone first, inside the click (browsers tie the permission prompt and audio playback to the gesture): a
    // blocked or missing microphone is reported before a call is created, and the voice SDK loads meanwhile.
    const sdk = import('retell-client-js-sdk')
    sdk.catch(() => {}) // a failed load is reported where it is awaited below
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw Object.assign(new Error('microphone unavailable'), { name: 'NotAllowedError' })
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
      for (const t of stream.getTracks()) t.stop() // permission granted; the SDK opens its own capture
    } catch (err) {
      return setVoice({ state: 'error', live: [], message: err?.name === 'NotFoundError' ? VOICE_ERRORS.noMic : VOICE_ERRORS.mic })
    }
    const { status, data } = await api(`/api/receptionist/${id}/voice`, { method: 'POST', body: { ...(conv ? { conversationId: conv.id, token: conv.token } : { attribution: adParams() }), ...(test ? { test: { provider: test, ...(testVoice() ? { voiceId: testVoice() } : {}) } } : {}) } })
    if (status !== 200) return setVoice((v) => ({ state: 'error', live: [], message: VOICE_ERRORS[data.error] || VOICE_ERRORS.start, diag: v.diag || null }))
    // The conversation's token authorizes every later request of this call (tools, transcript, end): a session resumed on
    // this conversation keeps the token this page already holds.
    const c = { id: data.conversationId, token: data.token || (conv?.id === data.conversationId ? conv.token : data.token) }
    setConv(c)
    // The server chose the provider (the business's active one, or the admin's test candidate). Retell runs its own
    // SDK below; OpenAI Realtime and ElevenLabs run through the shared adapters, with every tool on our server.
    if (data.provider && data.provider !== 'retell') {
      try {
        const mod = data.provider === 'openai' ? await import('../voice/openai.js') : await import('../voice/elevenlabs.js')
        const routes = { connect: `/api/receptionist/${id}/voice-connect`, tool: `/api/receptionist/${id}/voice-tool`, session: `/api/receptionist/${id}/voice-session` }
        const adapter = data.provider === 'openai' ? mod.createOpenAIAdapter({ routes }) : mod.createElevenLabsAdapter({ routes })
        const live = []
        callRef.current = { stopCall: () => adapter.stop({ outcome: 'ended' }), adapter }
        const onEvent = (name, p) => {
          if (name === 'status') {
            if (p.state === 'connected') setVoice((v) => ({ ...v, state: 'live', talking: typeof p.speaking === 'boolean' ? p.speaking : p.mode ? p.mode === 'speaking' : v.talking }))
            if (p.state === 'connecting' || p.state === 'reconnecting') setVoice((v) => ({ ...v, state: 'connecting' }))
            if (p.state === 'stopped' || p.state === 'failed') {
              callRef.current = null
              setAudioBlocked(false)
              // A failure carries the adapter's disconnect record (phase, code, WebSocket close code, the provider's
              // reason), the same record the server keeps on the session: shown on an admin test page, kept across a retry.
              const diag = p.disconnect ? { ...p.disconnect, session: c.id, at: Date.now() } : null
              setVoice((v) => (p.state === 'failed' ? { state: 'error', live: [], message: VOICE_ERRORS[p.reason] || VOICE_ERRORS.dropped, diag: diag || v.diag || null } : { state: 'ended', live: [], diag: v.diag || null }))
              refresh(c)
            }
            if (p.state === 'connected' && p.audio === 'blocked') setAudioBlocked(true)
            if (p.audio === 'playing' || p.audio === 'received') setAudioBlocked(false)
          }
          if (name === 'transcript' && p.text) {
            const i = live.findIndex((l) => l.at === p.at && l.who === p.who)
            if (i >= 0) live[i] = { who: p.who, text: p.text, at: p.at, channel: 'voice' }
            else live.push({ who: p.who, text: p.text, at: p.at, channel: 'voice' })
            setVoice((v) => ({ ...v, live: [...live] }))
          }
          if (name === 'error' && p.code === 'audio_blocked') setAudioBlocked(true)
          if (name === 'error' && p.fatal) setVoice((v) => ({ ...v, message: VOICE_ERRORS[p.code] || VOICE_ERRORS.dropped }))
        }
        await adapter.start({ customer: id, id: c.id, token: c.token, onEvent, connect: data })
      } catch (err) {
        callRef.current = null
        setVoice((v) => ({ state: 'error', live: [], message: VOICE_ERRORS[err?.code] || (err?.code === 'mic_denied' ? VOICE_ERRORS.mic : VOICE_ERRORS.start), diag: v.diag || null }))
      }
      return
    }
    try {
      const { RetellWebClient } = await sdk
      const call = new RetellWebClient()
      callRef.current = call
      const heard = { micLive: 0, audioReceived: 0, startedAt: Date.now() }
      const reportEnd = () => api(`/api/receptionist/${id}/voice-session`, { method: 'POST', body: { action: 'end', id: c.id, token: c.token, metrics: { micLive: heard.micLive, audioReceived: heard.audioReceived, audioSeconds: Math.round((Date.now() - heard.startedAt) / 1000) }, outcome: 'ended' } }).catch(() => {})
      call.on('call_started', () => setVoice((v) => ({ ...v, state: 'live' })))
      call.on('user_start_talking', () => {
        heard.micLive = 1
      })
      call.on('agent_start_talking', () => {
        heard.audioReceived = 1
        setVoice((v) => ({ ...v, talking: true }))
      })
      call.on('agent_stop_talking', () => setVoice((v) => ({ ...v, talking: false })))
      call.on('update', (u) => {
        if (Array.isArray(u?.transcript)) setVoice((v) => ({ ...v, live: u.transcript.map((l) => ({ who: l.role === 'agent' ? 'receptionist' : 'customer', text: l.content, channel: 'voice' })) }))
      })
      call.on('call_ended', () => {
        callRef.current = null
        setVoice({ state: 'ended', live: [] })
        reportEnd().then(() => refresh(c))
      })
      call.on('error', () => {
        // Release the microphone and the connection (the SDK doesn't always end the call on an error).
        try {
          call.stopCall()
        } catch {}
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
  const enableSound = () => {
    const d = callRef.current?.adapter?.resumeAudio?.()
    if (d && d !== 'blocked') setAudioBlocked(false)
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
    setLoadFailed(false)
    setText('')
    setTimeout(() => inputRef.current?.focus(), 0)
  }

  const embed = embedMode()
  // Inside a website panel, links that leave the chat open in a new tab: the panel is too small for the booking page,
  // and the visitor keeps the site they were on.
  const out = embed ? { target: '_blank', rel: 'noopener' } : {}
  if (!info) return <div className="pub chat" aria-busy="true" />
  if (info.missing) {
    return (
      <div className="pub chat chat--notice">
        <h1 className="chat-empty">{embed ? 'Chat isn’t available right now. Please try again in a moment.' : 'This page isn’t available.'}</h1>
      </div>
    )
  }
  if (!info.enabled) {
    return (
      <div className="pub chat chat--notice" style={accentVars(info.brand?.accent, { product: info.brand?.product })}>
        <h1 className="chat-h1">
          <BrandMark name={info.name} brand={info.brand} />
        </h1>
        <p className="chat-empty">Chat isn’t available right now.</p>
        <p className="chat-notice-actions">
          <a className="pub-btn pub-btn--primary" href={`/book/${id}`} {...out}>
            Book online
          </a>
          {info.phone && (
            <a className="pub-btn pub-btn--quiet" href={tel(info.phone)}>
              Call {phoneText(info.phone)}
            </a>
          )}
        </p>
        {test && (
          <p className="chat-empty" data-test-refused={info.test?.error || 'unknown'}>
            {TEST_REFUSED[info.test?.error] || 'A test session could not be started here.'} <a href="/admin/voice-lab">Back to the Admin Console</a>
          </p>
        )}
      </div>
    )
  }
  const testing = Boolean(test && info.test?.provider) // the server confirmed this admin test session
  const testOnly = Boolean(info.testOnly) // receptionist off for customers: the admin's voice test only, no typed chat
  const onCall = voice.state === 'connecting' || voice.state === 'live'
  const started = Boolean(conv) || lines.length > 0
  const replies = !started && !testOnly && !outcome.ended ? quickReplies(info) : []
  const length = text.trim().length
  const tooLong = length > LIMIT
  return (
    <div className={`pub chat${embed ? ' chat--embed' : ''}`} style={accentVars(info.brand?.accent, { product: info.brand?.product })}>
      <header className="chat-head">
        <div className="chat-col chat-head-row">
          <div className="chat-id">
            <h1 className="chat-h1">{info.brand?.product ? <BrandMark name={info.name} brand={info.brand} href="/" /> : <BrandMark name={info.name} brand={info.brand} href={info.website || undefined} />}</h1>
            <p className="chat-sub">
              <span className="chat-status" aria-hidden="true" />
              {info.brand?.product ? 'Ask about GetShowUps, or book a demo' : 'Assistant · answers questions and books appointments'}
            </p>
          </div>
          <div className="chat-head-actions">
            {info.website && !embed && (
              <a className="pub-top-link" href={info.website}>
                Website
              </a>
            )}
            {started && !outcome.ended && !confirmEnd && (
              <button type="button" className="pub-btn pub-btn--link chat-end" onClick={() => setConfirmEnd(true)}>
                End conversation
              </button>
            )}
          </div>
        </div>
        {confirmEnd && (
          <div className="chat-col chat-confirm" role="group" aria-label="End this conversation?">
            <span>End this conversation? You can start a new one after.</span>
            <span className="chat-confirm-actions">
              <button type="button" className="pub-btn pub-btn--quiet" onClick={endConversation}>
                End conversation
              </button>
              <button type="button" className="pub-btn pub-btn--link" onClick={() => setConfirmEnd(false)}>
                Keep going
              </button>
            </span>
          </div>
        )}
      </header>

      <main className="chat-scroll" ref={listRef}>
        <section className="chat-col chat-msgs" aria-label="Conversation" aria-live="polite">
          <p className="chat-msg chat-msg--receptionist">{info.greeting}</p>
          {replies.length > 0 && (
            <div className="pub-chips chat-replies" role="group" aria-label="Suggested questions">
              {replies.map((r) => (
                <button key={r} type="button" className="pub-chip" onClick={() => send(r)} disabled={sending}>
                  {r}
                </button>
              ))}
            </div>
          )}
          {loadFailed && (
            <p className="chat-error" role="alert">
              We couldn’t load this conversation so far. Check your internet.{' '}
              <button type="button" className="pub-btn pub-btn--link" onClick={() => refresh()}>
                Try again
              </button>
            </p>
          )}
          {lines.map((m, i) => (
            <p key={i} className={`chat-msg chat-msg--${m.who}${m.failed ? ' chat-msg--failed' : ''}`}>
              {m.channel === 'voice' && <span className="chat-tag">said</span>}
              {m.text}
              {m.failed && <span className="chat-unsent">Not sent</span>}
            </p>
          ))}
          {voice.live.map((m, i) => (
            <p key={`v${i}`} className={`chat-msg chat-msg--${m.who} chat-msg--live`}>
              <span className="chat-tag">said</span>
              {m.text}
            </p>
          ))}
          {sending && (
            <p className="chat-msg chat-msg--receptionist chat-typing">
              <span className="chat-dots" aria-hidden="true">
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
                <span className="chat-badge chat-badge--ok">Booked</span> Your appointment is booked
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
              <p className="pub-fine">It’s on the {info.name} calendar.</p>
            </section>
          )}
          {outcome.request && !outcome.booked && (
            <section className="chat-card" role="status" aria-label="Request recorded">
              <p className="chat-card-title">
                <span className="chat-badge">Recorded</span> {outcome.request === 'callback' ? 'Your callback request is recorded for the team.' : 'Your message is recorded for the team.'}
              </p>
              <p className="pub-fine">
                The {info.name} team will see it.{info.phone ? ` If it’s urgent, you can also call ${info.phone}.` : ''}
              </p>
            </section>
          )}
          {error && (
            <p className="chat-error" role="alert">
              {error.message}{' '}
              <button type="button" className="pub-btn pub-btn--link" onClick={() => send(error.text)}>
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
              <button ref={newRef} type="button" className="pub-btn pub-btn--primary" onClick={startNew}>
                Start a new conversation
              </button>
            </section>
          ) : (
            <>
              {(onCall || voice.message || voice.state === 'ended') && (
                <div className={`chat-callbar${onCall ? ' is-live' : ''}`} aria-live="polite">
                  {onCall ? (
                    <>
                      <span className={`chat-dot${voice.talking ? ' is-talking' : ''}`} aria-hidden="true" />
                      <span className="chat-callbar-text">{voice.state === 'connecting' ? 'Connecting your microphone…' : voice.talking ? 'Speaking…' : 'Listening. Just talk, or type below.'}</span>
                      {audioBlocked && (
                        <button type="button" className="pub-btn pub-btn--quiet chat-small" onClick={enableSound}>
                          Enable sound
                        </button>
                      )}
                      <button type="button" className="pub-btn chat-small chat-hangup" onClick={endVoice}>
                        End call
                      </button>
                    </>
                  ) : (
                    <span className="chat-callbar-text">{voice.message || 'Call ended. Your microphone is off; you can keep typing.'}</span>
                  )}
                </div>
              )}
              {testing && voice.diag && !onCall && (
                <p className="chat-legal" data-test-diag={voice.diag.code} data-test-diag-close={voice.diag.closeCode ?? ''}>
                  Recorded on this test session ({voice.diag.session}): {voice.diag.code} {voice.diag.phase === 'live' ? 'during the call' : voice.diag.phase === 'reconnect' ? 'while reconnecting' : 'while connecting'}
                  {voice.diag.closeCode ? `, WebSocket close ${voice.diag.closeCode}` : ', no WebSocket close code'}
                  {voice.diag.reason ? `: “${voice.diag.reason}”` : ''}. The Voice Lab shows the same record under the last test. Press the microphone to try again; this record stays until a new call ends.
                </p>
              )}
              <form
                className="chat-composer"
                onSubmit={(e) => {
                  e.preventDefault()
                  send()
                }}
              >
                <label className="sr-only" htmlFor="rc-input">
                  Your message
                </label>
                <textarea
                  id="rc-input"
                  ref={inputRef}
                  rows={1}
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => {
                    // Enter sends (Shift+Enter starts a new line), as the one-line box did.
                    if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return
                    e.preventDefault()
                    send()
                  }}
                  placeholder={testOnly ? 'Typed chat is off for this test business: talk instead' : onCall ? 'Type while you talk, e.g. your phone number' : 'Ask about services, prices or a time…'}
                  autoComplete="off"
                  enterKeyHint="send"
                  disabled={testOnly}
                  aria-invalid={tooLong || undefined}
                  aria-describedby={length >= NEAR_LIMIT ? 'rc-count' : undefined}
                />
                {(info.voice || test) && !onCall && (
                  <button type="button" className="chat-icon-btn" onClick={startVoice} aria-label={voice.state === 'ended' ? 'Talk again (uses your microphone)' : 'Talk instead (uses your microphone)'} title="Talk instead">
                    <Mic />
                  </button>
                )}
                <button type="submit" className="chat-icon-btn chat-send" aria-label="Send" disabled={!length || tooLong || sending || testOnly}>
                  <Send />
                </button>
              </form>
              {length >= NEAR_LIMIT && (
                <p id="rc-count" className={`chat-count${tooLong ? ' is-over' : ''}`} role={tooLong ? 'alert' : undefined}>
                  {tooLong
                    ? `Your message is ${(length - LIMIT).toLocaleString('en-US')} ${length - LIMIT === 1 ? 'character' : 'characters'} too long. Shorten it to send (nothing is cut off).`
                    : `${length.toLocaleString('en-US')} of ${LIMIT.toLocaleString('en-US')} characters`}
                </p>
              )}
              <p className="chat-links">
                {!testOnly && (
                  <button type="button" className="pub-btn pub-btn--link" onClick={() => send('I’d like to talk to a person, please.')} disabled={sending}>
                    Ask for a person
                  </button>
                )}
                {info.phone && <a href={tel(info.phone)}>Call {phoneText(info.phone)}</a>}
                <a href={`/book/${id}`} {...out}>Book online</a>
              </p>
              {testing ? (
                <p className="chat-legal" data-test-session={info.test.provider}>
                  Admin test session on {info.test.name}, dry run: nothing is booked, nobody is messaged. Press the microphone, say hello, ask for available times, book one, then end the call.{' '}
                  {voice.state === 'ended' ? 'Call ended: the Admin Console shows whether it counts as verification. ' : ''}
                  <a href="/admin/voice-lab">Back to the Admin Console</a>
                </p>
              ) : test ? (
                <p className="chat-legal" data-test-refused={info.test?.error || 'unknown'}>
                  {TEST_REFUSED[info.test?.error] || 'A test session could not be started here.'} <a href="/admin/voice-lab">Back to the Admin Console</a>
                </p>
              ) : (
                info.voiceStatus === 'testing' && <p className="chat-legal">Talking by voice isn’t available for this business yet.</p>
              )}
            </>
          )}
          <p className="chat-legal chat-legal--foot">
            <span>AI assistant for {info.name}, powered by GetShowUps. It can’t transfer calls.</span>
            <a href="/privacy" target="_blank" rel="noopener">
              Privacy
            </a>
          </p>
        </div>
      </footer>
    </div>
  )
}
