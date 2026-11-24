// Overview → "Results in full": every stage from inquiry to money, from your records only. Loaded when opened.
import { useEffect, useState } from 'react'
import { api } from '../lib/api.js'

const usd = (c) => (c == null ? 'none recorded' : `$${(c / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}`)
const time = (m) => (m < 60 ? `${m} min` : m < 2880 ? `${Math.round(m / 6) / 10} h` : `${Math.round(m / 1440)} days`)
const share = (a, b) => (b >= 10 ? `${Math.round((a / b) * 100)}%` : 'too few to judge')

export default function Scorecard() {
  const [open, setOpen] = useState(false)
  const [days, setDays] = useState(30)
  const [r, setR] = useState(null)
  useEffect(() => {
    if (!open) return
    let live = true
    api(`/api/dashboard/results?days=${days}&scope=all`).then(({ status, data }) => live && setR(status === 200 ? data : { failed: true }))
    return () => {
      live = false
    }
  }, [open, days])
  const s = r?.funnel?.stages
  const t = r?.response
  const ai = r?.ai
  const rows = s && [
    ['Inquiries', s.leads],
    ['In your area', s.qualified, share(s.qualified, s.leads)],
    ['Booked', s.booked, `${share(s.booked, s.qualified)}${s.booked && s.qualified >= 10 ? ' of those in your area' : ''}`],
    ['Happened', s.attended, s.past ? `${s.outcomeRecorded} of ${s.past} past visits marked` : 'none past yet'],
    ['Jobs completed', s.completed],
    ['Paid', usd(r.funnel.revenue.paidCents), 'payments you recorded'],
    ...(t ? [['Time to first message or booking', t.medianMinutes == null ? 'too few to judge' : time(t.medianMinutes), `${t.handled} of ${t.inquiries}; ${t.noneRecorded} with nothing recorded (calls aren’t seen)`]] : []),
    ['Traced to your ads', r.funnel.attribution.adLeads, `${r.funnel.attribution.unattributed} not traced`],
    ...(ai ? [['AI cost (estimate, paid by GetShowUps)', `$${((ai.assistantMicros + ai.receptionistMicros) / 1e6).toFixed(2)}`, `${ai.assistantQuestions} questions, ${ai.conversations} conversations`]] : []),
  ]
  return (
    <details className="card scorecard" onToggle={(e) => setOpen(e.currentTarget.open)} data-scorecard>
      <summary>Results in full</summary>
      <div className="fchips" role="group" aria-label="Period">
        {[7, 30, 90].map((d) => (
          <button key={d} type="button" className="fchip" aria-pressed={days === d} onClick={() => setDays(d)}>
            {d} days
          </button>
        ))}
      </div>
      {!open ? null : !r ? <div className="ui-skeleton-block" aria-busy="true" /> : r.failed ? <p className="form-error" role="alert">Couldn’t load results. Try again in a moment.</p> : (
        <table className="ar-table" aria-busy={r.funnel.range.days !== days}>
          <caption className="fine">Inquiries from the last {r.funnel.range.days} days, followed to what became of each. Records only; nothing is estimated.</caption>
          <tbody>
            {rows.map(([label, value, note]) => (
              <tr key={label}>
                <th scope="row">{label}</th>
                <td>{value}</td>
                <td className="fine">{note}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </details>
  )
}
