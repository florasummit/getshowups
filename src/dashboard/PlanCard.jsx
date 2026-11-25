// Plan and billing: status, next charge, card, invoices, cancel and keep. Amounts and dates are Stripe's own; a part that
// couldn't be read says so. Cancelling is confirmed only after Stripe confirms it.
import { useEffect, useState } from 'react'
import { api } from '../lib/api.js'

const date = (ms) => new Date(ms).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
const money = (c, cur = 'usd') => (c == null ? null : new Intl.NumberFormat('en-US', { style: 'currency', currency: cur.toUpperCase() }).format(c / 100))
const INVOICE = { paid: 'Paid', open: 'Due', void: 'Cancelled', uncollectible: 'Not collected' }
const ERR = { owner_only: 'Only the business owner can change the plan.', subscription_ended: 'This plan has already ended.', no_subscription: 'There’s no plan to change.', test_business: 'Test businesses don’t use live billing.', not_confirmed: 'Stripe didn’t confirm this, so we can’t say it’s done. Check again in a minute.', rate_limited: 'Too many tries. Wait a few minutes.' }

export default function PlanDetails({ sub, owner, reload, portal }) {
  const [d, setD] = useState(undefined)
  const [ask, setAsk] = useState(null)
  const [state, setState] = useState({})
  const load = () => api('/api/dashboard/billing?details=1').then(({ status, data }) => setD(status === 200 ? data : null))
  useEffect(() => {
    if (owner && sub.manageable) load()
  }, [owner, sub.manageable])
  if (!owner) return <p className="fine">Only the business owner sees charges and changes the plan.</p>
  const run = async (action) => {
    setState({ busy: true })
    const { status, data } = await api('/api/dashboard/billing', { method: 'POST', body: { action, confirm: true } })
    setAsk(null)
    if (status !== 200) {
      setState({ error: ERR[data.error] || 'That didn’t work. Nothing was changed.' })
      return load()
    }
    setState({ done: action === 'cancel' ? (data.ended ? 'Your plan has already ended.' : `Cancelled. Stripe confirmed it: your plan ends ${data.endsAt ? date(data.endsAt) : 'at the end of this period'} and you won’t be charged again.`) : 'Your plan continues. Stripe confirmed it.' })
    load()
    reload?.()
  }
  const n = d?.nextCharge
  const ends = n?.none ? n.endsAt : sub.cancelAtPeriodEnd ? sub.currentPeriodEnd : null
  const ending = Boolean(n?.none || sub.cancelAtPeriodEnd)
  return (
    <div className="stack" data-plan={ending ? 'ending' : sub.status}>
      <dl className="kv">
        <div>
          <dt>Next charge</dt>
          <dd>{ending ? `None. Ends ${ends ? date(ends) : 'at the end of this period'}` : d === undefined ? 'Checking…' : n?.amountCents != null ? `${money(n.amountCents, n.currency)} on ${n.at ? date(n.at) : 'your renewal date'} (plus tax if shown on the invoice)` : `Amount couldn’t be read${sub.currentPeriodEnd ? `; renews ${date(sub.currentPeriodEnd)}` : ''}`}</dd>
        </div>
        <div>
          <dt>Payment method</dt>
          <dd>{d === undefined ? 'Checking…' : d?.card?.last4 ? `${d.card.brand ? `${d.card.brand[0].toUpperCase()}${d.card.brand.slice(1)} ` : ''}ending ${d.card.last4}${d.card.expires ? `, expires ${d.card.expires}` : ''}` : 'Couldn’t be read; see Stripe'}</dd>
        </div>
      </dl>
      {sub.status === 'past_due' && <p className="notice-info">Your last payment failed. Stripe tries again; update your payment method to fix it. Ads we run for you are paused meanwhile.</p>}
      <button type="button" className="btn btn-quiet btn-block" disabled={!sub.manageable} onClick={portal}>
        Manage billing
      </button>
      <p className="fine">Opens Stripe: payment method, billing address and tax details.</p>
      {ending ? (
        ask === 'keep' ? (
          <div className="stack" role="group" aria-label="Keep my plan">
            <p>
              Keep your plan? You’ll be charged <strong>every month</strong> again, starting {ends ? date(ends) : 'at your next renewal'}, at your plan’s price.
            </p>
            <div className="row-actions">
              <button type="button" className="btn btn-sm btn-quiet" onClick={() => setAsk(null)}>
                Back
              </button>
              <button type="button" className="btn btn-sm btn-primary" disabled={state.busy} onClick={() => run('keep')}>
                Yes, keep charging me
              </button>
            </div>
          </div>
        ) : (
          <button type="button" className="btn btn-primary" onClick={() => setAsk('keep')}>
            Keep my plan
          </button>
        )
      ) : ask === 'cancel' ? (
        <div className="stack" role="group" aria-label="Cancel plan">
          <p>
            <strong>Cancel your plan?</strong>
          </p>
          <ul className="fine">
            <li>You keep everything until {sub.currentPeriodEnd ? date(sub.currentPeriodEnd) : 'the end of the period you paid for'}. No further charges. The rest of the period isn’t refunded automatically.</li>
            <li>After that: your website stays online 14 more days; ads we run are paused; booking stops when the website does.</li>
            <li>Your data is kept, and for 90 days you can reactivate and find everything as it was.</li>
            <li>Connected Google, ad and domain accounts stay yours. Upcoming appointments stay in your calendar.</li>
            {sub.status === 'past_due' && <li>An unpaid invoice stays due.</li>}
          </ul>
          <div className="row-actions">
            <button type="button" className="btn btn-sm btn-quiet" onClick={() => setAsk(null)}>
              Keep my plan
            </button>
            <button type="button" className="btn btn-sm btn-danger" disabled={state.busy} onClick={() => run('cancel')}>
              Confirm: cancel plan
            </button>
          </div>
        </div>
      ) : (
        <button type="button" className="btn btn-sm btn-quiet" disabled={!sub.manageable} onClick={() => setAsk('cancel')}>
          Cancel plan…
        </button>
      )}
      {state.error && (
        <p className="form-error" role="alert">
          {state.error}
        </p>
      )}
      {state.done && (
        <p className="notice-info" role="status" data-plan-result>
          {state.done}
        </p>
      )}
      <p className="row-title">Invoices and receipts</p>
      {d === undefined ? (
        <p className="fine">Checking…</p>
      ) : !d?.invoices ? (
        <p className="fine">Couldn’t be read. Open Manage billing to see them.</p>
      ) : d.invoices.length ? (
        <ul className="rows" data-invoices>
          {d.invoices.map((i, k) => (
            <li key={i.number || k} className="row">
              <div className="row-main">
                <p className="row-title">
                  {date(i.at)} · {money(i.amountCents, i.currency) ?? 'amount unavailable'}
                </p>
                <p className="row-sub">{INVOICE[i.status] || i.status}</p>
              </div>
              <div className="row-actions">
                {i.url && (
                  <a className="link-btn" href={i.url} target="_blank" rel="noreferrer">
                    View
                  </a>
                )}
                {i.pdf && (
                  <a className="link-btn" href={i.pdf} rel="noreferrer">
                    PDF
                  </a>
                )}
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="fine">None yet.</p>
      )}
    </div>
  )
}
