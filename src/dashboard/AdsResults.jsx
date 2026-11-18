// Ads results: does the money turn into jobs? One funnel from the server (server/ads/funnel.js) — spend → leads →
// booked → showed up → completed → money — with cost per step, honest gaps ("—" = can't be calculated yet), how many
// leads the ads could be credited for, and evidence-based diagnostics. Nothing here changes a campaign.
import { useEffect, useState } from 'react'
import { api, timeAgo } from '../lib/api.js'
import { Pill } from './ui.jsx'

const usd = (c) => (c == null ? '—' : `$${(c / 100).toLocaleString('en-US', { minimumFractionDigits: c % 100 ? 2 : 0, maximumFractionDigits: 2 })}`)
const rate = (a, b, min) => (b >= min && b > 0 ? `${Math.round((a / b) * 100)}%` : null)
const LEVEL = { act: ['warn', 'Needs attention'], watch: ['info', 'Worth a look'], info: ['neutral', 'Note'] }

export default function AdsResults({ testAccount }) {
  const [days, setDays] = useState(30)
  const [r, setR] = useState(null)
  useEffect(() => {
    let live = true
    api(`/api/dashboard/results?days=${days}&scope=ads`).then(({ status, data }) => live && setR(status === 200 ? data : { failed: true }))
    return () => {
      live = false
    }
  }, [days])
  const f = r?.funnel
  const s = f?.stages
  const rows = f && [
    ['Ad spend', usd(f.spend.cents), f.spend.clicks != null ? `${f.spend.clicks} clicks` : 'not reported yet', null],
    ['Leads from your ads', s.leads, usd(f.cost.perLead), null],
    ['Qualified (in your area)', s.qualified, usd(f.cost.perQualified), rate(s.qualified, s.leads, 10)],
    ...(s.outsideArea ? [['Outside your service area', s.outsideArea, '', 'answer in Appointments']] : []),
    ['Booked', s.booked, usd(f.cost.perBooking), rate(s.booked, s.leads, 10)],
    ['Showed up', s.attended, usd(f.cost.perAttended), s.outcomeRecorded ? `${s.attended} of ${s.outcomeRecorded} marked` : 'none marked yet'],
    ['Jobs completed', s.completed, usd(f.cost.perCompleted), null],
  ]
  return (
    <section className="ui-section ar" aria-label="Ad results">
      <div className="ui-section-head">
        <h2 className="ui-section-title">Results</h2>
        <div className="fchips" role="group" aria-label="Period">
          {[7, 30, 90].map((d) => (
            <button key={d} type="button" className="fchip" aria-pressed={days === d} onClick={() => setDays(d)}>
              {d} days
            </button>
          ))}
        </div>
      </div>
      {!r ? (
        <div className="ui-skeleton-block" aria-busy="true" />
      ) : r.failed ? (
        <p className="form-error" role="alert">
          Couldn’t load results. Try again in a moment.
        </p>
      ) : (
        <>
          <p className="ar-source">
            {f.spend.cents == null ? 'No ad spend reported by Google for this period yet.' : `Spend from Google${f.spend.fetchedAt ? `, updated ${timeAgo(f.spend.fetchedAt)}` : ''}.`}{' '}
            Leads, bookings and jobs come from your own records.
            {testAccount && <strong> Test account: no real ads ran, so these aren’t business results.</strong>}
          </p>
          <table className="ar-table">
            <thead>
              <tr>
                <th scope="col">Last {f.range.days} days</th>
                <th scope="col">Count</th>
                <th scope="col">Cost each</th>
                <th scope="col">
                  <span className="sr-only">Detail</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map(([label, value, cost, detail]) => (
                <tr key={label}>
                  <th scope="row">{label}</th>
                  <td>{value}</td>
                  <td>{label === 'Ad spend' ? '' : cost}</td>
                  <td className="ar-detail">{label === 'Ad spend' ? cost : detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <dl className="ar-money" aria-label="Money from these jobs">
            <div>
              <dt>Estimated job value</dt>
              <dd>{usd(f.revenue.estimatedCents)}</dd>
            </div>
            <div>
              <dt>Invoiced</dt>
              <dd>{usd(f.revenue.invoicedCents)}</dd>
            </div>
            <div>
              <dt>Paid</dt>
              <dd>{usd(f.revenue.paidCents)}</dd>
            </div>
            <div>
              <dt>Paid per $1 of ads</dt>
              <dd>{f.roas == null ? '—' : `$${f.roas.toFixed(2)}`}</dd>
            </div>
          </dl>
          <p className="fine">
            {f.attribution.allLeads === 0
              ? 'No leads in this period.'
              : `${f.attribution.adLeads} of ${f.attribution.allLeads} leads in this period came from your ads; ${f.attribution.unattributed} came from elsewhere or couldn’t be traced to an ad.`}{' '}
            “—” means it can’t be calculated yet. Money is what you recorded on each visit; GetShowUps doesn’t measure how much of it the ads caused.
          </p>
          {r.diagnostics.length > 0 && (
            <ul className="ar-findings" aria-label="What to look at">
              {r.diagnostics.map((d, i) => (
                <li key={d.id} className={i === 0 && d.level !== 'info' ? 'is-top' : ''}>
                  <p className="ar-finding-title">
                    <Pill tone={LEVEL[d.level][0]}>{LEVEL[d.level][1]}</Pill> {d.title}
                  </p>
                  <p className="fine">
                    {d.detail}
                    {d.sample ? ` Based on ${d.sample}.` : ''}
                  </p>
                </li>
              ))}
            </ul>
          )}
          <details className="ar-defs">
            <summary className="fine">How these are counted</summary>
            <ul className="fine">
              <li>Leads are people who came from your ads (an ad link or Google Ads lead) in the period; test records are left out.</li>
              <li>Qualified means their ZIP is on your service list (or you approved their area). Leads outside it are kept and counted separately until you answer them.</li>
              <li>Booked, showed up and completed follow those same leads. Cancelled bookings aren’t counted as booked.</li>
              <li>Showed up and completed come from what you mark on each visit; a booking is never counted as a visit.</li>
              <li>Paid per $1 of ads uses only money you marked as paid, divided by ad spend.</li>
              <li>Google’s daily budget is an average: it can spend up to twice that on a busy day, but no more than about 30 days’ worth in a month.</li>
            </ul>
          </details>
        </>
      )}
    </section>
  )
}
