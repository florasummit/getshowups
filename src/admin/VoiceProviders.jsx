// /admin/voice-providers — the AI receptionist's voice provider, platform-wide and per business (platform admins only;
// every request is authorized server-side, membership of a business is never needed).
//   Global voice provider: the provider, its rollout state and the one next action (GlobalProvider.jsx).
//   Businesses: a compact table (name, provider, follows the default or business-specific, readiness) → Manage opens
//   one business: its settings, the per-business control (ProviderControl.jsx: Select → Test → Review → Activate,
//   typed) and, under disclosure, the session history as codes and counts.
//   Rollout monitoring: after a promotion (records only), with rollback.
// Codes, counts and times only: no transcripts, no customer details.
import { useEffect, useState } from 'react'
import { api } from '../lib/api.js'
import { Badge, Empty, Facts, LoadError, Loading, PageHead, Section } from './control/ui.jsx'
import { when, mins } from './control/lib.js'
import ProviderControl from '../dashboard/ProviderControl.jsx'
import { consoleOps, STATE } from '../dashboard/provider-control.js'
import GlobalProvider from './GlobalProvider.jsx'
import './control.css'
import './voice-providers.css'

const KIND = { test: 'Admin test', lab: 'Voice Lab', customer: 'Customer' }
const SETTINGS = { inherited: 'Follows the default', pin: 'Still on the previous provider', override: 'Business-specific' }
const usd = (micros) => (micros == null ? '—' : `$${(micros / 1e6).toFixed(micros < 100_000 ? 4 : 2)}`)
const fromUrl = () => new URLSearchParams(window.location.search).get('customer') || ''

export default function VoiceProviders() {
  const [list, setList] = useState(null)
  const [global, setGlobal] = useState(null)
  const [selected, setSelected] = useState(fromUrl)
  const [loaded, setLoaded] = useState(null) // { id, data } for the business last answered by the server
  const [tick, setTick] = useState(0)
  // The view shown is the loaded one for the CURRENT selection only (a switch of business shows "Loading…", never
  // the previous business's data).
  const view = loaded && loaded.id === selected ? loaded.data : null

  useEffect(() => {
    document.title = 'Voice providers · GetShowUps'
  }, [])
  useEffect(() => {
    let live = true
    api('/api/platform/voice-provider').then(({ status, data }) => {
      if (!live) return
      setList(status === 200 ? data.businesses : { error: data?.error || status })
      setGlobal(status === 200 ? data.global : { error: data?.error || status })
    })
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
  const businessesSection = (
    <Section title="Businesses" id="vp-business">
      <div className="cc-section-body">
        {list === null && <Loading label="Loading businesses…" />}
        {list?.error && <LoadError what="the business list" onRetry={reload} />}
        {Array.isArray(list) && businesses.length === 0 && <Empty title="No businesses yet." />}
        {businesses.length > 0 && (
          <table className="vp-history vp-table" data-vp-businesses>
            <thead>
              <tr>
                <th scope="col">Business</th>
                <th scope="col">Provider</th>
                <th scope="col">Settings</th>
                <th scope="col">Readiness</th>
                <th scope="col">
                  <span className="sr-only">Action</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {businesses.map((x) => (
                <tr key={x.id} data-vp-row={x.id} aria-current={x.id === selected || undefined}>
                  <td>
                    {x.name} {x.test ? <Badge tone="neutral">Test</Badge> : null}
                    {x.status !== 'active' ? <Badge tone="bad">{x.status}</Badge> : null}
                  </td>
                  <td>{x.providerName}</td>
                  <td className="fine">{SETTINGS[global?.kinds?.[x.id]] || (x.inherited ? SETTINGS.inherited : SETTINGS.override)}</td>
                  <td>
                    <Badge tone={x.receptionist ? 'ok' : 'neutral'}>{x.receptionist ? 'Receptionist on' : 'Receptionist off'}</Badge>
                  </td>
                  <td>
                    <button type="button" className="btn btn-quiet btn-sm" onClick={() => choose(x.id === selected ? '' : x.id)} aria-pressed={x.id === selected} data-vp-manage={x.id}>
                      {x.id === selected ? 'Close' : 'Manage'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
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
                ['Provider', `${view.voice.providerName} (${view.voice.inherited ? 'follows the default' : 'business-specific'})`],
                ['Voice', `${view.voice.voiceName || 'Provider default'} · ${view.voice.personality} · ${view.voice.pace}`],
                ['Receptionist', b.receptionist ? 'On' : 'Off for customers'],
                ['Booking hours', b.hoursConfirmed ? 'Confirmed' : 'Not confirmed'],
                ['Phone routing', 'None (no provider has it)'],
              ]}
            />
            <ul className="vp-states" aria-label="Provider readiness">
              {view.providers.providers.map((p) => (
                <li key={p.id} data-vp-state={p.id}>
                  <strong>{p.name}</strong> <Badge tone={(STATE[p.state] || STATE.not_configured)[0]}>{(STATE[p.state] || STATE.not_configured)[1]}</Badge>
                  {p.blockers.length > 0 && <span className="fine">{p.blockers.join(', ')}</span>}
                </li>
              ))}
            </ul>
            {!b.test && <p className="fine">Not a test business: test sessions on the customer path are refused for it. Evidence comes from a test business or the Voice Lab.</p>}
            <ProviderControl key={b.id} providers={view.providers} reload={reload} ops={consoleOps(b.id)} business={{ id: b.id, name: b.name, test: b.test && !b.testUnreadable }} open />
            <details className="cc-details" data-vp-history-details>
              <summary>Session history ({view.history.length})</summary>
              <p className="fine">Newest first; admin tests, Lab and customer sessions. Codes and measurements only. {view.ready ? `Settings version ${view.voice.version}.` : 'Voice settings storage not available (migration 0035).'}</p>
              {view.history.length === 0 ? (
                <Empty title="No voice sessions yet.">Run a test session (Test on a test business, or the Voice Lab) to collect evidence.</Empty>
              ) : (
                <table className="vp-history vp-table" data-vp-history>
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
            </details>
          </div>
        )}
      </div>
    </Section>
  )
  return (
    <div className="cc cc--single" data-voice-providers={b ? b.id : 'none'}>
      <div className="cc-main">
        <PageHead title="Voice providers" lede="Choose a provider, test it, promote it to every business, watch the rollout, roll back if needed." />
        {global && !global.error && (
          <GlobalProvider global={global} reload={reload}>
            {businessesSection}
          </GlobalProvider>
        )}
        {global?.error && <LoadError what="the global default" onRetry={reload} />}
        {global?.error && businessesSection}
        {global === null && <Loading label="Loading…" />}
      </div>
    </div>
  )
}
