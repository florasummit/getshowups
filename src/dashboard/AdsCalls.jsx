// Phone calls (and Local Services leads) Google reports for the business: answered, missed, called back, and what came of the
// callers the owner linked to customers (/api/dashboard/ads/calls). Google never says who called; nothing is guessed.
import { useEffect, useState } from 'react'
import { api } from '../lib/api.js'
import { Pill } from './ui.jsx'

const usd = (c) => (c == null ? 'none recorded' : `$${(c / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}`)
const length = (s) => (s == null ? '' : s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`)
const when = (t) => new Date(`${t.replace(' ', 'T')}:00Z`).toLocaleString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
const STATUS = { RECEIVED: ['ok', 'Answered'], MISSED: ['warn', 'Missed'], UNKNOWN: ['neutral', 'Not reported'] }
const LSA = { PHONE_CALL: 'Phone call', MESSAGE: 'Message', BOOKING: 'Booking', COUPON: 'Coupon' }
const ERRORS = { invalid_name: 'Add their name.', invalid_phone: 'Add their phone number.', invalid_need: 'Add what they need.', invalid_zip: 'Add a valid ZIP.', invalid_address: 'Add the service address.', already_linked: 'This call is already linked.', rate_limited: 'Too many tries. Please wait a few minutes.' }
const of = (n, one) => `${n} ${one}${n === 1 ? '' : 's'}`

function Row({ kind, c, title, detail, pill, people, needs, post }) {
  const [mode, setMode] = useState(null)
  const [f, setF] = useState({ name: '', phone: '', need: '', street: '', city: '', state: '', zip: '' })
  const [pick, setPick] = useState('')
  const [err, setErr] = useState(null)
  const [busy, setBusy] = useState(false)
  const [book, setBook] = useState(null)
  const [known, setKnown] = useState(null)
  const [note, setNote] = useState('')
  const fields = [
    ['name', 'Name', 'text', true],
    ['phone', 'Phone', 'tel', true],
    ['need', 'What they need', 'text', true],
    ...(needs.address ? [['street', 'Street address', 'text', true], ['city', 'City', 'text', true], ['state', 'State', 'text', true]] : []),
    ['zip', 'ZIP', 'text', needs.zip || needs.address],
  ]
  const send = async (body) => {
    setBusy(true)
    setErr(null)
    const { status, data } = await post({ kind, id: c.id, ...body })
    setBusy(false)
    if (status !== 200) {
      if (data?.error === 'already_customer') setKnown(data.lead)
      return setErr(data?.error === 'already_customer' ? `${data.lead.name} is already recorded with this phone number.` : ERRORS[data?.error] || 'That didn’t save. Try again in a moment.')
    }
    setMode(null)
    setKnown(null)
    setBook(data.bookUrl || null)
    setNote(data.notBookable ? 'Saved. Their ZIP isn’t in your service area, so there is no booking link.' : 'Saved.')
  }
  return (
    <li className="ai-proposal" data-call={c.id} data-call-kind={kind}>
      <p>
        {pill} <strong>{title}</strong> <span className="fine">{detail}</span>
      </p>
      {c.lead ? (
        <p className="fine">
          Customer: {c.lead.name}{' '}
          <button type="button" className="link-btn" disabled={busy} aria-label={`Unlink the customer from ${title}`} onClick={() => send({ action: 'link', leadId: null })}>
            Unlink
          </button>
          {book && (
            <>
              {' · '}
              <a href={book} target="_blank" rel="noreferrer">
                Book a time for them
              </a>
            </>
          )}
        </p>
      ) : (
        <div className="ui-form-actions">
          {kind === 'call' && c.status === 'MISSED' && (
            <button type="button" className="btn btn-quiet btn-sm" disabled={busy} onClick={() => send({ action: 'handled', handled: !c.handled })}>
              {c.handled ? 'Not called back' : 'I called back'}
            </button>
          )}
          <button type="button" className="link-btn" onClick={() => setMode(mode === 'add' ? null : 'add')} aria-expanded={mode === 'add'} aria-label={`Add the caller, ${title}`}>
            Add the caller
          </button>
          {people.length > 0 && (
            <button type="button" className="link-btn" onClick={() => setMode(mode === 'link' ? null : 'link')} aria-expanded={mode === 'link'} aria-label={`Already a customer, ${title}`}>
              Already a customer
            </button>
          )}
          {c.handled && <span className="fine">Called back</span>}
        </div>
      )}
      {mode === 'add' && (
        <form
          className="ai-change-controls"
          onSubmit={(e) => {
            e.preventDefault()
            send({ action: 'add', name: f.name, phone: f.phone, need: f.need, zip: f.zip, ...(needs.address ? { address: { street: f.street, city: f.city, state: f.state, zip: f.zip } } : {}) })
          }}
        >
          {fields.map(([k, label, type, required]) => (
            <label className="field" key={k}>
              <span>{label}</span>
              <input type={type} required={Boolean(required)} inputMode={k === 'zip' ? 'numeric' : undefined} value={f[k]} maxLength={k === 'need' ? 300 : 80} autoComplete="off" onChange={(e) => setF({ ...f, [k]: e.target.value })} />
            </label>
          ))}
          <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>
            Save customer
          </button>
        </form>
      )}
      {mode === 'link' && (
        <div className="ai-change-controls">
          <label className="field">
            <span>Customer</span>
            <select value={pick} onChange={(e) => setPick(e.target.value)}>
              <option value="">Choose…</option>
              {people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({new Date(p.at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })})
                </option>
              ))}
            </select>
          </label>
          <button type="button" className="btn btn-primary btn-sm" disabled={busy || !pick} onClick={() => send({ action: 'link', leadId: pick })}>
            Link
          </button>
        </div>
      )}
      <p className="fine" role="status">
        {note}
      </p>
      {err && (
        <p className="form-error" role="alert">
          {err}{' '}
          {known && (
            <button type="button" className="link-btn" disabled={busy} onClick={() => send({ action: 'link', leadId: known.id })}>
              Link this call to them
            </button>
          )}
        </p>
      )}
    </li>
  )
}

export default function AdsCalls({ days, refreshed }) {
  const [d, setD] = useState(null)
  useEffect(() => {
    let live = true
    api(`/api/dashboard/ads/calls?days=${days}`).then(({ status, data }) => live && setD(status === 200 ? data : null))
    return () => {
      live = false
    }
  }, [days, refreshed])
  if (!d?.ready || !d.setup) return null
  const post = async (body) => {
    const r = await api('/api/dashboard/ads/calls', { method: 'POST', body: { ...body, days } })
    if (r.status === 200) setD(r.data)
    return r
  }
  const { totals: t, results: r, setup } = d
  const lsaCalls = d.lsa
  const needs = { address: d.addressNeeded, zip: d.zipNeeded }
  return (
    <section className="ai-calls" aria-label="Phone calls from Google ads" data-google-calls>
      <h3 className="ui-section-title">Phone calls from Google ads</h3>
      <p className="fine" data-call-setup>
        {setup.reporting === false
          ? 'Call reporting is off in your Google Ads account, so Google can’t count calls. Turn it on in Google Ads: Admin → Account settings → Call reporting.'
          : setup.numbersOnAds === 0 && t.calls === 0
            ? 'We found no phone number on your ads. In Google Ads, add a Call asset with your business number: people still reach your own phone, and Google counts the calls.'
            : setup.reporting === null
              ? 'Google didn’t say whether call reporting is on.'
              : 'Google counts calls to the number shown on your ads and forwards them to your own phone.'}{' '}
        Google doesn’t share who called, so check your phone’s call list for the number.
      </p>
      {t.calls > 0 && (
        <p data-call-totals>
          <strong>{of(t.calls, 'call')}</strong> in {d.days} days: {t.answered} answered, {t.missed} missed{t.missedOpen ? `, ${t.missedOpen} not called back yet` : ''}.{' '}
          {r.people ? `${of(r.people, 'caller')} linked to customers: ${r.booked} booked, ${r.completed} completed, payments ${usd(r.paidCents)}.` : 'No caller is linked to a customer yet.'}
        </p>
      )}
      {t.calls > 0 && (
        <details open={t.missedOpen > 0 && t.missedOpen <= 5}>
          <summary>Calls</summary>
          <ul className="ai-recs">
            {d.calls.map((c) => (
              <Row
                key={c.id}
                kind="call"
                c={c}
                people={d.people} needs={needs}
                post={post}
                title={when(c.localTime)}
                pill={<Pill tone={(STATUS[c.status] || STATUS.UNKNOWN)[0]}>{(STATUS[c.status] || STATUS.UNKNOWN)[1]}</Pill>}
                detail={[length(c.seconds), c.campaign, c.shownOn === 'LANDING_PAGE' ? 'from the landing page' : c.shownOn === 'AD' ? 'from the ad' : null].filter(Boolean).join(' · ')}
              />
            ))}
          </ul>
          <p className="fine">Times are as Google reports them{setup.timeZone ? ` (read as your Ads account’s time zone, ${setup.timeZone})` : ''}.</p>
        </details>
      )}
      {lsaCalls.length > 0 && (
        <details data-lsa-link>
          <summary>
            Local Services leads: link them to customers
            {d.lsaResults.people ? ` (${d.lsaResults.people} linked, ${d.lsaResults.booked} booked, payments ${usd(d.lsaResults.paidCents)})` : ''}
          </summary>
          <ul className="ai-recs">
            {lsaCalls.map((c) => (
              <Row key={c.id} kind="lsa" c={c} people={d.people} needs={needs} post={post} title={new Date(c.createdAt).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' })} detail={c.charged ? 'charged' : 'not charged'} pill={<Pill tone="info">{LSA[c.type] || 'Lead'}</Pill>} />
            ))}
          </ul>
        </details>
      )}
      <p className="fine">A linked caller who already came another way keeps that source. Payments are what you recorded; they aren’t proof the ad caused the job.</p>
    </section>
  )
}
