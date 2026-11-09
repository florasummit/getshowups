// Public booking page at /book/:id — details → time → booked. Real slots from the business's
// Google Calendar; the booking creates a real calendar event and Google emails the invitation.
import { useEffect, useMemo, useState } from 'react'
import { api, fmt, noIndex } from '../lib/api.js'
import '../app.css'

const FIELD_ERRORS = {
  invalid_name: 'Please enter your name.',
  invalid_email: 'Please enter a valid email.',
  invalid_phone: 'Please enter a valid phone number.',
  invalid_need: 'Tell us briefly what you need.',
  invalid_zip: 'Please enter a valid ZIP code.',
  invalid_street: 'Please enter the street address, including the number.',
  invalid_city: 'Please enter the city.',
  invalid_state: 'Please enter the two-letter state, like SC.',
  rate_limited: 'Too many attempts. Please wait a few minutes and try again.',
}

export default function BookingPage({ id }) {
  const [page, setPage] = useState({ loading: true })
  // A "pick a time" link from a follow-up message carries the lead id and a signed token.
  const [resume] = useState(() => {
    const q = new URLSearchParams(window.location.search)
    return q.get('lead') && q.get('k') ? { leadId: q.get('lead'), leadToken: q.get('k'), qualified: true } : null
  })
  const [step, setStep] = useState(resume ? 'time' : 'details')
  const [lead, setLead] = useState(resume)
  const [booked, setBooked] = useState(null)

  const loadSlots = () =>
    api(`/api/book/${id}`).then(({ status, data }) => setPage(status === 200 ? { data } : { missing: status === 404, error: status !== 404 }))

  useEffect(() => {
    const cleanup = noIndex()
    api(`/api/book/${id}`).then(({ status, data }) => {
      setPage(status === 200 ? { data } : { missing: status === 404, error: status !== 404 })
      if (status === 200) document.title = `Book with ${data.name}`
    })
    return cleanup
  }, [id])

  if (page.loading) return <main className="center-page" aria-busy="true" />
  if (page.missing || page.error) {
    // 429 and network errors land here as "can't load times right now".
    return (
      <main className="center-page">
        <div className="panel panel--narrow enter">
          <h1 className="title">{page.missing ? 'This booking page isn’t available' : 'We can’t load times right now'}</h1>
          <p className="lede">{page.missing ? 'Check the link and try again.' : 'Please try again in a moment.'}</p>
        </div>
      </main>
    )
  }

  const biz = page.data
  return (
    <main className="center-page center-page--top booking">
      <p className="booking-biz">{biz.name}</p>
      <section key={step} className="panel panel--narrow enter">
        {step === 'details' && (
          <Details
            id={id}
            askZip={biz.askZip}
            visit={biz.appointmentMode === 'at_customer'}
            offerSms={biz.offerSms}
            bizName={biz.name}
            onDone={(l) => {
              setLead(l)
              setStep(l.qualified ? 'time' : 'outside')
            }}
          />
        )}
        {step === 'time' && (
          <PickTime
            id={id}
            biz={biz}
            lead={lead}
            refresh={loadSlots}
            onBooked={(b) => {
              setBooked(b)
              setStep('done')
            }}
          />
        )}
        {step === 'outside' && (
          <>
            <h1 className="title">Thanks, {lead.firstName}</h1>
            <p className="lede">We don’t serve your area online yet. {biz.name} has your request and may reach out.</p>
          </>
        )}
        {step === 'done' && (
          <div className="done">
            <span className="done-mark" aria-hidden="true">
              ✓
            </span>
            <h1 className="title">{biz.appointmentMode === 'at_customer' ? 'Visit booked' : 'You’re booked'}</h1>
            <p className="done-when">{fmt(booked.start, biz.timezone, { weekday: 'long', month: 'long', day: 'numeric' })}</p>
            <p className="done-time">
              {fmt(booked.start, biz.timezone, { hour: 'numeric', minute: '2-digit' })}
              {sameZone(biz.timezone) ? '' : ` (${biz.timezone.replaceAll('_', ' ')})`}
            </p>
            {lead.street && (
              <p className="lede">
                {biz.name} will visit {lead.street}.
              </p>
            )}
            <p className="lede">A calendar invitation is on its way to {lead.email || 'your email'}.</p>
          </div>
        )}
      </section>
      <p className="fine booking-foot">
        Powered by <a href="/">GetShowUps</a>
      </p>
    </main>
  )
}

const sameZone = (tz) => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone === tz
  } catch {
    return false
  }
}

function Details({ id, askZip, visit, offerSms, bizName, onDone }) {
  const [form, setForm] = useState({ name: '', phone: '', email: '', need: '', zip: '', website: '', smsConsent: false })
  const [address, setAddress] = useState({ street: '', unit: '', city: '', state: '', zip: '' })
  const setA = (k) => (e) => setAddress((a) => ({ ...a, [k]: k === 'state' ? e.target.value.toUpperCase() : e.target.value }))
  const [state, setState] = useState({})
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }))

  const submit = async (e) => {
    e.preventDefault()
    setState({ saving: true })
    // Ad attribution: only the utm/gclid parameters from the link, never personal data.
    const q = new URLSearchParams(location.search)
    const attribution = Object.fromEntries(['utm_source', 'utm_medium', 'utm_campaign', 'gclid'].filter((k) => q.get(k)).map((k) => [k, q.get(k)]))
    const body = { ...(visit ? { ...form, address } : form), ...(Object.keys(attribution).length ? { attribution } : {}) }
    const { status, data } = await api(`/api/book/${id}/lead`, { method: 'POST', body })
    if (status === 201) {
      return onDone({ ...data, email: form.email.trim(), firstName: form.name.trim().split(' ')[0], street: visit ? address.street.trim() : null })
    }
    setState({ error: FIELD_ERRORS[data.error] || 'Something went wrong. Please try again.' })
  }

  return (
    <form className="form" onSubmit={submit}>
      <h1 className="title">{visit ? 'Book a visit' : 'Book an appointment'}</h1>
      <label className="field">
        <span>What do you need?</span>
        <textarea value={form.need} onChange={set('need')} rows={2} maxLength={500} required autoFocus />
      </label>
      <label className="field">
        <span>Name</span>
        <input value={form.name} onChange={set('name')} maxLength={80} required autoComplete="name" />
      </label>
      <div className={askZip ? 'field-row' : 'form'}>
        <label className="field">
          <span>Phone</span>
          <input value={form.phone} onChange={set('phone')} type="tel" required autoComplete="tel" />
        </label>
        {askZip && (
          <label className="field field--zip">
            <span>ZIP</span>
            <input value={form.zip} onChange={set('zip')} required autoComplete="postal-code" inputMode="numeric" maxLength={10} />
          </label>
        )}
      </div>
      <label className="field">
        <span>Email</span>
        <input value={form.email} onChange={set('email')} type="email" required autoComplete="email" />
      </label>
      {visit && (
        <fieldset className="field address">
          <legend>Service address</legend>
          <input aria-label="Street address" placeholder="Street address" value={address.street} onChange={setA('street')} required maxLength={100} autoComplete="address-line1" />
          <input aria-label="Apt, suite (optional)" placeholder="Apt, suite (optional)" value={address.unit} onChange={setA('unit')} maxLength={20} autoComplete="address-line2" />
          <div className="address-row">
            <input aria-label="City" placeholder="City" value={address.city} onChange={setA('city')} required maxLength={60} autoComplete="address-level2" />
            <input aria-label="State" placeholder="State" value={address.state} onChange={setA('state')} required maxLength={2} autoComplete="address-level1" />
            <input aria-label="ZIP" placeholder="ZIP" value={address.zip} onChange={setA('zip')} required maxLength={10} inputMode="numeric" autoComplete="postal-code" />
          </div>
        </fieldset>
      )}
      {offerSms && (
        <label className="check">
          <input type="checkbox" checked={form.smsConsent} onChange={(e) => setForm((f) => ({ ...f, smsConsent: e.target.checked }))} />
          <span>
            Text me about this appointment (confirmation and reminders) from {bizName} via GetShowUps. Message frequency varies. Msg &amp; data
            rates may apply. Reply STOP to opt out, HELP for help. Not required to book. <a href="/privacy">Privacy</a>
          </span>
        </label>
      )}
      <input className="hp" tabIndex={-1} autoComplete="off" aria-hidden="true" value={form.website} onChange={set('website')} name="website" />
      {state.error && (
        <p className="form-error" role="alert">
          {state.error}
        </p>
      )}
      <button className="btn btn-primary btn-lg btn-block" disabled={state.saving}>
        {state.saving ? 'One moment…' : 'Choose a time'}
      </button>
    </form>
  )
}

function PickTime({ id, biz, lead, refresh, onBooked }) {
  const tz = biz.timezone
  const days = useMemo(() => {
    const map = new Map()
    for (const s of biz.slots) {
      const key = fmt(s, tz, { year: 'numeric', month: '2-digit', day: '2-digit' })
      if (!map.has(key)) map.set(key, [])
      map.get(key).push(s)
    }
    return [...map.values()]
  }, [biz.slots, tz])
  const [day, setDay] = useState(0)
  const [slot, setSlot] = useState(null)
  const [state, setState] = useState({})

  const book = async () => {
    setState({ saving: true })
    const { status, data } = await api(`/api/book/${id}/appointment`, { method: 'POST', body: { leadId: lead.leadId, leadToken: lead.leadToken, start: slot } })
    if (status === 201) return onBooked(data)
    if (data.error === 'slot_unavailable') {
      setSlot(null)
      await refresh()
      return setState({ error: 'That time was just taken. Please pick another.' })
    }
    if (data.error === 'already_booked') return setState({ error: 'You already have an appointment booked.' })
    if (data.error === 'rate_limited') return setState({ error: FIELD_ERRORS.rate_limited })
    setState({ error: 'We couldn’t book that time. Please try again.' })
  }

  if (!days.length) {
    return (
      <>
        <h1 className="title">No open times right now</h1>
        <p className="lede">{biz.name} has your request and will reach out.</p>
      </>
    )
  }
  const current = days[Math.min(day, days.length - 1)]
  return (
    <>
      <h1 className="title">{biz.appointmentMode === 'at_customer' ? 'Pick a visit time' : 'Pick a time'}</h1>
      <div className="day-strip" role="tablist" aria-label="Day">
        {days.map((slots, i) => (
          <button
            key={slots[0]}
            type="button"
            role="tab"
            aria-selected={i === day}
            className="day-chip"
            onClick={() => {
              setDay(i)
              setSlot(null)
            }}
          >
            <span>{fmt(slots[0], tz, { weekday: 'short' })}</span>
            <strong>{fmt(slots[0], tz, { day: 'numeric' })}</strong>
          </button>
        ))}
      </div>
      <p className="fine">
        {fmt(current[0], tz, { weekday: 'long', month: 'long', day: 'numeric' })}
        {sameZone(tz) ? '' : ` · ${tz.replaceAll('_', ' ')} time`}
      </p>
      <div className="slot-grid" role="radiogroup" aria-label="Time">
        {current.map((s) => (
          <button key={s} type="button" role="radio" aria-checked={slot === s} className="slot" onClick={() => setSlot(s)}>
            {fmt(s, tz, { hour: 'numeric', minute: '2-digit' })}
          </button>
        ))}
      </div>
      {state.error && (
        <p className="form-error" role="alert">
          {state.error}
        </p>
      )}
      <button type="button" className="btn btn-primary btn-lg btn-block" disabled={!slot || state.saving} onClick={book}>
        {state.saving ? 'Booking…' : slot ? `Book ${fmt(slot, tz, { weekday: 'short', hour: 'numeric', minute: '2-digit' })}` : 'Select a time'}
      </button>
    </>
  )
}
