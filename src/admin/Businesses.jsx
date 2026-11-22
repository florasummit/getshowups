// Voice Lab → Businesses: every business with its provider (follows the default · still on the previous provider ·
// business-specific), readiness, and Manage → the per-business control (ProviderControl.jsx: Select → Test → Review →
// Activate, business id typed back → Roll back) with its settings and, under disclosure, the session history as codes
// and counts. Platform admins only (server-checked); never transcripts or customer details.
import { useState } from 'react'
import { Badge, Empty, Facts, LoadError, Loading } from './control/ui.jsx'
import { when, mins } from './control/lib.js'
import ProviderControl from '../dashboard/ProviderControl.jsx'
import { consoleOps, STATE } from '../dashboard/provider-control.js'

const KIND = { test: 'Admin test', lab: 'Voice Lab', customer: 'Customer' }
const SETTINGS = { inherited: 'Follows the default', pin: 'Still on the previous provider', override: 'Business-specific' }
const usd = (micros) => (micros == null ? '—' : `$${(micros / 1e6).toFixed(micros < 100_000 ? 4 : 2)}`)

export default function Businesses({ list, global, selected, choose, view, reload }) {
  // Open when a business is selected (deep link or Manage); the admin may fold it until the selection changes.
  const [manual, setManual] = useState(null)
  const [prevSelected, setPrevSelected] = useState(selected)
  if (selected !== prevSelected) {
    setPrevSelected(selected)
    setManual(null)
  }
  const open = manual ?? Boolean(selected)
  const businesses = Array.isArray(list) ? list : []
  const b = view?.business
  return (
    <details className="cc-details vp-businesses" data-vp-businesses-details open={open || undefined} onToggle={(e) => setManual(e.currentTarget.open)}>
      <summary>Businesses{businesses.length ? ` (${businesses.length})` : ''}</summary>
      <div className="vp-stack">
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
                <Empty title="No voice sessions yet.">Run a test session (Test on a test business, or a Lab call) to collect evidence.</Empty>
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
    </details>
  )
}
