// /admin/voice-providers — voice-provider management for ANY business (platform admins; every request is authorized
// server-side, membership of the business is not needed). Pick a business → see its active provider, readiness,
// test history and blockers → the same Select → Test now → Review → Activate → Rollback control the dashboard shows,
// with the business named on every step and its id typed back before anything changes. Codes, counts and times only:
// no transcripts, no customer details.
import { useEffect, useState } from 'react'
import { api } from '../lib/api.js'
import { Badge, Empty, Facts, LoadError, Loading, PageHead, Section } from './control/ui.jsx'
import { when, mins } from './control/lib.js'
import ProviderControl from '../dashboard/ProviderControl.jsx'
import { consoleOps, STATE } from '../dashboard/provider-control.js'
import './control.css'
import './voice-providers.css'

const KIND = { test: 'Admin test (customer path)', lab: 'Voice Lab', customer: 'Customer' }
const usd = (micros) => (micros == null ? '—' : `$${(micros / 1e6).toFixed(micros < 100_000 ? 4 : 2)}`)
const fromUrl = () => new URLSearchParams(window.location.search).get('customer') || ''

export default function VoiceProviders() {
  const [list, setList] = useState(null)
  const [selected, setSelected] = useState(fromUrl)
  const [loaded, setLoaded] = useState(null) // { id, tick, data } for the business last answered by the server
  const [tick, setTick] = useState(0)
  // The view shown is the loaded one for the CURRENT selection only (a switch of business shows "Loading…", never
  // the previous business's data).
  const view = loaded && loaded.id === selected ? loaded.data : null

  useEffect(() => {
    document.title = 'Voice providers · GetShowUps'
  }, [])
  useEffect(() => {
    let live = true
    api('/api/platform/voice-provider').then(({ status, data }) => live && setList(status === 200 ? data.businesses : { error: data?.error || status }))
    return () => {
      live = false
    }
  }, [tick])
  useEffect(() => {
    if (!selected) return undefined
    let live = true
    api(`/api/platform/voice-provider?customer=${encodeURIComponent(selected)}`).then(({ status, data }) => live && setLoaded({ id: selected, data: status === 200 ? data : { error: data?.error || status } }))
    return () => {
      live = false
    }
  }, [selected, tick])
  useEffect(() => {
    const onPop = () => setSelected(fromUrl())
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  const choose = (id) => {
    const url = new URL(window.location.href)
    if (id) url.searchParams.set('customer', id)
    else url.searchParams.delete('customer')
    window.history.pushState(null, '', url.pathname + url.search)
    setSelected(id)
  }
  const reload = () => setTick((n) => n + 1)
  const businesses = Array.isArray(list) ? list : []
  const b = view?.business
  return (
    <div className="cc cc--single" data-voice-providers={b ? b.id : 'none'}>
      <div className="cc-main">
        <PageHead title="Voice providers" lede="Manage the AI receptionist's voice provider for any business: active provider, readiness, test history and blockers; then Test → Review → Activate → Rollback. Every change names the business and is checked, confirmed, audited and reversible." />
        <Section title="Business" id="vp-business" sub="Platform admins only. Nothing on this page changes a business until the Activate or Roll back step is confirmed with the business id.">
          <div className="cc-section-body">
            {list === null && <Loading label="Loading businesses…" />}
            {list?.error && <LoadError what="the business list" onRetry={reload} />}
            {Array.isArray(list) && (
              <label className="field">
                <span>Select a business</span>
                <select value={selected} onChange={(e) => choose(e.target.value)} aria-label="Business" data-vp-business>
                  <option value="">Choose a business…</option>
                  {businesses.map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.name} ({x.id}){x.test ? ' · test' : ''} · {x.providerName}
                      {x.receptionist ? '' : ' · receptionist off'}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {selected && view === null && <Loading label="Loading the business…" />}
            {view?.error && <LoadError what="this business" onRetry={reload} />}
            {b && (
              <div className="vp-selected" data-vp-selected={b.id}>
                <h3 className="vp-selected-name">
                  {b.name} <code>{b.id}</code>{' '}
                  {b.testUnreadable ? <Badge tone="bad">Test mark unreadable: treated as live</Badge> : <Badge tone={b.test ? 'warn' : 'bad'}>{b.test ? 'Test business' : 'Live business: real customers'}</Badge>}
                  {b.status !== 'active' && <Badge tone="bad">{b.status}</Badge>}
                </h3>
                <Facts
                  items={[
                    ['Active provider', view.voice.providerName],
                    ['Voice', view.voice.voiceName || 'Provider default'],
                    ['Personality', view.voice.personality],
                    ['Pace', view.voice.pace],
                    ['Receptionist', b.receptionist ? 'On' : 'Off (customers cannot start a session)'],
                    ['Booking hours', b.hoursConfirmed ? 'Confirmed' : 'Not confirmed'],
                    ['Voice settings', view.ready ? `Stored (version ${view.voice.version})` : 'Not available (migration 0035 not applied)'],
                    ['Phone routing', 'None (no provider has it)'],
                  ]}
                />
              </div>
            )}
          </div>
        </Section>
        {b && (
          <Section title="Provider" id="vp-provider" sub={`Readiness and blockers for ${b.name}. “Ready” needs a finished test session on this business with audio both ways and the booking tools.`}>
            <div className="cc-section-body">
              <ul className="vp-states" aria-label="Provider readiness">
                {view.providers.providers.map((p) => (
                  <li key={p.id} data-vp-state={p.id}>
                    <strong>{p.name}</strong> <Badge tone={(STATE[p.state] || STATE.not_configured)[0]}>{(STATE[p.state] || STATE.not_configured)[1]}</Badge>
                    {p.blockers.length > 0 && <span className="fine"> Blockers: {p.blockers.join(', ')}</span>}
                    {p.testUrl && (
                      <span className="fine">
                        {' '}
                        Test page: <code>{p.testUrl}</code>
                      </span>
                    )}
                  </li>
                ))}
              </ul>
              {!b.test && <p className="cc-callout">This is not a test business: test sessions on the customer path are refused for it. Verified evidence comes from the Voice Lab or a test business.</p>}
              <ProviderControl key={b.id} providers={view.providers} reload={reload} ops={consoleOps(b.id)} business={{ id: b.id, name: b.name, test: b.test && !b.testUnreadable }} open />
            </div>
          </Section>
        )}
        {b && (
          <Section title="Test history" id="vp-history" sub="Voice sessions of this business, newest first (admin tests, Lab sessions, customer sessions). Codes and measurements only; nothing said in them is shown here.">
            <div className="cc-section-body">
              {view.history.length === 0 ? (
                <Empty title="No voice sessions yet.">Run a test session (Test now on a test business, or the Voice Lab) to collect evidence.</Empty>
              ) : (
                <table className="vp-history" data-vp-history>
                  <thead>
                    <tr>
                      <th scope="col">When</th>
                      <th scope="col">Provider</th>
                      <th scope="col">Kind</th>
                      <th scope="col">Length</th>
                      <th scope="col">Audio both ways</th>
                      <th scope="col">Tools</th>
                      <th scope="col">Outcome</th>
                      <th scope="col">Est. cost</th>
                      <th scope="col">Evidence</th>
                    </tr>
                  </thead>
                  <tbody>
                    {view.history.map((h) => (
                      <tr key={h.id} data-vp-session={h.provider}>
                        <td>{when(h.startedAt)}</td>
                        <td>{view.providers.providers.find((p) => p.id === h.provider)?.name || h.provider}</td>
                        <td>
                          {KIND[h.kind] || h.kind}
                          {h.dryRun ? ' · dry run' : ''}
                        </td>
                        <td>{h.endedAt ? mins(h.endedAt - h.startedAt) : h.inProgress ? 'In progress' : 'Not closed'}</td>
                        <td>{h.audio.micLive && h.audio.audioReceived ? 'Yes' : `No (${[h.audio.micLive ? 'mic live' : 'mic not heard', h.audio.audioReceived ? 'audio received' : 'no audio received'].join(', ')})`}</td>
                        <td>{[h.tools.availability ? 'availability ✓' : 'availability ✗', h.tools.booking ? 'booking ✓' : 'booking ✗'].join(' · ')}</td>
                        <td>{h.booked ? (h.simulated ? 'Booked (simulated)' : 'Booked') : h.outcome || '—'}</td>
                        <td>{usd(h.estimatedMicros)}</td>
                        <td>
                          <Badge tone={h.evidence ? 'ok' : 'neutral'}>{h.evidence ? 'Counts' : 'No'}</Badge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </Section>
        )}
      </div>
    </div>
  )
}
