// Providers compared (Voice Lab): one compact table from the session records of the last 30 days (customer sessions,
// admin tests and Lab calls alike; server/voice/compare.js), today's budgets with their switches, verified charges on
// request (server/voice/charges.js: the providers' own numbers, never converted between units) and the sessions that
// did not get to a booking, under disclosure. Estimates are labelled estimates everywhere; a verified figure comes
// only from a provider record; "—" means not measured or not available, never zero.
import { useState } from 'react'
import { api } from '../lib/api.js'
import { Badge } from './control/ui.jsx'
import { when } from './control/lib.js'

const NAME = { retell: 'Retell', openai: 'OpenAI Realtime', elevenlabs: 'ElevenLabs' }
const usd = (micros) => (micros == null ? '—' : `$${(micros / 1e6).toFixed(micros < 100_000 ? 4 : 2)}`)
const pct = (r) => (r == null ? '—' : `${Math.round(r * 100)}%`)
const ms = (v) => (v == null ? '—' : `${Math.round(v)} ms`)
const TONE = { ok: 'ok', warn: 'warn', exhausted: 'bad', uncapped: 'neutral' }
const BUDGET = { ok: 'ok', warn: 'near the limit', exhausted: 'used up: starts are refused', uncapped: 'not capped' }
const REASON = { no_tools: 'no tool ran', no_availability: 'ended before the availability lookup', no_booking: 'times offered, no booking' }
const reasonText = (r) => (r.reason.startsWith('connection:') ? `connection failed (${r.reason.slice(11)}${r.closeCode ? `, close ${r.closeCode}` : ''})` : REASON[r.reason] || r.reason)
const CHARGE_ERR = { unsupported: 'no per-session record for this provider', no_reference: 'no provider id recorded for the session', not_configured: 'provider not configured', auth_failed: 'the provider refused our key', not_found: 'the provider has no record with that id', unreachable: 'the provider could not be reached', bad_response: 'unexpected answer', no_cost_yet: 'no cost on the record yet', not_ended: 'the provider still lists the session as running' }

export default function Comparison({ status, reload }) {
  const [busy, setBusy] = useState(null)
  const [msg, setMsg] = useState(null)
  const [balances, setBalances] = useState(status?.balances || null)
  if (!status || status.error) return null
  const c = status.comparison
  const b = status.budgets
  const rows = (c?.providers || []).filter((p) => !p.unavailable)
  const fetchCharges = async () => {
    setBusy('charges')
    setMsg(null)
    const { status: code, data } = await api('/api/platform/voice-lab/session', { method: 'POST', body: { action: 'charges' } })
    setBusy(null)
    if (code !== 200) return setMsg(`Charges could not be fetched (${data?.error || code}).`)
    setMsg(`Verified charges: ${data.recorded} recorded of ${data.candidates} candidates${data.errors.length ? `; ${data.errors.length} failed (${[...new Set(data.errors.map((e) => CHARGE_ERR[e.error] || e.error))].join(', ')})` : ''}${data.skipped.no_reference ? `; ${data.skipped.no_reference} without a provider id` : ''}.`)
    reload?.()
  }
  const checkBalances = async () => {
    setBusy('balances')
    setMsg(null)
    const { status: code, data } = await api('/api/platform/voice-lab/status?balances=1')
    setBusy(null)
    if (code !== 200) return setMsg(`Balances could not be read (${data?.error || code}).`)
    setBalances(data.balances || null)
  }
  const el = balances?.elevenlabs
  return (
    <details className="cc-details vp-compare" data-compare open>
      <summary>Providers compared (last {c?.days ?? 30} days, every session kind)</summary>
      {c?.unavailable ? (
        <p className="fine">Session records are unavailable.</p>
      ) : (
        <div className="vp-table-wrap">
          <table className="vp-history vp-compare-table" data-compare-table>
            <thead>
              <tr>
                <th scope="col">Provider</th>
                <th scope="col">Sessions</th>
                <th scope="col">Connection failures</th>
                <th scope="col">Booking tool</th>
                <th scope="col">Response (median)</th>
                <th scope="col">Minutes</th>
                <th scope="col">Est. cost</th>
                <th scope="col">Verified charges</th>
                <th scope="col">Est. per session</th>
                <th scope="col">Est. per booking</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.id} data-compare-row={p.id}>
                  <th scope="row">{NAME[p.id] || p.id}</th>
                  <td data-label="Sessions">{p.finished}{p.sessions > p.finished ? ` (+${p.sessions - p.finished} open)` : ''}</td>
                  <td data-label="Connection failures">{p.finished ? `${p.connectionFailures} (${pct(p.failureRate)})` : '—'}</td>
                  <td data-label="Booking tool">{p.availability ? `${p.bookings} of ${p.availability} offered (${pct(p.bookingRate)})` : p.finished ? 'never reached' : '—'}</td>
                  <td data-label="Response (median)">{p.latencySessions ? `${ms(p.medianResponseMs)}, first ${ms(p.firstResponseMs)}` : 'not measured'}</td>
                  <td data-label="Minutes">{p.minutes}</td>
                  <td data-label="Est. cost">{p.estimate ? `${usd(p.estimatedMicros)} (estimate)` : 'not estimated'}</td>
                  <td data-label="Verified charges">
                    {p.verified.usdSessions ? `${usd(p.verified.micros)} on ${p.verified.usdSessions} of ${p.finished}` : p.verified.credits ? `${p.verified.credits} credits on ${p.verified.sessions} of ${p.finished} (no USD figure)` : status.chargeSupport?.[p.id] ? 'none fetched' : 'no provider record'}
                  </td>
                  <td data-label="Est. per session">{p.costPerSession.verifiedMicros != null ? `${usd(p.costPerSession.verifiedMicros)} verified` : p.estimate ? `${usd(p.costPerSession.estimatedMicros)}` : '—'}</td>
                  <td data-label="Est. per booking">{p.costPerBooking.verifiedMicros != null ? `${usd(p.costPerBooking.verifiedMicros)} verified` : p.bookings && p.estimate ? usd(p.costPerBooking.estimatedMicros) : p.estimate ? 'no booking yet' : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="fine">
        Estimates use the public per-minute prices in server/voice/providers.js and are never spend. Verified charges are the providers’ own records: Retell’s call cost (cents) and ElevenLabs’ conversation cost (credits, plus a USD figure when ElevenLabs reports one); OpenAI keeps no per-session record for our key. Latency is what the browser adapter measured (speech end to first reply audio); Retell’s path does not measure it.
      </p>
      <div className="cc-actions">
        <button type="button" className="btn btn-sm" onClick={fetchCharges} disabled={busy !== null} data-compare-charges>
          {busy === 'charges' ? 'Fetching…' : 'Fetch verified charges'}
        </button>
        <button type="button" className="btn btn-sm btn-quiet" onClick={checkBalances} disabled={busy !== null} data-compare-balances>
          {busy === 'balances' ? 'Reading…' : 'Check provider balances'}
        </button>
        {msg && (
          <span className="cc-status-line" role="status" data-compare-msg>
            {msg}
          </span>
        )}
      </div>
      {balances && (
        <p className="fine" data-compare-balance>
          {el?.creditsLimit != null ? `ElevenLabs plan: ${el.creditsUsed.toLocaleString()} of ${el.creditsLimit.toLocaleString()} credits used this period (${el.creditsLeft.toLocaleString()} left${el.resetAt ? `, resets ${when(el.resetAt)}` : ''}; from the subscription API, read ${when(el.fetchedAt)}).` : `ElevenLabs plan: not readable (${el?.error || 'unknown'}).`} {balances.retell?.note} {balances.openai?.note}
        </p>
      )}
      {b && (
        <p className="fine" data-budgets data-budget-warnings={b.warnings.length}>
          Budgets today (a start is refused at the limit):{' '}
          {b.providers.map((p) => (
            <span key={p.id} className="vp-budget">
              {NAME[p.id] || p.id} <Badge tone={TONE[p.state]} plain>{p.limit == null ? `${p.used} min, ${BUDGET.uncapped}` : `${p.used} of ${p.limit} min${p.state === 'ok' ? '' : `, ${BUDGET[p.state]}`}`}</Badge>{' '}
            </span>
          ))}
          <span className="vp-budget">
            Lab <Badge tone={TONE[b.lab.state]} plain>{`${b.lab.used} of ${b.lab.limit} min${b.lab.state === 'ok' ? '' : `, ${BUDGET[b.lab.state]}`}`}</Badge>{' '}
          </span>
          {b.testBusinesses.map((t) => (
            <span key={t.id} className="vp-budget">
              Tests on {t.name} <Badge tone={TONE[t.state]} plain>{`${t.used} of ${t.limit} min${t.state === 'ok' ? '' : `, ${BUDGET[t.state]}`}`}</Badge>{' '}
            </span>
          ))}
          <span className="vp-budget-switches">Switches: VOICE_PROVIDER_DAILY_MINUTES (and _OPENAI / _ELEVENLABS / _RETELL), VOICE_LAB_DAILY_MINUTES, VOICE_TEST_DAILY_MINUTES, RECEPTIONIST_VOICE_DAILY_MINUTES.</span>
        </p>
      )}
      {c && !c.unavailable && (
        <details className="cc-details" data-compare-incomplete>
          <summary>
            Connection failures and incomplete bookings ({c.counts.connectionFailures} failed to connect, {c.counts.incompleteBookings} did not book)
          </summary>
          {c.incomplete.length ? (
            <ul className="cc-list">
              {c.incomplete.map((r) => (
                <li key={r.id} className="cc-item" data-compare-incomplete-row={r.reason.startsWith('connection:') ? 'connection' : r.reason}>
                  <span className="cc-item-main">
                    <span className="cc-item-title">
                      {NAME[r.provider] || r.provider} · {r.kind} · {r.customer}
                    </span>
                    <span className="cc-item-sub">
                      {reasonText(r)} · {r.durationSeconds != null ? `${r.durationSeconds} s` : '—'} · {when(r.endedAt)}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="fine">Every finished session in the period reached a booking or ended before the tools were needed.</p>
          )}
        </details>
      )}
    </details>
  )
}
