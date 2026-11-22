import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../lib/api.js'
import { Pill, Section } from './ui.jsx'

// How the receptionist sounds (owner) + the admin-only provider control. The owner sees voices, a personality and a
// pace; never a provider name or a model. Previews are the voice library's own samples (clearly labelled), played one
// at a time; nothing here starts a real call, books anything or messages anyone.
const traits = (v) => [v?.gender, v?.accent, v?.age, v?.language && v.language !== 'en' ? v.language : null].filter(Boolean)
const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : '')

function usePreview() {
  const audio = useRef(null)
  const [playing, setPlaying] = useState(null)
  const stop = useCallback(() => {
    if (audio.current) {
      audio.current.pause()
      audio.current.src = ''
      audio.current = null
    }
    setPlaying(null)
  }, [])
  const play = useCallback(
    (id, url) => {
      if (playing === id) return stop()
      stop()
      if (!url) return
      const a = new Audio(url)
      audio.current = a
      setPlaying(id)
      a.onended = () => setPlaying((p) => (p === id ? null : p))
      a.onerror = () => setPlaying((p) => (p === id ? null : p))
      a.play().catch(() => setPlaying((p) => (p === id ? null : p)))
    },
    [playing, stop],
  )
  useEffect(() => stop, [stop])
  return { playing, play, stop }
}

function PreviewButton({ voice, playing, onPlay }) {
  if (!voice?.preview)
    return (
      <span className="fine" aria-label={`No preview for ${voice?.name || 'this voice'}`}>
        No preview
      </span>
    )
  const on = playing === voice.id
  return (
    <button type="button" className="btn btn-quiet btn-sm" aria-pressed={on} aria-label={`${on ? 'Stop' : 'Preview'} ${voice.name}`} onClick={() => onPlay(voice.id, voice.preview)}>
      {on ? '■ Stop' : '▶ Preview'}
    </button>
  )
}

export default function ReceptionistVoice({ voice, admin, providers, reload }) {
  const [form, setForm] = useState({ voiceId: voice.voiceId, personality: voice.personality, pace: voice.pace })
  const [catalog, setCatalog] = useState(null)
  const [choosing, setChoosing] = useState(false)
  const [filter, setFilter] = useState({ gender: '', accent: '', q: '' })
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const { playing, play, stop } = usePreview()
  const saved = { voiceId: voice.voiceId, personality: voice.personality, pace: voice.pace }
  const dirty = JSON.stringify(form) !== JSON.stringify(saved)
  // A new saved version (own save, or changed elsewhere and reloaded) resets the form to the saved values; the
  // status message stays, so "Saved." is read after the reload.
  const [seen, setSeen] = useState(voice.version)
  if (seen !== voice.version) {
    setSeen(voice.version)
    setForm(saved)
  }
  useEffect(() => {
    if (!voice.capabilities.voiceChoice) return
    api('/api/dashboard/receptionist/voices').then(({ status, data }) => setCatalog(status === 200 ? data : { voices: [], error: data?.error || 'unavailable' }))
  }, [voice.capabilities.voiceChoice])
  const voices = useMemo(() => catalog?.voices || [], [catalog])
  const current = voices.find((v) => v.id === form.voiceId) || (form.voiceId ? { id: form.voiceId, name: voice.voiceName || 'Chosen voice', preview: null } : null)
  const genders = useMemo(() => [...new Set(voices.map((v) => v.gender).filter(Boolean))], [voices])
  const accents = useMemo(() => [...new Set(voices.map((v) => v.accent).filter(Boolean))].sort(), [voices])
  const q = filter.q.trim().toLowerCase()
  const shown = voices.filter((v) => (!filter.gender || v.gender === filter.gender) && (!filter.accent || v.accent === filter.accent) && (!q || v.name.toLowerCase().includes(q)))
  const save = async (e) => {
    e.preventDefault()
    setMsg('')
    setBusy(true)
    stop()
    const { status, data } = await api('/api/dashboard/receptionist', { method: 'POST', body: { action: 'voice', ...form, version: voice.version } })
    setBusy(false)
    if (status === 200) {
      setMsg('Saved. New calls use this from now on.')
      setChoosing(false)
      reload()
    } else if (status === 409 && data?.error === 'stale') {
      setMsg('These settings were changed elsewhere; showing the latest.')
      reload()
    } else setMsg(data?.error === 'voice_unknown' ? 'That voice isn’t available any more. Pick another.' : data?.error === 'catalog_unavailable' ? 'The voice list couldn’t be checked right now. Try again shortly.' : data?.error === 'pace_unsupported' ? 'Pace isn’t adjustable for this voice.' : 'Couldn’t save. Please try again.')
  }
  const cancel = () => {
    setForm(saved)
    setChoosing(false)
    stop()
    setMsg('')
  }
  return (
    <Section title="Receptionist voice" label="Receptionist voice" id="receptionist-voice">
      <form className="ui-settings" onSubmit={save} aria-label="Receptionist voice settings">
        <fieldset className="ui-group">
          <legend>Voice</legend>
          <div className="rx-voice-current" data-current-voice>
            <div>
              <strong>{current ? current.name : 'Standard voice'}</strong>
              <span className="ui-hint">{current ? traits(current).map(cap).join(' · ') || 'Voice from your receptionist’s voice library.' : 'The receptionist’s standard voice. Pick one below to make it yours.'}</span>
            </div>
            <div className="rx-voice-actions">
              {current && <PreviewButton voice={current} playing={playing} onPlay={play} />}
              {voice.capabilities.voiceChoice && (
                <button type="button" className="btn btn-sm btn-quiet" aria-expanded={choosing} onClick={() => setChoosing((c) => !c)}>
                  {choosing ? 'Hide voices' : 'Change voice'}
                </button>
              )}
            </div>
          </div>
          {!voice.capabilities.voiceChoice && <p className="ui-hint">Voice choice isn’t available on your account yet.</p>}
          {choosing && (
            <div className="rx-voice-picker" role="group" aria-label="Available voices">
              {catalog === null && <div className="ui-skeleton-block" aria-busy="true" />}
              {catalog?.error && !voices.length && <p className="ui-callout ui-callout--warn">The voice list couldn’t be loaded right now. Your current voice keeps working.</p>}
              {(genders.length > 1 || accents.length > 1) && (
                <div className="fchips" role="group" aria-label="Filter voices">
                  {genders.length > 1 &&
                    ['', ...genders].map((g) => (
                      <button key={`g${g}`} type="button" className="fchip" aria-pressed={filter.gender === g} onClick={() => setFilter({ ...filter, gender: g })}>
                        {g ? cap(g) : 'Any'}
                      </button>
                    ))}
                  {accents.length > 1 && (
                    <select aria-label="Accent" value={filter.accent} onChange={(e) => setFilter({ ...filter, accent: e.target.value })}>
                      <option value="">Any accent</option>
                      {accents.map((a) => (
                        <option key={a} value={a}>
                          {cap(a)}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
              )}
              <label className="field">
                <span className="sr-only">Search voices by name</span>
                <input type="search" value={filter.q} onChange={(e) => setFilter({ ...filter, q: e.target.value })} placeholder={`Search ${voices.length} voices by name`} aria-label="Search voices by name" />
              </label>
              <p className="fine">Previews are samples from the voice library, not your receptionist. Your greeting, answers and bookings don’t change with the voice.</p>
              <ul className="rx-voice-list">
                <li className="rx-voice-row">
                  <label className="check">
                    <input type="radio" name="voice" checked={!form.voiceId} onChange={() => setForm({ ...form, voiceId: null })} />
                    <span>
                      <strong>Standard voice</strong> <span className="ui-hint">The receptionist’s default.</span>
                    </span>
                  </label>
                </li>
                {shown.map((v) => (
                  <li key={v.id} className="rx-voice-row">
                    <label className="check">
                      <input type="radio" name="voice" checked={form.voiceId === v.id} onChange={() => setForm({ ...form, voiceId: v.id })} />
                      <span>
                        <strong>{v.name}</strong> {traits(v).length > 0 && <span className="ui-hint">{traits(v).map(cap).join(' · ')}</span>}
                        {v.description && <span className="ui-hint">{v.description}</span>}
                      </span>
                    </label>
                    <PreviewButton voice={v} playing={playing} onPlay={play} />
                  </li>
                ))}
                {catalog && !shown.length && voices.length > 0 && <li className="fine">No voices match those filters.</li>}
              </ul>
            </div>
          )}
        </fieldset>
        <fieldset className="ui-group">
          <legend>Personality</legend>
          <p className="ui-hint">How it comes across. Your prices, service area and booking rules never change with the personality.</p>
          <div className="rx-choice-grid" role="radiogroup" aria-label="Personality">
            {voice.personalities.map((p) => (
              <label key={p.id} className={`rx-choice${form.personality === p.id ? ' rx-choice--on' : ''}`}>
                <input type="radio" name="personality" checked={form.personality === p.id} onChange={() => setForm({ ...form, personality: p.id })} />
                <strong>{p.name}</strong>
                <span className="ui-hint">{p.blurb}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset className="ui-group">
          <legend>Speaking pace</legend>
          {voice.capabilities.pace ? (
            <div className="fchips" role="radiogroup" aria-label="Speaking pace">
              {voice.paces.map((p) => (
                <button key={p.id} type="button" className="fchip" role="radio" aria-checked={form.pace === p.id} onClick={() => setForm({ ...form, pace: p.id })}>
                  {p.name}
                </button>
              ))}
            </div>
          ) : (
            <p className="ui-hint">Pace isn’t adjustable for your current voice; it speaks at its natural pace.</p>
          )}
          <p className="ui-hint">Language: English{voice.capabilities.languages.length > 1 ? '' : ' (more languages aren’t available yet)'}.</p>
        </fieldset>
        <div className="ui-form-actions">
          <button type="submit" className="btn btn-primary btn-sm" disabled={busy || !dirty}>
            {busy ? 'Saving…' : 'Save voice'}
          </button>
          {dirty && (
            <button type="button" className="btn btn-quiet btn-sm" onClick={cancel} disabled={busy}>
              Cancel
            </button>
          )}
          <span className="fine" role="status">
            {msg || (dirty ? 'Unsaved changes' : '')}
          </span>
        </div>
      </form>
      {admin && providers && <ProviderControl providers={providers} reload={reload} />}
    </Section>
  )
}

// Admin only (the server checks the platform-admin list; this never renders for owners). Switching is checked,
// explained, confirmed, audited and reversible; test-only providers are shown as such and cannot be activated.
const SESSIONS = { customers: ['ok', 'Customers'], lab_only: ['neutral', 'Voice Lab only'], none: ['neutral', 'None'] }
const BLOCKER = {
  not_configured: 'not configured',
  test_only: 'test only (no customer path)',
  business_not_eligible: 'business not eligible',
  tools_missing: 'tools missing',
  voice_replacement_required: 'a voice must be chosen',
  booking_not_ready: 'booking not ready',
  test_session_required: 'no finished test session',
  no_change: 'nothing would change',
  voice_unknown: 'voice not in the catalog',
  catalog_unavailable: 'voice list unavailable',
  invalid_voice_id: 'invalid voice',
  provider_not_configured: 'provider not configured',
}
function ProviderControl({ providers, reload }) {
  const [target, setTarget] = useState('')
  const [voiceId, setVoiceId] = useState('')
  const [useDefault, setUseDefault] = useState(false)
  const [catalog, setCatalog] = useState(null)
  const [check, setCheck] = useState(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const current = providers.providers.find((p) => p.id === providers.current)
  const pick = (next) => {
    setTarget(next)
    setCheck(null)
    setVoiceId('')
    setCatalog(null)
    if (next) api(`/api/dashboard/receptionist/voices?provider=${encodeURIComponent(next)}`).then(({ status, data }) => setCatalog(status === 200 ? data : { voices: [] }))
  }
  const post = async (body) => {
    setBusy(true)
    setMsg('')
    const r = await api('/api/dashboard/receptionist', { method: 'POST', body })
    setBusy(false)
    return r
  }
  const run = async () => {
    const { status, data } = await post({ action: 'provider_check', provider: target, voiceId, useDefaultVoice: useDefault })
    setCheck(status === 200 ? data.check : null)
    if (status !== 200) setMsg(`Couldn’t check (${data?.error || status}).`)
  }
  const doSwitch = async () => {
    if (!check?.ok) return
    if (!window.confirm(`Switch this business to ${check.provider}?\n\n${check.consequences.join('\n')}`)) return
    const { status, data } = await post({ action: 'provider_switch', provider: target, voiceId, useDefaultVoice: useDefault, confirm: true, version: providers.version })
    if (status === 200) {
      setMsg('Switched. New calls use the new provider; the previous one is kept for rollback.')
      setTarget('')
      reload()
    } else {
      setMsg(data?.error === 'stale' ? 'Changed elsewhere; reloaded.' : data?.error === 'blocked' ? 'Blocked by a prerequisite; see the checklist.' : `Not switched (${data?.error || status}).`)
      if (data?.check) setCheck(data.check)
      if (data?.error === 'stale') reload()
    }
  }
  const rollback = async () => {
    if (!providers.previous) return
    if (!window.confirm(`Roll back to ${providers.previous.provider}${providers.previous.voiceName ? ` with voice "${providers.previous.voiceName}"` : ''}?`)) return
    const { status, data } = await post({ action: 'provider_rollback', confirm: true, version: providers.version })
    setMsg(status === 200 ? 'Rolled back.' : `Not rolled back (${data?.error || status}).`)
    if (status === 200 || data?.error === 'stale') reload()
  }
  return (
    <details className="ui-group ui-group--advanced rx-provider" data-provider-control>
      <summary>
        AI voice provider (admin) <Pill tone="neutral">{current?.name || providers.current}</Pill>
      </summary>
      <p className="ui-hint">Owners never see this. Only providers with a customer-facing path can be activated; the others run in the Voice Lab only. No provider has phone routing here.</p>
      <table className="rx-provider-table">
        <thead>
          <tr>
            <th scope="col">Provider</th>
            <th scope="col">Configured</th>
            <th scope="col">Browser sessions</th>
            <th scope="col">Phone calls</th>
            <th scope="col">Tested here</th>
            <th scope="col">Blockers</th>
          </tr>
        </thead>
        <tbody>
          {providers.providers.map((p) => (
            <tr key={p.id} aria-current={p.id === providers.current || undefined}>
              <th scope="row">
                {p.name} {p.id === providers.current && <Pill tone="ok">Active</Pill>}
              </th>
              <td>
                <Pill tone={p.configured ? 'ok' : 'neutral'}>{p.configured ? 'Yes' : 'No'}</Pill>
              </td>
              <td>
                <Pill tone={SESSIONS[p.browserSessions][0]}>{SESSIONS[p.browserSessions][1]}</Pill> {!p.liveCapable && <Pill tone="warn">Test only</Pill>}
              </td>
              <td>
                <Pill tone="neutral">{p.phone ? 'Supported' : 'Not supported'}</Pill>
              </td>
              <td>{p.tested ? 'Yes' : 'No'}</td>
              <td className="fine">{p.blockers.map((b) => BLOCKER[b] || b).join(', ') || '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="rx-provider-switch">
        <label className="field">
          <span>Switch to</span>
          <select value={target} onChange={(e) => pick(e.target.value)} aria-label="Provider to switch to">
            <option value="">Choose a provider…</option>
            {providers.providers
              .filter((p) => p.id !== providers.current)
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {p.liveCapable ? '' : ' (test only)'}
                </option>
              ))}
          </select>
        </label>
        {target && (
          <>
            <label className="field">
              <span>Voice on the new provider</span>
              <select value={voiceId} onChange={(e) => setVoiceId(e.target.value)} disabled={useDefault} aria-label="Replacement voice">
                <option value="">{catalog ? 'Choose a voice…' : 'Loading…'}</option>
                {(catalog?.voices || []).map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name}
                    {traits(v).length ? ` (${traits(v).join(', ')})` : ''}
                  </option>
                ))}
              </select>
            </label>
            <label className="check">
              <input type="checkbox" checked={useDefault} onChange={(e) => setUseDefault(e.target.checked)} />
              <span>Use the provider’s default voice (explicit; a voice is never substituted silently)</span>
            </label>
            <div className="ui-form-actions">
              <button type="button" className="btn btn-quiet btn-sm" onClick={run} disabled={busy}>
                Check prerequisites
              </button>
              <button type="button" className="btn btn-primary btn-sm" onClick={doSwitch} disabled={busy || !check?.ok}>
                Switch provider…
              </button>
            </div>
          </>
        )}
        {check && (
          <div className="rx-check" aria-label="Switching checklist">
            <ul>
              {check.checks.map((c) => (
                <li key={c.id} className={c.ok ? '' : 'ui-step--miss'}>
                  <Pill tone={c.ok ? 'ok' : 'bad'}>{c.ok ? 'OK' : 'Blocked'}</Pill> {c.note}
                </li>
              ))}
            </ul>
            <p className="fine">
              <strong>What switching does:</strong>
            </p>
            <ul className="fine">
              {check.consequences.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          </div>
        )}
        {providers.previous && (
          <p className="fine">
            Previous: {providers.previous.provider}
            {providers.previous.voiceName ? ` · ${providers.previous.voiceName}` : ''}.{' '}
            <button type="button" className="link-btn" onClick={rollback} disabled={busy}>
              Roll back
            </button>
          </p>
        )}
        <span className="fine" role="status">
          {msg}
        </span>
      </div>
    </details>
  )
}
