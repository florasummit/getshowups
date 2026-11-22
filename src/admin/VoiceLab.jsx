// /admin/voice-lab — the Voice Lab (platform admins; every request is authorized server-side and the Lab is 404 unless
// VOICE_LAB_ENABLED=true). Put the SAME receptionist on a voice call through a provider (Retell = the production path,
// OpenAI Realtime, ElevenLabs) against an admin-marked TEST business, dry-run by default, and see honestly what
// happened: provider status (configured or not, with the reason), the daily minute budget, the live transcript and
// tool results as the adapter reports them, latency as the adapter measured it, and the engine's end-of-session summary.
// Adapters (src/voice/<provider>.js) are loaded lazily: a provider whose adapter isn't in this build says so.
import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../lib/api.js'
import { Badge, Empty, Facts, LoadError, Loading, PageHead, Section } from './control/ui.jsx'
import { ago, mins } from './control/lib.js'
import './control.css'
import './voice-lab.css'

// Every adapter module present in this build (Vite resolves the glob at build time; a missing module is simply absent).
const ADAPTERS = import.meta.glob(['../voice/*.js', '!../voice/adapter.js'])
const PROVIDERS = [
  ['retell', 'Retell', 'Production browser voice: Retell does speech, the engine is its custom LLM.'],
  ['openai', 'OpenAI Realtime', 'Speech + model at OpenAI; every business tool runs on our server.'],
  ['elevenlabs', 'ElevenLabs', 'Conversational AI agent; client tools forwarded to our server.'],
]
// What a session costs and where it is capped, said before Start (every provider bills per minute; none of it is
// measured here). Sessions start only on Start, one at a time, ≤ 15 minutes, inside the daily minute budget.
const COST = {
  retell: 'Billable: Retell charges the GetShowUps Retell account per minute of call (the same agent customers use).',
  openai: 'Billable: OpenAI charges per audio token on the GetShowUps OpenAI account (estimate shown after the session).',
  elevenlabs: 'Billable: ElevenLabs charges per minute on the GetShowUps ElevenLabs account (estimate shown after the session).',
}
const FACTORY = { retell: 'createRetellAdapter', openai: 'createOpenAIAdapter', elevenlabs: 'createElevenLabsAdapter' }
const REASON = {
  retell_not_configured: 'not configured (RETELL_API_KEY, RETELL_AGENT_ID, RETELL_WS_SECRET)',
  openai_not_configured: 'not configured (OPENAI_API_KEY)',
  elevenlabs_not_configured: 'not configured (ELEVENLABS_API_KEY, ELEVENLABS_AGENT_ID)',
}
const START_ERRORS = {
  not_found: 'Voice Lab is switched off (VOICE_LAB_ENABLED).',
  invalid_provider: 'Unknown provider.',
  not_test_business: 'That business is not marked as a test business.',
  lab_daily_limit: 'The Lab’s daily minute budget is used up for today.',
  lab_busy: 'Another Lab call is still open. Stop it first (an abandoned one ages out after 15 minutes).',
  reconnect_limit: 'This session reconnected too many times. Start a new one.',
  voice_billing: 'The Retell account refused the call (billing).',
  voice_unreachable: 'Retell could not be reached.',
  receptionist_unavailable: 'The receptionist tables are not applied yet (migration 0026).',
  rate_limited: 'Too many sessions started. Wait a few minutes.',
  mic: 'We couldn’t use your microphone. Allow microphone access in your browser and try again.',
  no_mic: 'No microphone was found on this device.',
  adapter_unavailable: 'This provider’s adapter is not in this build.',
  popup_blocked: 'The browser blocked the new tab. Allow pop-ups for this site and try again.',
}
const CONNECTION = { idle: ['neutral', 'Not connected'], connecting: ['info', 'Connecting'], listening: ['ok', 'Listening'], speaking: ['ok', 'Speaking'], ended: ['neutral', 'Ended'], error: ['bad', 'Error'] }
const OUTCOME = { booked: 'Booked', coverage_request: 'Service-area request', callback: 'Callback requested', callback_urgent: 'Urgent callback requested', message: 'Message left', out_of_area: 'Outside the area', info: 'Questions answered', error: 'Error', handoff: 'Hand-off' }

const adapterAvailable = (p) => Boolean(ADAPTERS[`../voice/${p}.js`])
async function loadAdapter(p) {
  const loader = ADAPTERS[`../voice/${p}.js`]
  if (!loader) return null
  const mod = await loader()
  const factory = mod[FACTORY[p]] || mod.createAdapter || mod.default
  return typeof factory === 'function' ? factory() : null
}
const ms = (v) => (Number.isFinite(v) ? `${Math.round(v)} ms` : '—')
const usd = (micros) => `$${(micros / 1e6).toFixed(micros < 100_000 ? 4 : 2)}`
const outcomeLabel = (s) => (s.booked ? (s.simulated ? 'Booked (dry run: nothing created)' : 'Booked') : OUTCOME[s.outcome] || s.outcome || 'No outcome recorded')

// The owner's readiness questions for one provider, answered by the server from configuration (never a provider call).
function Readiness({ r }) {
  if (!r) return null
  const yes = (b) => (b ? 'Yes' : 'No')
  const rows = [
    ['Integration implemented?', `${yes(r.integration.built)}. ${r.integration.note}`],
    ['Credentials configured?', r.credentials.configured ? 'Yes.' : `No: ${r.credentials.missing.length ? `${r.credentials.missing.join(', ')} not set` : 'a setting is present but not usable'}. Setting a provider key is a paid-service activation (approval).`],
    ['Account or billing to set up?', r.account],
    ['Can a browser voice session run now?', `${yes(r.session.canRun)}. ${r.session.note}`],
    ['Booking tools safe to use?', r.tools],
    ['Transcripts and latency recorded?', `${yes(r.records.transcripts && r.records.latency)}: transcript lines, first/median/p95 reply, interruptions and every tool outcome, per session.`],
    ['What does usage cost?', r.cost.perMinuteMicros ? `About ${(r.cost.perMinuteMicros / 1e6).toFixed(2)} per minute (estimate from the provider’s price list; never measured spend).` : r.cost.note],
    ['Smallest authorized test', r.smallestTest],
    ['Voice settings', r.settings],
  ]
  return (
    <Section title={`Readiness: ${r.name}`} id="vl-readiness" sub={r.blockers.length ? `Blocked: ${r.blockers.join('; ')}.` : 'Ready for a test session.'} data-readiness={r.id} data-ready={r.session.canRun ? 'yes' : 'no'}>
      <div className="cc-section-body">
        <dl className="cc-kv vl-readiness">
          {rows.map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
      </div>
    </Section>
  )
}

export default function VoiceLab() {
  const [status, setStatus] = useState(null)
  const [reload, setReload] = useState(0)
  const [provider, setProvider] = useState('openai')
  const [business, setBusiness] = useState('')
  const [dryRun, setDryRun] = useState(true)
  const [voice, setVoice] = useState('')
  const [session, setSession] = useState({ phase: 'idle', connection: 'idle', lines: [], tools: [], metrics: {}, error: null, summary: null })
  const [now, setNow] = useState(0)
  const adapterRef = useRef(null)
  const sentRef = useRef(0)
  const finishingRef = useRef(false)
  const sessionRef = useRef(null)
  const linesRef = useRef([])
  const metricsRef = useRef({})

  useEffect(() => {
    document.title = 'Voice Lab · GetShowUps'
  }, [])
  useEffect(() => {
    let live = true
    api('/api/platform/voice-lab/status').then(({ status: code, data }) => {
      if (!live) return
      if (code === 200) {
        setStatus(data)
        setBusiness((b) => b || data.businesses[0]?.id || '')
        setProvider((p) => (data.providers[p]?.configured ? p : PROVIDERS.find(([id]) => data.providers[id]?.configured)?.[0] || p))
      } else setStatus({ error: code === 404 ? 'off' : data?.error || 'failed' })
    })
    return () => {
      live = false
    }
  }, [reload])
  useEffect(() => {
    if (session.phase !== 'live') return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [session.phase])

  const update = (fn) => setSession((s) => ({ ...s, ...fn(s) }))

  const finish = useCallback(async () => {
    const s = sessionRef.current
    if (!s || finishingRef.current) return
    finishingRef.current = true
    update(() => ({ phase: 'ending' }))
    const adapter = adapterRef.current
    try {
      adapter?.stop?.({ outcome: 'stopped' })
    } catch {
      // the adapter had already ended
    }
    const lines = linesRef.current.filter((l) => l.final !== false)
    const fresh = lines.slice(sentRef.current)
    if (fresh.length) await api('/api/platform/voice-lab/session', { method: 'POST', body: { action: 'transcript', customer: s.customer.id, id: s.id, token: s.token, lines: fresh.map((l) => ({ who: l.who, text: l.text, at: l.at })) } })
    sentRef.current = lines.length
    let metrics = metricsRef.current
    try {
      metrics = { ...metrics, ...(adapter?.metrics?.() || {}) }
    } catch {
      // metrics are optional
    }
    const { status: code, data } = await api('/api/platform/voice-lab/session', { method: 'POST', body: { action: 'end', customer: s.customer.id, id: s.id, token: s.token, metrics } })
    adapterRef.current = null
    update((s) => ({ phase: 'done', summary: code === 200 ? data.summary : null, error: code === 200 ? s.error : `Couldn’t close the session (${data?.error || code}).` }))
    setReload((n) => n + 1)
  }, [])

  const onEvent = useCallback(
    (ev) => {
      if (!ev || typeof ev !== 'object') return
      if (ev.type === 'status') {
        update(() => ({ connection: ev.state, connectionReason: ev.reason || null }))
        if (ev.state === 'ended' && sessionRef.current) finish()
      } else if (ev.type === 'transcript') {
        if (!(ev.who === 'customer' || ev.who === 'receptionist') || typeof ev.text !== 'string') return
        update((s) => {
          const lines = [...s.lines]
          const last = lines.at(-1)
          if (last && last.final === false && last.who === ev.who) lines.pop()
          lines.push({ who: ev.who, text: ev.text, at: Number.isFinite(ev.at) ? ev.at : Date.now(), final: ev.final !== false })
          linesRef.current = lines
          return { lines }
        })
      } else if (ev.type === 'tool') {
        update((s) => ({ tools: [...s.tools, { name: ev.name, ok: ev.ok !== false, simulated: Boolean(ev.simulated), error: ev.error || null, ms: ev.ms, at: Date.now() }].slice(-60) }))
      } else if (ev.type === 'metrics') {
        update((s) => {
          const metrics = { ...s.metrics, ...Object.fromEntries(Object.entries(ev).filter(([k, v]) => k !== 'type' && Number.isFinite(v))) }
          metricsRef.current = metrics
          return { metrics }
        })
      } else if (ev.type === 'error') {
        update(() => ({ error: `Adapter error: ${ev.code || 'unknown'}${ev.detail ? ` (${ev.detail})` : ''}` }))
        if (ev.fatal && sessionRef.current) finish()
      }
    },
    [finish],
  )

  const start = async () => {
    if (session.phase === 'live' || session.phase === 'starting') return
    finishingRef.current = false
    sentRef.current = 0
    sessionRef.current = null
    linesRef.current = []
    metricsRef.current = {}
    update(() => ({ phase: 'starting', connection: 'idle', lines: [], tools: [], metrics: {}, error: null, summary: null, connectionReason: null }))
    if (!adapterAvailable(provider)) return update(() => ({ phase: 'error', error: START_ERRORS.adapter_unavailable }))
    // Microphone first, inside the click: a blocked microphone is reported before any session or provider call exists.
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw Object.assign(new Error('no media devices'), { name: 'NotAllowedError' })
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      for (const t of stream.getTracks()) t.stop()
    } catch (err) {
      return update(() => ({ phase: 'error', error: START_ERRORS[err?.name === 'NotFoundError' ? 'no_mic' : 'mic'] }))
    }
    const settings = provider === 'openai' && voice ? { voice } : {}
    const { status: code, data } = await api('/api/platform/voice-lab/session', { method: 'POST', body: { action: 'start', provider, customer: business, dryRun, settings } })
    if (code !== 200) return update(() => ({ phase: 'error', error: START_ERRORS[code === 429 ? 'rate_limited' : data?.error] || `Couldn’t start (${data?.error || code}).` }))
    const s = data.session
    sessionRef.current = s
    let adapter
    try {
      adapter = await loadAdapter(provider)
    } catch {
      adapter = null
    }
    if (!adapter) {
      update(() => ({ error: START_ERRORS.adapter_unavailable }))
      return finish()
    }
    adapterRef.current = adapter
    setNow(Date.now())
    update(() => ({ phase: 'live', startedAt: s.startedAt, connection: 'connecting', dryRun: s.dryRun, provider: s.provider, business: s.customer }))
    try {
      await adapter.start({ customer: s.customer.id, id: s.id, token: s.token, onEvent })
    } catch (err) {
      update(() => ({ error: `Adapter error: ${err?.name || 'start_failed'}` }))
      finish()
    }
  }

  if (!status) return <Loading label="Loading the Voice Lab…" />
  if (status.error === 'off') {
    return (
      <div className="cc cc--single" data-voice-lab="off">
        <div className="cc-main">
          <PageHead title="Voice Lab" lede="Put the receptionist on a voice call through a provider, against a test business, and see what happened." />
          <div className="cc-callout" role="status">
            <strong>Voice Lab is switched off.</strong>
            <span>VOICE_LAB_ENABLED is not set to true on this deployment, so no session can be started and nothing is shown. Turning it on needs approval.</span>
          </div>
        </div>
      </div>
    )
  }
  if (status.error) return <LoadError what="the Voice Lab" onRetry={() => setReload((n) => n + 1)} />

  const p = status.providers[provider] || { configured: false }
  const budgetLeft = Math.max(0, status.limits.dailyMinutes - status.limits.usedMinutesToday)
  const live = session.phase === 'live' || session.phase === 'starting' || session.phase === 'ending'
  const blocker = !p.configured ? `Unavailable: ${REASON[p.reason] || 'not configured'}.` : !adapterAvailable(provider) ? START_ERRORS.adapter_unavailable : !business ? 'No admin-marked test business is active.' : budgetLeft === 0 ? START_ERRORS.lab_daily_limit : null
  const biz = status.businesses.find((b) => b.id === business)
  const m = session.summary?.metrics || session.metrics
  const est = status.estimates?.[provider]
  const duration = session.summary ? (session.summary.metrics?.durationSeconds ?? 0) * 1000 : session.startedAt && now ? Math.max(0, now - session.startedAt) : null
  return (
    <div className="cc cc--single" data-voice-lab={session.phase}>
      <div className="cc-main">
        <PageHead title="Voice Lab" lede="Put the same receptionist on a voice call through a provider, against an admin-marked test business, and see honestly what happened. Dry run creates nothing." />
        <Section title="Set up a test call" id="vl-setup" sub={`Daily budget: ${status.limits.usedMinutesToday} of ${status.limits.dailyMinutes} minutes used today (${budgetLeft} left).`} data-budget={budgetLeft}>
          <div className="cc-section-body">
            <fieldset className="vl-providers" disabled={live}>
              <legend className="cc-label">Provider</legend>
              {PROVIDERS.map(([id, name, what]) => {
                const st = status.providers[id] || { configured: false }
                return (
                  <label key={id} className={`vl-provider${provider === id ? ' vl-provider--on' : ''}`} data-provider={id} data-configured={st.configured ? 'true' : 'false'}>
                    <input type="radio" name="provider" value={id} checked={provider === id} onChange={() => setProvider(id)} />
                    <span className="vl-provider-name">{name}</span>
                    <Badge tone={st.configured ? 'ok' : 'neutral'}>{st.configured ? `Configured${st.model ? ` · ${st.model}` : ''}` : 'Not configured'}</Badge>
                    <span className="vl-provider-what">{st.configured ? what : `Unavailable: ${REASON[st.reason] || 'not configured'}.`}</span>
                    {!adapterAvailable(id) && <span className="vl-provider-what">Adapter unavailable in this build.</span>}
                  </label>
                )
              })}
            </fieldset>
            <div className="vl-controls">
              <label className="field">
                <span>Test business</span>
                <select data-lab-business value={business} onChange={(e) => setBusiness(e.target.value)} disabled={live}>
                  {status.businesses.length === 0 && <option value="">No active test business</option>}
                  {status.businesses.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name} ({b.id})
                    </option>
                  ))}
                </select>
              </label>
              {provider === 'openai' && status.settings?.openai?.voices && (
                <label className="field">
                  <span>Voice (OpenAI)</span>
                  <select data-lab-voice value={voice} onChange={(e) => setVoice(e.target.value)} disabled={live}>
                    <option value="">Default</option>
                    {status.settings.openai.voices.map((v) => (
                      <option key={v} value={v}>
                        {v}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <label className="check" data-dry-run={dryRun ? 'on' : 'off'}>
                <input type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} disabled={live} />
                <span>Dry run: every guard runs, nothing is created (no lead, appointment, request or email).</span>
              </label>
              {!dryRun && (
                <div className="cc-callout cc-callout--warn" role="alert" data-dry-run-warning>
                  <strong>Dry run is off.</strong>
                  <span>A confirmed booking in this call creates a REAL appointment on {biz?.name || 'the test business'}’s calendar and sends its confirmation. Test businesses only; messages still obey the launch gate.</span>
                </div>
              )}
              <p className="cc-status-line" data-cost-note={provider}>
                {COST[provider]} Limits: one Lab call at a time, 15 minutes per session, {status.limits.dailyMinutes} minutes per day across the Lab. Stop ends the call at once.
              </p>
            </div>
            <div className="cc-actions">
              {live ? (
                <button type="button" className="btn btn-danger btn-sm" onClick={finish} disabled={session.phase !== 'live'} data-lab-stop>
                  {session.phase === 'ending' ? 'Ending…' : 'Stop conversation'}
                </button>
              ) : (
                <button type="button" className="btn btn-primary btn-sm" onClick={start} disabled={Boolean(blocker)} data-lab-start>
                  Start conversation
                </button>
              )}
              {blocker && !live && (
                <span className="cc-status-line" data-lab-blocker>
                  {blocker}
                </span>
              )}
            </div>
            {session.error && (
              <p className="form-error" role="alert" data-lab-error>
                {session.error}
              </p>
            )}
          </div>
        </Section>
        <Readiness r={(status.readiness || []).find((x) => x.id === provider)} />

        {(live || session.phase === 'done') && (
          <Section title={session.phase === 'done' ? 'Session summary' : 'Live call'} id="vl-live" data-lab-live={session.phase}>
            <div className="cc-section-body">
              <div className="cc-actions">
                <Badge tone={CONNECTION[session.connection]?.[0] || 'neutral'}>{CONNECTION[session.connection]?.[1] || session.connection}</Badge>
                {session.connectionReason && <span className="cc-status-line">{String(session.connectionReason).replaceAll('_', ' ')}</span>}
                <Badge tone="info" plain>
                  {PROVIDERS.find(([id]) => id === (session.provider || provider))?.[1]}
                </Badge>
                <Badge tone={session.dryRun === false ? 'warn' : 'neutral'} plain>
                  {session.dryRun === false ? 'LIVE booking' : 'Dry run'}
                </Badge>
                <span className="cc-status-line" data-lab-duration>
                  {duration == null ? '—' : mins(duration)}
                </span>
              </div>
              <Facts
                items={[
                  ['First response', ms(m.firstResponseMs)],
                  ['Median response', ms(m.medianResponseMs)],
                  ['p95 response', ms(m.p95ResponseMs)],
                  ['Turns', m.turns ?? '—'],
                  ['Interruptions', m.interruptions ?? '—'],
                  ['Tool calls', `${m.toolCalls ?? session.tools.length}${m.toolFailures ? ` (${m.toolFailures} failed)` : ''}`],
                  ['Reconnects', m.reconnects ?? '—'],
                  ['Usage', [m.audioSeconds != null && `${m.audioSeconds} s audio`, m.inputTokens != null && `${m.inputTokens} in`, m.outputTokens != null && `${m.outputTokens} out tokens`].filter(Boolean).join(' · ') || 'not reported'],
                  session.summary && ['Estimated cost', session.summary.estimatedMicros == null ? 'Not estimated' : `${usd(session.summary.estimatedMicros)} (estimate${est?.source ? `, ${est.source}` : ''}${est?.asOf ? ` as of ${est.asOf}` : ''})`],
                  session.summary && ['Outcome', outcomeLabel(session.summary)],
                ]}
              />
              <p className="cc-status-line">Latency figures are what the adapter measured in this browser (speech end to first reply audio). They are not engine-side timings.</p>
              <h3 className="cc-label">Transcript</h3>
              {session.lines.length ? (
                <ol className="vl-transcript" data-lab-transcript>
                  {session.lines.map((l, i) => (
                    <li key={i} className={`vl-line vl-line--${l.who}${l.final ? '' : ' vl-line--interim'}`}>
                      <span className="vl-who">{l.who === 'customer' ? 'Caller' : 'Receptionist'}</span>
                      <span>{l.text}</span>
                    </li>
                  ))}
                </ol>
              ) : (
                <Empty title={live ? 'Nothing said yet.' : 'No transcript was reported.'} />
              )}
              <h3 className="cc-label">Tool results</h3>
              {session.tools.length || session.summary?.tools?.length ? (
                <ul className="vl-tools" data-lab-tools>
                  {(session.tools.length ? session.tools : session.summary.tools).map((t, i) => (
                    <li key={i}>
                      <code className="cc-code">{t.name}</code>
                      <Badge tone={t.ok === false ? 'bad' : 'ok'}>{t.ok === false ? t.error || 'error' : 'ok'}</Badge>
                      {t.simulated && <Badge tone="neutral" plain>simulated</Badge>}
                      {Number.isFinite(t.ms) && <span className="cc-status-line">{ms(t.ms)}</span>}
                    </li>
                  ))}
                </ul>
              ) : (
                <Empty title="No tool has run." />
              )}
            </div>
          </Section>
        )}

        <Section title="Recent sessions" id="vl-sessions" sub="The last Lab sessions on test businesses: codes, counts and timings only." data-lab-sessions>
          {status.sessions.length ? (
            <ul className="cc-list">
              {status.sessions.map((s) => {
                const name = status.businesses.find((b) => b.id === s.customer)?.name || s.customer
                return (
                  <li key={s.id}>
                    <div className="cc-item">
                      <span className="cc-item-main">
                        <span className="cc-item-title">
                          {PROVIDERS.find(([id]) => id === s.provider)?.[1] || s.provider} · {name}
                        </span>
                        <span className="cc-item-sub">
                          {outcomeLabel(s)} · {s.metrics?.durationSeconds != null ? mins(s.metrics.durationSeconds * 1000) : 'in progress'} · {s.metrics?.firstResponseMs != null ? `first reply ${ms(s.metrics.firstResponseMs)}` : 'no latency reported'}
                          {s.metrics?.turns != null ? ` · ${s.metrics.turns} turns` : ''} · {s.startedAt ? ago(s.startedAt) : ''}
                        </span>
                      </span>
                      <span className="cc-item-meta">
                        <Badge tone={s.dryRun ? 'neutral' : 'warn'} plain>
                          {s.dryRun ? 'Dry run' : 'Live'}
                        </Badge>
                        {s.booked && <Badge tone="ok">{s.simulated ? 'Booked (simulated)' : 'Booked'}</Badge>}
                      </span>
                    </div>
                  </li>
                )
              })}
            </ul>
          ) : (
            <Empty title="No Lab session yet.">Sessions appear here once a call has been started.</Empty>
          )}
        </Section>
      </div>
    </div>
  )
}
