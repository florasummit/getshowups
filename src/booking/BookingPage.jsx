// Public booking page at /book/:id: service (and ZIP when the business has a service area) → time → details → booked.
// The shortest path the business's settings allow: a single service with nothing to ask skips straight to times; a
// business with no services asks "What do you need?" with the contact details; a "request" service skips the time.
// Real slots from the business's Google Calendar (for the chosen service's length); the booking creates a real calendar
// event and Google emails the invitation. Branding: the business's own (PublicShell). Funnel stages are reported as codes
// only (server/booking-funnel.js). ?preview=1 (the owner's preview): everything works except booking or sending.
import { useEffect, useMemo, useRef, useState } from 'react'
import { api, fmt, noIndex } from '../lib/api.js'
import PublicShell from '../public/PublicShell.jsx'
import './booking.css'

const FIELD_ERRORS = {
  invalid_name: 'Please enter your name.',
  invalid_email: 'Please enter a valid email so we can send your calendar invitation.',
  invalid_phone: 'Please enter a valid phone number.',
  invalid_need: 'Tell us briefly what you need.',
  invalid_answer: 'Please answer the question for this service.',
  invalid_zip: 'Please check your ZIP code: it should be 5 digits.',
  invalid_street: 'Please enter the street address, including the number.',
  invalid_city: 'Please enter the city.',
  invalid_state: 'Please enter the two-letter state, like SC.',
  rate_limited: 'Too many attempts. Please wait a few minutes and try again.',
}
const FIELD_OF = { invalid_name: 'name', invalid_email: 'email', invalid_phone: 'phone', invalid_need: 'need', invalid_answer: 'answer', invalid_zip: 'zip', invalid_street: 'street', invalid_city: 'city', invalid_state: 'state' }
const minutesLabel = (m) => (m < 60 ? `${m} min` : m % 60 === 0 ? `${m / 60} hr` : `${Math.floor(m / 60)} hr ${m % 60} min`)
const sameZone = (tz) => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone === tz
  } catch {
    return false
  }
}
const visitId = () => [...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(36).padStart(2, '0')).join('').slice(0, 20)

export default function BookingPage({ id }) {
  const q = useMemo(() => new URLSearchParams(window.location.search), [])
  const preview = q.get('preview') === '1'
  const [page, setPage] = useState({ loading: true })
  const [resume] = useState(() => (q.get('lead') && q.get('k') ? { leadId: q.get('lead'), leadToken: q.get('k'), qualified: true, flow: 'book' } : null))
  const [step, setStep] = useState(null)
  const [choice, setChoice] = useState({ serviceId: null, answer: '', other: '' })
  const [zip, setZip] = useState('')
  const [times, setTimes] = useState(null) // { slots, status, minutes } for the chosen service
  const [slot, setSlot] = useState(null)
  const [form, setForm] = useState({ name: '', phone: '', email: '', need: '', website: '', smsConsent: false })
  const [address, setAddress] = useState({ street: '', unit: '', city: '', state: '', zip: '' })
  const [lead, setLead] = useState(resume)
  const [booked, setBooked] = useState(null)
  const [state, setState] = useState({})
  const [area, setArea] = useState(null) // 'in' | 'review': a ZIP the owner must approve first (no times shown)
  const visit = useRef(visitId())
  const sent = useRef(new Set())

  const source = q.get('utm_source') || 'direct'
  const report = (stage, service) => {
    if (preview || sent.current.has(stage)) return
    sent.current.add(stage)
    const device = window.matchMedia('(max-width: 640px)').matches ? 'mobile' : 'desktop'
    fetch(`/api/book/${id}/event`, { method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ stage, visit: visit.current, device, source, ...(service ? { service } : {}) }) }).catch(() => {})
  }

  const loadPage = () =>
    api(`/api/book/${id}`).then(({ status, data }) => {
      setPage(status === 200 ? { data } : { missing: status === 404, error: status !== 404 })
      if (status !== 200) return
      document.title = data.brand?.product ? 'Book a call · GetShowUps' : `Book with ${data.name}`
      setTimes({ slots: data.slots, status: data.status, minutes: data.minutes })
      if (step) return
      if (resume) return setStep('time')
      const one = data.services.length === 1 && !data.allowOther ? data.services[0] : null
      if (one) setChoice((c) => ({ ...c, serviceId: one.id }))
      // Nothing to choose or ask before times: go straight to them (availability first).
      const nothingFirst = !data.areaCheck && (data.services.length === 0 || (one && !one.question && one.flow === 'book'))
      setStep(nothingFirst ? 'time' : 'service')
    })

  useEffect(() => {
    const cleanup = noIndex()
    loadPage().then(() => report('view'))
    return cleanup
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  // After a step change, move focus to the new heading so keyboard and screen-reader users land on it.
  const panel = useRef(null)
  const first = useRef(true)
  useEffect(() => {
    if (!step) return
    if (first.current) {
      first.current = false
      return
    }
    const h = panel.current?.querySelector('h1')
    if (h) {
      h.tabIndex = -1
      h.focus({ preventScroll: true })
      window.scrollTo(0, 0)
    }
  }, [step])

  if (page.loading || !step) return <div className="pub" aria-busy="true" />
  if (page.missing || page.error) {
    return (
      <PublicShell name="" brand={null} footer={false}>
        <section className="pub-card bk-message">
          <h1 className="pub-h1">{page.missing ? 'This booking page isn’t available' : 'We can’t load times right now'}</h1>
          <p className="pub-lede">{page.missing ? 'Check the link and try again.' : 'Please try again in a moment.'}</p>
          {!page.missing && (
            <button type="button" className="pub-btn pub-btn--primary" onClick={loadPage}>
              Try again
            </button>
          )}
        </section>
      </PublicShell>
    )
  }

  const biz = page.data
  const tz = biz.timezone
  const visitMode = biz.appointmentMode === 'at_customer'
  const services = biz.services
  const service = services.find((s) => s.id === choice.serviceId) || null
  const isOther = choice.serviceId === ''
  const request = service?.flow === 'request'
  const minutes = service?.minutes || times?.minutes || biz.slotMinutes
  const one = services.length === 1 && !biz.allowOther
  const hadServiceStep = !(step === 'time' && !lead && !choice.serviceId && services.length === 0 && !biz.areaCheck) && !(one && !service?.question && !biz.areaCheck && !request)
  const flowSteps = [...(hadServiceStep && !resume ? ['service'] : []), ...(request || area === 'review' ? [] : ['time']), ...(resume ? [] : ['details'])]
  const stepNo = flowSteps.indexOf(step) + 1
  const product = biz.brand?.product
  const title = product ? `Book a ${minutes}-minute call` : `Book with ${biz.name}`

  const loadTimes = async (svc) => {
    const wanted = svc && svc.minutes !== biz.slotMinutes ? svc.id : null
    if (!wanted) return setTimes({ slots: biz.slots, status: biz.status, minutes: biz.slotMinutes })
    setTimes(null)
    const { status, data } = await api(`/api/book/${id}?service=${encodeURIComponent(wanted)}`)
    setTimes(status === 200 ? { slots: data.slots, status: data.status, minutes: data.minutes } : { slots: [], status: 'unavailable', minutes: svc.minutes })
  }
  const refreshTimes = async () => {
    const { status, data } = await api(`/api/book/${id}${service && service.minutes !== biz.slotMinutes ? `?service=${encodeURIComponent(service.id)}` : ''}`)
    if (status === 200) setTimes({ slots: data.slots, status: data.status, minutes: data.minutes })
  }

  // Step 1 → next. With a service area, the ZIP is checked before any time is shown: a ZIP the business doesn't list
  // goes straight to details (the owner decides), as the page always did; an unknown ZIP is confirmed first.
  const continueService = async (e, zipConfirmed = false) => {
    e?.preventDefault()
    if (choice.serviceId === null && services.length) return setState({ error: 'Choose what you need.', field: 'service' })
    if (isOther && !choice.other.trim()) return setState({ error: 'Tell us briefly what you need.', field: 'other' })
    if (service?.question?.required && !choice.answer.trim()) return setState({ error: FIELD_ERRORS.invalid_answer, field: 'answer' })
    if (biz.areaCheck && !/^\d{5}(-\d{4})?$/.test(zip.trim())) return setState({ error: FIELD_ERRORS.invalid_zip, field: 'zip' })
    setState({})
    if (visitMode && biz.areaCheck) setAddress((a) => ({ ...a, zip: zip.trim().slice(0, 5) }))
    let review = false
    if (biz.areaCheck && !preview) {
      setState({ saving: true })
      const { status, data } = await api(`/api/book/${id}/area?zip=${encodeURIComponent(zip.trim())}`)
      if (status === 200 && data.area === 'unknown' && !zipConfirmed) return setState({ unknownZip: zip.trim(), at: 'service' })
      review = status === 200 && data.area !== 'in'
      setState({})
    }
    setArea(review ? 'review' : 'in')
    report('service', service?.id)
    if (request || review) {
      report('details', service?.id)
      return setStep('details')
    }
    loadTimes(service)
    setSlot(null)
    setStep('time')
  }

  const book = async (l) => {
    const { status, data } = await api(`/api/book/${id}/appointment`, { method: 'POST', body: { leadId: l.leadId, leadToken: l.leadToken, start: slot } })
    if (status === 201) {
      report('booked', service?.id)
      setBooked(data)
      return setStep('done')
    }
    if (data.error === 'slot_unavailable') {
      setSlot(null)
      await refreshTimes()
      setState({ error: 'That time was just taken. Please pick another. We kept your details.' })
      return setStep('time')
    }
    if (data.error === 'not_qualified') return setStep('outside')
    if (data.error === 'already_booked') return setState({ error: 'You already have an appointment booked.' })
    if (data.error === 'rate_limited') return setState({ error: FIELD_ERRORS.rate_limited })
    setState({ error: 'We couldn’t book that time. Please try again.' })
  }

  const submit = async (e, zipConfirmed = false) => {
    e?.preventDefault()
    if (preview) return setState({ error: 'This is a preview: booking is off here. Customers book from the same page without ?preview=1.' })
    setState({ saving: true })
    if (lead) {
      await book(lead)
      return setState((s) => ({ ...s, saving: false }))
    }
    const attribution = Object.fromEntries(['utm_source', 'utm_medium', 'utm_campaign', 'gclid'].filter((k) => q.get(k)).map((k) => [k, q.get(k)]))
    const typedZip = (visitMode ? address.zip : zip).trim()
    const body = {
      name: form.name,
      phone: form.phone,
      email: form.email,
      smsConsent: form.smsConsent,
      website: form.website,
      need: isOther ? choice.other : services.length ? '' : form.need,
      ...(services.length ? { serviceId: choice.serviceId ?? '', answer: choice.answer } : {}),
      ...(biz.askZip ? { zip: typedZip } : {}),
      ...(visitMode ? { address } : {}),
      ...(zipConfirmed || area === 'review' ? { zipConfirmed: true } : {}),
      ...(Object.keys(attribution).length ? { attribution } : {}),
    }
    const { status, data } = await api(`/api/book/${id}/lead`, { method: 'POST', body })
    if (status === 201) {
      const l = { ...data, email: form.email.trim(), firstName: form.name.trim().split(' ')[0], street: visitMode ? address.street.trim() : null, zip: typedZip.slice(0, 5) }
      setLead(l)
      if (!data.qualified) return setStep('outside')
      if (data.flow === 'request' || area === 'notimes') {
        report('requested', service?.id)
        return setStep('requested')
      }
      await book(l)
      return setState((s) => ({ ...s, saving: false }))
    }
    if (data.error === 'unknown_zip') return setState({ unknownZip: typedZip })
    if (data.error === 'service_unavailable' || data.error === 'invalid_service') {
      await loadPage()
      setChoice({ serviceId: null, answer: '', other: '' })
      setState({ error: 'That service isn’t offered online any more. Please choose again.' })
      return setStep('service')
    }
    setState({ error: FIELD_ERRORS[data.error] || 'Something went wrong. Please try again.', field: FIELD_OF[data.error] })
  }

  const summary = (
    <Summary biz={biz} product={product} service={service} isOther={isOther} minutes={minutes} request={request} slot={slot} tz={tz} step={step} onChange={(s) => setStep(s)} canChangeService={hadServiceStep && !lead} canChangeTime={!request && !booked} />
  )

  return (
    <PublicShell name={biz.name} brand={biz.brand} homeHref={product ? '/' : undefined} preview={preview}>
      <div className="bk">
        <aside className="bk-side">{summary}</aside>
        <section ref={panel} className="pub-card bk-panel" key={step}>
          {stepNo > 0 && flowSteps.length > 1 && !['done', 'requested', 'outside'].includes(step) && (
            <p className="pub-eyebrow">
              Step {stepNo} of {flowSteps.length}
            </p>
          )}

          {step === 'service' && (
            <form className="bk-form" onSubmit={continueService} noValidate>
              <h1 className="pub-h1">{product ? title : one && service ? service.name : 'What can we help with?'}</h1>
              {product && service?.description && <p className="pub-lede">{service.description}</p>}
              {!one && services.length > 0 && <ServicePicker services={services} allowOther={biz.allowOther} choice={choice} setChoice={(c) => { setChoice(c); setState({}) }} invalid={state.field === 'service'} />}
              {services.length === 0 && (
                <label className="pub-field">
                  <span>What do you need?</span>
                  <textarea className="pub-input" rows={2} maxLength={500} value={form.need} onChange={(e) => setForm((f) => ({ ...f, need: e.target.value }))} aria-invalid={state.field === 'need'} />
                </label>
              )}
              {service?.question && (
                <label className="pub-field bk-reveal">
                  <span>
                    {service.question.label} {!service.question.required && <small>(optional)</small>}
                  </span>
                  <textarea className="pub-input" rows={2} maxLength={300} value={choice.answer} onChange={(e) => setChoice((c) => ({ ...c, answer: e.target.value }))} aria-invalid={state.field === 'answer'} />
                </label>
              )}
              {isOther && (
                <label className="pub-field bk-reveal">
                  <span>Tell us what you need</span>
                  <textarea className="pub-input" rows={3} maxLength={500} value={choice.other} onChange={(e) => setChoice((c) => ({ ...c, other: e.target.value }))} aria-invalid={state.field === 'other'} autoFocus />
                </label>
              )}
              {biz.areaCheck && (
                <label className="pub-field bk-zip">
                  <span>
                    Your ZIP code <small>so we can check we serve your area</small>
                  </span>
                  <input className="pub-input" value={zip} onChange={(e) => setZip(e.target.value)} inputMode="numeric" autoComplete="postal-code" maxLength={10} aria-invalid={state.field === 'zip'} />
                </label>
              )}
              {state.error && (
                <p className="pub-error" role="alert">
                  {state.error}
                </p>
              )}
              {state.unknownZip && state.at === 'service' && state.unknownZip === zip.trim() && (
                <div className="pub-note" role="alert">
                  <p>We couldn’t find ZIP {state.unknownZip}. Please check it, or continue with it as typed.</p>
                  <button type="button" className="pub-btn pub-btn--quiet" onClick={() => continueService(null, true)}>
                    Continue with {state.unknownZip}
                  </button>
                </div>
              )}
              <button className="pub-btn pub-btn--primary pub-btn--block" disabled={state.saving}>
                {request ? 'Continue to your details' : 'See open times'}
              </button>
            </form>
          )}

          {step === 'time' && (
            <PickTime
              biz={biz}
              times={times}
              slot={slot}
              setSlot={(s) => {
                setSlot(s)
                setState({})
              }}
              error={state.error}
              saving={state.saving}
              resume={Boolean(lead)}
              visitMode={visitMode}
              onNoTimes={() => {
                setArea('notimes')
                report('details', service?.id)
                setStep('details')
              }}
              onContinue={() => {
                report('time', service?.id)
                if (lead) return submit()
                report('details', service?.id)
                setStep('details')
              }}
            />
          )}

          {step === 'details' && (
            <form className="bk-form" onSubmit={submit} noValidate>
              <h1 className="pub-h1">{area === 'review' ? 'We may be able to help in your area' : area === 'notimes' ? 'Leave your details' : request ? 'Where should we reply?' : 'Your details'}</h1>
              <p className="pub-lede bk-sub">
                {area === 'review'
                  ? `Leave your details and ${biz.name} will confirm availability for ZIP ${zip.trim()} with you.`
                  : area === 'notimes'
                    ? `${biz.name} will reach out to arrange a time.`
                    : request
                    ? `${biz.name} will get back to you about ${service.name.toLowerCase()}.`
                    : 'We’ll send your calendar invitation to your email.'}
              </p>
              {services.length === 0 && !hadServiceStep && (
                <label className="pub-field">
                  <span>What do you need?</span>
                  <textarea className="pub-input" rows={2} maxLength={500} required value={form.need} onChange={(e) => setForm((f) => ({ ...f, need: e.target.value }))} aria-invalid={state.field === 'need'} />
                </label>
              )}
              <label className="pub-field">
                <span>Name</span>
                <input className="pub-input" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} maxLength={80} required autoComplete="name" aria-invalid={state.field === 'name'} />
              </label>
              <div className="pub-row">
                <label className="pub-field">
                  <span>Phone</span>
                  <input className="pub-input" type="tel" inputMode="tel" value={form.phone} onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))} required autoComplete="tel" aria-invalid={state.field === 'phone'} />
                </label>
                <label className="pub-field">
                  <span>Email</span>
                  <input className="pub-input" type="email" inputMode="email" value={form.email} onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} required autoComplete="email" aria-invalid={state.field === 'email'} />
                </label>
              </div>
              {visitMode && (
                <fieldset className="pub-field bk-address">
                  <legend>Service address</legend>
                  <input className="pub-input" aria-label="Street address" placeholder="Street address" value={address.street} onChange={(e) => setAddress((a) => ({ ...a, street: e.target.value }))} required maxLength={100} autoComplete="address-line1" aria-invalid={state.field === 'street'} />
                  <input className="pub-input" aria-label="Apt, suite (optional)" placeholder="Apt, suite (optional)" value={address.unit} onChange={(e) => setAddress((a) => ({ ...a, unit: e.target.value }))} maxLength={20} autoComplete="address-line2" />
                  <div className="bk-address-row">
                    <input className="pub-input" aria-label="City" placeholder="City" value={address.city} onChange={(e) => setAddress((a) => ({ ...a, city: e.target.value }))} required maxLength={60} autoComplete="address-level2" aria-invalid={state.field === 'city'} />
                    <input className="pub-input" aria-label="State" placeholder="State" value={address.state} onChange={(e) => setAddress((a) => ({ ...a, state: e.target.value.toUpperCase() }))} required maxLength={2} autoComplete="address-level1" aria-invalid={state.field === 'state'} />
                    <input className="pub-input" aria-label="ZIP" placeholder="ZIP" value={address.zip} onChange={(e) => setAddress((a) => ({ ...a, zip: e.target.value }))} required maxLength={10} inputMode="numeric" autoComplete="postal-code" aria-invalid={state.field === 'zip'} />
                  </div>
                </fieldset>
              )}
              {biz.offerSms && (
                <label className="pub-check">
                  <input type="checkbox" checked={form.smsConsent} onChange={(e) => setForm((f) => ({ ...f, smsConsent: e.target.checked }))} />
                  <span>
                    Text me about this appointment (confirmation and reminders) from {biz.name} via GetShowUps. Message frequency varies. Msg &amp; data rates may apply. Reply STOP to opt out, HELP for help. Not required to book. <a href={`/sms-terms/${id}`}>Texting terms</a> · <a href="/privacy">Privacy</a>
                  </span>
                </label>
              )}
              <input className="bk-hp" tabIndex={-1} autoComplete="off" aria-hidden="true" value={form.website} onChange={(e) => setForm((f) => ({ ...f, website: e.target.value }))} name="website" />
              {state.error && (
                <p className="pub-error" role="alert">
                  {state.error}
                </p>
              )}
              {state.unknownZip && state.at !== 'service' && (
                <div className="pub-note" role="alert">
                  <p>We couldn’t find ZIP {state.unknownZip}. Please check it, or continue with it as typed.</p>
                  <button type="button" className="pub-btn pub-btn--quiet" onClick={() => submit(null, true)}>
                    Continue with {state.unknownZip}
                  </button>
                </div>
              )}
              <button className="pub-btn pub-btn--primary pub-btn--block" disabled={state.saving}>
                {state.saving ? 'One moment…' : request || area === 'review' || area === 'notimes' ? 'Send request' : slot ? `Confirm ${fmt(slot, tz, { weekday: 'short', hour: 'numeric', minute: '2-digit' })}` : 'Confirm booking'}
              </button>
            </form>
          )}

          {step === 'done' && (
            <div className="bk-done" role="status">
              <span className="bk-done-mark" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="22" height="22">
                  <path d="m6 12.5 4 4 8-9" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </span>
              <h1 className="pub-h1">{visitMode ? 'Visit booked' : 'You’re booked'}</h1>
              <p className="bk-done-when">
                {fmt(booked.start, tz, { weekday: 'long', month: 'long', day: 'numeric' })} · {fmt(booked.start, tz, { hour: 'numeric', minute: '2-digit' })}
                {sameZone(tz) ? '' : ` (${tz.replaceAll('_', ' ')})`}
              </p>
              <ul className="bk-next">
                {service && (
                  <li>
                    {service.name} · {minutesLabel(minutes)}
                  </li>
                )}
                {lead?.street && (
                  <li>
                    {biz.name} will visit {lead.street}.
                  </li>
                )}
                {booked.invited !== false && <li>A calendar invitation is on its way to {lead?.email || 'your email'}.</li>}
                <li>To change or cancel, contact {biz.name}{/[.!?]$/.test(biz.name) ? '' : '.'}</li>
              </ul>
              <GoodToKnow policies={biz.policies} />
            </div>
          )}

          {step === 'requested' && (
            <div className="bk-done" role="status">
              <span className="bk-done-mark" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="22" height="22">
                  <path d="m6 12.5 4 4 8-9" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </span>
              <h1 className="pub-h1">Request sent</h1>
              <p className="pub-lede">
                {biz.name} has your request{service ? ` for ${service.name.toLowerCase()}` : ''} and will {area === 'notimes' ? 'reach out to arrange a time' : 'get back to you'}. You won’t need to fill this in again.
              </p>
              <GoodToKnow policies={biz.policies} />
            </div>
          )}

          {step === 'outside' && (
            <div className="bk-done" role="status">
              <h1 className="pub-h1">Thanks, {lead?.firstName}</h1>
              <p className="pub-lede">We may be able to help in your area.</p>
              <p>
                {biz.name} has your details{lead?.zip ? ` for ZIP ${lead.zip}` : ''} and will confirm availability with you. You won’t need to fill this in again.
              </p>
            </div>
          )}
        </section>
      </div>
    </PublicShell>
  )
}

function Summary({ biz, product, service, isOther, minutes, request, slot, tz, step, onChange, canChangeService, canChangeTime }) {
  const tzLabel = sameZone(tz) ? '' : tz.replaceAll('_', ' ')
  return (
    <div className="bk-summary">
      <p className="pub-eyebrow bk-summary-eyebrow">Your booking</p>
      <h2 className="bk-summary-title">{service ? (product ? `${service.name} with the founder` : service.name) : isOther ? 'Other / Not sure' : biz.appointmentMode === 'at_customer' ? 'A visit' : 'An appointment'}</h2>
      <dl className="bk-facts">
        {!request && (
          <div>
            <dt>Length</dt>
            <dd>{minutesLabel(minutes)}</dd>
          </div>
        )}
        {service?.price && (
          <div>
            <dt>Price</dt>
            <dd>{service.price}</dd>
          </div>
        )}
        {slot && (
          <div>
            <dt>Time</dt>
            <dd>
              {fmt(slot, tz, { weekday: 'short', month: 'short', day: 'numeric' })}, {fmt(slot, tz, { hour: 'numeric', minute: '2-digit' })}
              {tzLabel && <small> {tzLabel}</small>}
            </dd>
          </div>
        )}
        {biz.appointmentMode === 'at_customer' && (
          <div>
            <dt>Where</dt>
            <dd>At your address</dd>
          </div>
        )}
      </dl>
      {(canChangeService || (canChangeTime && slot)) && ['time', 'details'].includes(step) && (
        <p className="bk-change">
          {canChangeService && (
            <button type="button" className="pub-btn pub-btn--link" onClick={() => onChange('service')}>
              {biz.services.length ? 'Change service' : 'Change request'}
            </button>
          )}
          {canChangeTime && slot && step === 'details' && (
            <button type="button" className="pub-btn pub-btn--link" onClick={() => onChange('time')}>
              Change time
            </button>
          )}
        </p>
      )}
      <GoodToKnow policies={biz.policies} compact />
    </div>
  )
}

function ServicePicker({ services, allowOther, choice, setChoice, invalid }) {
  const [filter, setFilter] = useState('')
  const long = services.length > 6
  const shown = long && filter.trim() ? services.filter((s) => `${s.name} ${s.description}`.toLowerCase().includes(filter.trim().toLowerCase())) : services
  const pick = (serviceId) => setChoice({ serviceId, answer: serviceId === choice.serviceId ? choice.answer : '', other: choice.other })
  const keys = (e, i, list) => {
    const n = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1 : 0
    if (!n) return
    e.preventDefault()
    const next = (i + n + list.length) % list.length
    pick(list[next])
    e.currentTarget.parentElement.parentElement.querySelectorAll('[role=radio]')[next]?.focus()
  }
  const ids = [...shown.map((s) => s.id), ...(allowOther ? [''] : [])]
  return (
    <div className="pub-field">
      <span id="bk-services">Service</span>
      {long && (
        <input className="pub-input" type="search" placeholder={`Search ${services.length} services`} aria-label="Search services" value={filter} onChange={(e) => setFilter(e.target.value)} />
      )}
      <ul className="pub-choices" role="radiogroup" aria-labelledby="bk-services" aria-invalid={invalid}>
        {shown.map((s, i) => (
          <li key={s.id}>
            <button type="button" role="radio" aria-checked={choice.serviceId === s.id} tabIndex={choice.serviceId === s.id || (choice.serviceId === null && i === 0) ? 0 : -1} className="pub-choice" onClick={() => pick(s.id)} onKeyDown={(e) => keys(e, i, ids)}>
              <span className="pub-choice-name">{s.name}</span>
              {s.price ? <span className="pub-choice-price">{s.price}</span> : <span />}
              {s.description && <span className="pub-choice-desc">{s.description}</span>}
              <span className="pub-choice-meta">{s.flow === 'request' ? 'Request a quote' : minutesLabel(s.minutes)}</span>
            </button>
          </li>
        ))}
        {long && filter && !shown.length && <li className="pub-fine">No service matches “{filter}”.</li>}
        {allowOther && (
          <li>
            <button type="button" role="radio" aria-checked={choice.serviceId === ''} tabIndex={choice.serviceId === '' ? 0 : -1} className="pub-choice" onClick={() => pick('')} onKeyDown={(e) => keys(e, ids.length - 1, ids)}>
              <span className="pub-choice-name">Other / Not sure</span>
              <span />
              <span className="pub-choice-desc">Describe what you need</span>
            </button>
          </li>
        )}
      </ul>
    </div>
  )
}

function PickTime({ biz, times, slot, setSlot, error, saving, resume, visitMode, onContinue, onNoTimes }) {
  const tz = biz.timezone
  const days = useMemo(() => {
    const map = new Map()
    for (const s of times?.slots || []) {
      const key = fmt(s, tz, { year: 'numeric', month: '2-digit', day: '2-digit' })
      if (!map.has(key)) map.set(key, [])
      map.get(key).push(s)
    }
    return [...map.values()]
  }, [times, tz])
  const [day, setDay] = useState(0)
  if (!times) return <div className="bk-loading" aria-busy="true" aria-label="Loading open times" />
  if (!days.length) {
    // No time to offer (calendar unreachable, or fully booked): the request is still taken, never lost.
    const outage = times.status === 'unavailable'
    return (
      <div className="bk-form">
        <h1 className="pub-h1">{outage ? 'Online booking isn’t available right now' : 'No open times in the next two weeks'}</h1>
        {resume ? (
          <p className="pub-lede">{biz.name} has your request and will reach out to arrange a time.</p>
        ) : (
          <>
            <p className="pub-lede">Leave your details and {biz.name} will reach out to arrange a time.</p>
            <button type="button" className="pub-btn pub-btn--primary pub-btn--block" onClick={onNoTimes}>
              Leave your details
            </button>
          </>
        )}
      </div>
    )
  }
  const current = days[Math.min(day, days.length - 1)]
  const part = (h) => (h < 12 ? 'Morning' : h < 17 ? 'Afternoon' : 'Evening')
  const groups = []
  for (const s of current) {
    const h = Number(fmt(s, tz, { hour: 'numeric', hour12: false }))
    const g = part(h % 24)
    if (!groups.length || groups[groups.length - 1].label !== g) groups.push({ label: g, slots: [] })
    groups[groups.length - 1].slots.push(s)
  }
  return (
    <div className="bk-form">
      <h1 className="pub-h1">{visitMode ? 'Pick a visit time' : 'Pick a time'}</h1>
      {!sameZone(tz) && <p className="pub-fine">Times are in {tz.replaceAll('_', ' ')} time.</p>}
      <div className="bk-days" role="group" aria-label="Day">
        {days.map((slots, i) => (
          <button
            key={slots[0]}
            type="button"
            aria-pressed={i === day}
            className="bk-day"
            onClick={() => {
              setDay(i)
              setSlot(null)
            }}
          >
            <span>{fmt(slots[0], tz, { weekday: 'short' })}</span>
            <strong>{fmt(slots[0], tz, { day: 'numeric' })}</strong>
            <small>{fmt(slots[0], tz, { month: 'short' })}</small>
          </button>
        ))}
      </div>
      <p className="bk-day-label">{fmt(current[0], tz, { weekday: 'long', month: 'long', day: 'numeric' })}</p>
      {groups.map((g) => (
        <div key={g.label} className="bk-slot-group" role="group" aria-label={g.label}>
          <p className="pub-fine">{g.label}</p>
          <div className="bk-slots">
            {g.slots.map((s) => (
              <button key={s} type="button" aria-pressed={slot === s} className="bk-slot" onClick={() => setSlot(s)}>
                {fmt(s, tz, { hour: 'numeric', minute: '2-digit' })}
              </button>
            ))}
          </div>
        </div>
      ))}
      {error && (
        <p className="pub-error" role="alert">
          {error}
        </p>
      )}
      <div className="bk-sticky">
        <button type="button" className="pub-btn pub-btn--primary pub-btn--block" disabled={!slot || saving} onClick={onContinue}>
          {saving ? 'Booking…' : !slot ? 'Choose a time' : resume ? `Book ${fmt(slot, tz, { weekday: 'short', hour: 'numeric', minute: '2-digit' })}` : `Continue with ${fmt(slot, tz, { weekday: 'short', hour: 'numeric', minute: '2-digit' })}`}
        </button>
      </div>
    </div>
  )
}

// Owner-written notes (Settings → What customers should know). Plain text; React escapes it.
function GoodToKnow({ policies, compact = false }) {
  if (!policies?.beforeVisit && !policies?.cancellation) return null
  return (
    <section className={`bk-good${compact ? ' bk-good--compact' : ''}`} aria-label="Good to know">
      <p className="pub-h2">Good to know</p>
      {policies.beforeVisit && (
        <p>
          <strong>Before your appointment: </strong>
          {policies.beforeVisit}
        </p>
      )}
      {policies.cancellation && (
        <p>
          <strong>Cancellations: </strong>
          {policies.cancellation}
        </p>
      )}
    </section>
  )
}
