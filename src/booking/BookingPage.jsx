// Public booking page at /book/:id: service (and ZIP when the business has a service area) → time → details → booked.
// The shortest path the business's settings allow: a single service with nothing to ask skips straight to times; a
// business with no services asks "What do you need?" with the contact details; a "request" service skips the time.
// Real slots from the business's Google Calendar (for the chosen service's length); the booking creates a real calendar
// event and Google emails the invitation. Branding: the business's own (PublicShell). Funnel stages are reported as codes
// only (server/booking-funnel.js). ?preview=1 (the owner's preview): everything works except booking or sending.
//
// What the page promises a customer on a phone (docs/quality/USABILITY_FINDINGS.md BOOK-01…10):
//   · a step never lets through what a later step or the server refuses (field rules: server/lead-fields.js, shared);
//     one submit marks every problem by its field; no message ever names a field that is not on the screen;
//   · what was chosen and typed survives a reload and a look at another page (sessionStorage: this tab only, no lead
//     token, cleared by "Book another appointment"); so does the confirmation;
//   · every time is shown with its time zone in words; the result of a request that books nothing never shows a time.
import { useEffect, useMemo, useRef, useState } from 'react'
import { api, fmt, noIndex, phoneText } from '../lib/api.js'
import { clean, leadProblems, ZIP_SHAPE_RE } from '../../server/lead-fields.js'
import PublicShell from '../public/PublicShell.jsx'
import { lockoutText, publicHead, telHref, zoneName } from '../public/head.js'
import './booking.css'

const FIELD_ERRORS = {
  invalid_name: 'Please enter your name.',
  invalid_email: 'Please enter a valid email so we can send your calendar invitation.',
  invalid_phone: 'Please enter your phone number with its area code (10 digits).',
  invalid_need: 'Tell us briefly what you need.',
  invalid_answer: 'Please answer the question for this service.',
  invalid_zip: 'Please check your ZIP code: it should be 5 digits.',
  invalid_street: 'Please enter the street address, including the number.',
  invalid_city: 'Please enter the city.',
  invalid_state: 'Please enter the two-letter state, like SC.',
}
const FIELD_OF = { invalid_name: 'name', invalid_email: 'email', invalid_phone: 'phone', invalid_need: 'need', invalid_answer: 'answer', invalid_zip: 'zip', invalid_street: 'street', invalid_city: 'city', invalid_state: 'state' }
const RESULT_STEPS = ['done', 'requested', 'outside']
const minutesLabel = (m) => (m < 60 ? `${m} min` : m % 60 === 0 ? `${m / 60} hr` : `${Math.floor(m / 60)} hr ${m % 60} min`)
const visitId = () => [...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(36).padStart(2, '0')).join('').slice(0, 20)
const zip5 = (v) => String(v || '').trim().slice(0, 5)

// This tab's copy of the visit (BOOK-03, BOOK-05). Never the lead's token; cleared after "Book another appointment".
const STORE = (id) => `gsu_book_${id}`
const readStore = (id) => {
  try {
    const v = JSON.parse(sessionStorage.getItem(STORE(id)) || 'null')
    return v && typeof v === 'object' ? v : null
  } catch {
    return null
  }
}
const writeStore = (id, v) => {
  try {
    if (v) sessionStorage.setItem(STORE(id), JSON.stringify(v))
    else sessionStorage.removeItem(STORE(id))
  } catch {
    // storage unavailable: booking still works, it just won't survive a reload
  }
}

// A booking POST. Like api(), plus the server's Retry-After (seconds) so a lockout can say when to try again.
async function post(path, body) {
  try {
    const res = await fetch(path, { method: 'POST', credentials: 'same-origin', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    return { status: res.status, data: await res.json().catch(() => ({})), retryAfter: Number(res.headers.get('Retry-After')) || 0 }
  } catch {
    return { status: 0, data: { error: 'network_error' }, retryAfter: 0 }
  }
}
// What the first step must have before it lets the customer on: { field: message } (BOOK-02). The fields are the ones
// that step shows: the service choice, its question, the open "What do you need?" and the ZIP.
function firstStepErrors(biz, { choice, zip, need }) {
  const errors = {}
  const service = biz.services.find((s) => s.id === choice.serviceId)
  if (biz.services.length && choice.serviceId === null) errors.service = 'Choose what you need.'
  if (choice.serviceId === '' && clean(choice.other, 500).length < 2) errors.other = FIELD_ERRORS.invalid_need
  if (service?.question?.required && !clean(choice.answer, 300)) errors.answer = FIELD_ERRORS.invalid_answer
  if (!biz.services.length && clean(need, 500).length < 2) errors.need = FIELD_ERRORS.invalid_need
  if (biz.areaCheck && !ZIP_SHAPE_RE.test(zip)) errors.zip = FIELD_ERRORS.invalid_zip
  return errors
}

// One labelled field: the label, the control, and its problem right under it (never at the bottom of the form).
function Field({ id, label, error, className = '', children }) {
  return (
    <div className={`pub-field ${className}`.trim()}>
      <label htmlFor={id}>{label}</label>
      {children}
      <FieldError id={id} error={error} />
    </div>
  )
}
function FieldError({ id, error }) {
  if (!error) return null
  return (
    <p className="pub-field-error" id={`${id}-error`} role="alert">
      {error}
    </p>
  )
}
const invalid = (id, error) => (error ? { 'aria-invalid': true, 'aria-describedby': `${id}-error` } : {})

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
  // { saving, error, errors: { field: message }, unknownZip, at, mismatch: { address, checked } }: what the current
  // screen says. Every move to another step starts clean (go), so no message outlives the screen it was about.
  const [state, setState] = useState({})
  const [skipFirst, setSkipFirst] = useState(false) // nothing to choose or ask first: the page opened on times
  const [area, setArea] = useState(null) // 'in' | 'review': a ZIP the owner must approve first (no times shown)
  const visit = useRef(visitId())
  const sent = useRef(new Set())
  const reachedDetails = useRef(false)
  const focusProblem = useRef(false) // set by a refused submit: focus goes to the first marked field once

  const source = q.get('utm_source') || 'direct'
  const report = (stage, service) => {
    if (preview || sent.current.has(stage)) return
    sent.current.add(stage)
    const device = window.matchMedia('(max-width: 640px)').matches ? 'mobile' : 'desktop'
    fetch(`/api/book/${id}/event`, { method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ stage, visit: visit.current, device, source, ...(service ? { service } : {}) }) }).catch(() => {})
  }
  const go = (next, say = {}) => {
    if (next === 'details') reachedDetails.current = true
    if (say.errors) focusProblem.current = true
    setState(say)
    setStep(next)
  }
  const refuse = (errors) => {
    focusProblem.current = true
    setState({ errors })
  }

  const timesFor = async (data, svc) => {
    if (!svc || svc.minutes === data.slotMinutes) return { slots: data.slots, status: data.status, minutes: data.slotMinutes }
    const r = await api(`/api/book/${id}?service=${encodeURIComponent(svc.id)}`)
    return r.status === 200 ? { slots: r.data.slots, status: r.data.status, minutes: r.data.minutes } : { slots: [], status: 'unavailable', minutes: svc.minutes }
  }

  // After a reload: back to where the customer was, with what they chose and typed, as far as it still holds (the
  // service is still offered, the first step's answers still pass, the time is still open). Returns the step, or null.
  const restoreDraft = async (data, d, nothingFirst) => {
    const c = d?.choice
    if (!c || typeof c !== 'object') return null
    const svc = data.services.find((s) => s.id === c.serviceId) || null
    const only = data.services.length === 1 && !data.allowOther ? data.services[0] : null
    if (!svc && c.serviceId !== null && !(c.serviceId === '' && data.allowOther)) return null // no longer offered: start over
    const picked = { serviceId: c.serviceId === null && only ? only.id : c.serviceId, answer: String(c.answer || ''), other: String(c.other || '') }
    const typed = { name: String(d.form?.name || ''), phone: String(d.form?.phone || ''), email: String(d.form?.email || ''), need: String(d.form?.need || ''), smsConsent: d.form?.smsConsent === true }
    const z = String(d.zip || '')
    setChoice(picked)
    setZip(z)
    setForm((f) => ({ ...f, ...typed }))
    if (d.address && typeof d.address === 'object') setAddress((a) => Object.fromEntries(Object.keys(a).map((k) => [k, String(d.address[k] || '')])))
    if (!['time', 'details'].includes(d.step)) return null
    if (!nothingFirst && Object.keys(firstStepErrors(data, { choice: picked, zip: z, need: typed.need })).length) return null
    if (data.areaCheck && d.area === 'review') {
      setArea('review')
      return 'details'
    }
    if (!nothingFirst) setArea('in')
    if (svc?.flow === 'request') return 'details'
    const t = await timesFor(data, svc)
    setTimes(t)
    if (!t.slots.length) {
      if (d.step !== 'details') return 'time'
      setArea('notimes')
      return 'details'
    }
    if (d.slot && t.slots.includes(d.slot)) {
      setSlot(d.slot)
      return d.step
    }
    if (d.slot) setState({ error: 'The time you chose is no longer open. Please pick another. We kept your details.' })
    return 'time'
  }

  const loadPage = () =>
    api(`/api/book/${id}`).then(async ({ status, data }) => {
      setPage(status === 200 ? { data } : { missing: status === 404, error: status !== 404 })
      if (status !== 200) return
      publicHead(data.brand?.product ? 'Book a call · GetShowUps' : `Book with ${data.name}`, data.brand?.product ? 'Book a call with GetShowUps.' : `Book online with ${data.name}: pick a time that works for you.`)
      setTimes({ slots: data.slots, status: data.status, minutes: data.slotMinutes })
      if (step) return
      const saved = preview ? null : readStore(id)
      // A finished visit (booked / request sent) is shown again after a reload, for the same link it was made from.
      const r = saved?.result
      if (r && RESULT_STEPS.includes(r.kind) && (r.resume || null) === (resume?.leadId || null) && (r.kind !== 'done' || r.booked?.start)) {
        if (r.choice && typeof r.choice === 'object') setChoice({ serviceId: r.choice.serviceId ?? null, answer: String(r.choice.answer || ''), other: String(r.choice.other || '') })
        setForm((f) => ({ ...f, need: String(r.need || '') }))
        setLead({ email: String(r.lead?.email || ''), firstName: String(r.lead?.firstName || ''), street: r.lead?.street ? String(r.lead.street) : null, zip: String(r.lead?.zip || '') })
        if (r.kind === 'done') setBooked({ start: r.booked.start, invited: r.booked.invited })
        setArea(r.area === 'notimes' ? 'notimes' : null)
        setSkipFirst(true)
        return setStep(r.kind)
      }
      if (resume) return setStep('time')
      const one = data.services.length === 1 && !data.allowOther ? data.services[0] : null
      if (one) setChoice((c) => ({ ...c, serviceId: one.id }))
      // Nothing to choose or ask before times: go straight to them (availability first).
      const nothingFirst = !data.areaCheck && (data.services.length === 0 || (one && !one.question && one.flow === 'book'))
      setSkipFirst(Boolean(nothingFirst))
      const back = saved?.draft ? await restoreDraft(data, saved.draft, Boolean(nothingFirst)) : null
      if (back === 'details') reachedDetails.current = true
      setStep(back || (nothingFirst ? 'time' : 'service'))
    })

  useEffect(() => {
    const cleanup = noIndex()
    loadPage().then(() => report('view'))
    return cleanup
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  // Keep this tab's copy current: the draft while booking, then only the result (the typed form is dropped).
  useEffect(() => {
    if (!step || preview || !page.data) return
    if (RESULT_STEPS.includes(step)) {
      const svc = page.data.services.find((s) => s.id === choice.serviceId)
      writeStore(id, {
        result: {
          kind: step,
          resume: resume?.leadId || null,
          booked: booked ? { start: booked.start, invited: booked.invited } : null,
          lead: { email: lead?.email || '', firstName: lead?.firstName || '', street: lead?.street || null, zip: lead?.zip || '' },
          choice: { serviceId: choice.serviceId, answer: choice.answer, other: choice.other },
          need: svc || choice.serviceId === '' ? '' : form.need,
          area,
        },
      })
    } else if (!resume) {
      writeStore(id, { draft: { step, choice, zip, slot, area, address, form: { name: form.name, phone: form.phone, email: form.email, need: form.need, smsConsent: form.smsConsent } } })
    }
  }, [id, preview, page.data, resume, step, choice, zip, slot, form, address, area, booked, lead])

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
  // A refused submit: every problem is marked by its field, and focus goes to the first one (BOOK-09).
  useEffect(() => {
    if (!state.errors || !focusProblem.current) return
    focusProblem.current = false
    const el = panel.current?.querySelector('[aria-invalid="true"]')
    const target = el?.matches('input, textarea, button') ? el : el?.querySelector('button')
    target?.focus()
  }, [state.errors])

  if (page.loading) return <div className="pub" aria-busy="true" />
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

  if (!step) return <div className="pub" aria-busy="true" />
  const biz = page.data
  const tz = biz.timezone
  const visitMode = biz.appointmentMode === 'at_customer'
  const services = biz.services
  const service = services.find((s) => s.id === choice.serviceId) || null
  const isOther = choice.serviceId === ''
  const request = service?.flow === 'request'
  const minutes = service?.minutes || times?.minutes || biz.slotMinutes
  const one = services.length === 1 && !biz.allowOther
  const hadServiceStep = !skipFirst && !resume
  const flowSteps = [...(hadServiceStep && !resume ? ['service'] : []), ...(request || area === 'review' ? [] : ['time']), ...(resume ? [] : ['details'])]
  const stepNo = flowSteps.indexOf(step) + 1
  const product = biz.brand?.product
  const title = product ? `Book a ${minutes}-minute call` : `Book with ${biz.name}`
  const errors = state.errors || {}
  const finished = RESULT_STEPS.includes(step)
  const visitWord = visitMode ? 'visit' : 'appointment'
  // What the customer asked for in their own words (repeated on the confirmation, BOOK-08).
  const asked = clean(isOther ? choice.other : service ? choice.answer : form.need, 500)
  // Where each field lives, so a problem is always shown on the screen that has the field (BOOK-02).
  const stepOfField = (field) => (['service', 'other', 'answer'].includes(field) ? 'service' : field === 'need' ? (hadServiceStep ? 'service' : 'details') : field === 'zip' ? (visitMode ? 'details' : 'service') : 'details')
  const type = (set, field) => (e) => {
    const v = e.target.type === 'checkbox' ? e.target.checked : e.target.value
    set((f) => ({ ...f, [field]: field === 'state' ? v.toUpperCase() : v }))
    // The problem under a field goes once the customer starts fixing it; the others stay until the next submit.
    if (errors[field] || state.mismatch) setState((s) => ({ ...s, mismatch: undefined, errors: s.errors && Object.fromEntries(Object.entries(s.errors).filter(([k]) => k !== field)) }))
  }

  const loadTimes = async (svc) => {
    if (svc && svc.minutes !== biz.slotMinutes) setTimes(null)
    setTimes(await timesFor(biz, svc))
  }
  const refreshTimes = async () => {
    const { status, data } = await api(`/api/book/${id}${service && service.minutes !== biz.slotMinutes ? `?service=${encodeURIComponent(service.id)}` : ''}`)
    if (status === 200) setTimes({ slots: data.slots, status: data.status, minutes: data.minutes })
  }

  // Step 1 → next. With a service area, the ZIP is checked before any time is shown: a ZIP the business doesn't list
  // goes straight to details (the owner decides), as the page always did; an unknown ZIP is confirmed first.
  const continueService = async (e, zipConfirmed = false) => {
    e?.preventDefault()
    const problems = firstStepErrors(biz, { choice, zip, need: form.need })
    if (Object.keys(problems).length) return refuse(problems)
    setState({})
    if (visitMode && biz.areaCheck) setAddress((a) => ({ ...a, zip: zip5(zip) }))
    let review = false
    if (biz.areaCheck && !preview) {
      setState({ saving: true })
      const { status, data } = await api(`/api/book/${id}/area?zip=${encodeURIComponent(zip.trim())}`)
      if (status === 200 && data.area === 'unknown' && !zipConfirmed) return setState({ unknownZip: zip.trim(), at: 'service' })
      review = status === 200 && data.area !== 'in'
    }
    setArea(review ? 'review' : 'in')
    report('service', service?.id)
    if (request || review) {
      setSlot(null) // nothing is booked on this path: no time is shown anywhere
      report('details', service?.id)
      return go('details')
    }
    // A time already chosen stays chosen when it still fits: same visit length, still open (BOOK-06).
    if (slot && times && times.minutes === (service?.minutes || biz.slotMinutes) && times.slots.includes(slot)) return go(reachedDetails.current ? 'details' : 'time')
    loadTimes(service)
    setSlot(null)
    go('time')
  }

  const book = async (l, at = slot) => {
    const { status, data, retryAfter } = await post(`/api/book/${id}/appointment`, { leadId: l.leadId, leadToken: l.leadToken, start: at })
    if (status === 201) {
      report('booked', service?.id)
      setBooked(data)
      return go('done')
    }
    if (data.error === 'slot_unavailable') {
      setSlot(null)
      await refreshTimes()
      return go('time', { error: 'That time was just taken. Please pick another. We kept your details.' })
    }
    if (data.error === 'not_qualified') {
      setSlot(null)
      return go('outside')
    }
    if (data.error === 'already_booked') return setState({ error: 'You already have an appointment booked.' })
    if (status === 429) return setState({ error: lockoutText(retryAfter) })
    setState({ error: 'We couldn’t book that time. Please try again.' })
  }

  // opts.zipConfirmed: keep a ZIP we couldn't find as typed. opts.outsideOk: the customer chose to send their details for
  // an address ZIP the business doesn't book online (BOOK-01): a request, never a booking.
  const submit = async (e, opts = {}) => {
    e?.preventDefault()
    if (preview) return setState({ error: 'This is a preview: booking is off here. Customers book from the same page without ?preview=1.' })
    if (lead) {
      setState({ saving: true })
      await book(lead)
      return setState((s) => ({ ...s, saving: false }))
    }
    const attribution = Object.fromEntries(['utm_source', 'utm_medium', 'utm_campaign', 'gclid'].filter((k) => q.get(k)).map((k) => [k, q.get(k)]))
    const typedZip = (visitMode ? address.zip : zip).trim()
    const fields = { name: form.name, phone: form.phone, email: form.email, need: isOther ? choice.other : services.length ? '' : form.need, ...(visitMode ? { address } : {}) }
    // Every problem at once, by its field, with the server's own rules (server/lead-fields.js).
    const problems = leadProblems({ ...fields, need: service ? 'service' : fields.need }, biz.appointmentMode, { fullNumber: true })
    if (problems.length) {
      const found = Object.fromEntries(problems.map((code) => [FIELD_OF[code], FIELD_ERRORS[code]]))
      const elsewhere = Object.keys(found).find((f) => stepOfField(f) !== 'details')
      return elsewhere ? go(stepOfField(elsewhere), { errors: { [elsewhere]: found[elsewhere] } }) : refuse(found)
    }
    setState({ saving: true })
    // The ZIP in the address is the one that decides (the business visits the address). When it is not the ZIP that
    // was checked, look it up BEFORE anything is sent and let the customer choose (BOOK-01).
    let outside = area === 'review'
    let at = slot
    if (visitMode && biz.areaCheck && area === 'in' && zip5(typedZip) !== zip5(zip)) {
      if (opts.outsideOk) {
        outside = true
        at = null
        setSlot(null)
        setArea('review')
        setZip(zip5(typedZip))
      } else {
        const r = await api(`/api/book/${id}/area?zip=${encodeURIComponent(zip5(typedZip))}`)
        if (r.status !== 200 || r.data.area !== 'in') return setState({ mismatch: { address: zip5(typedZip), checked: zip5(zip) } })
        setZip(zip5(typedZip)) // also a ZIP the business books online: nothing to ask
      }
    }
    const body = {
      ...fields,
      smsConsent: form.smsConsent,
      website: form.website,
      ...(services.length ? { serviceId: choice.serviceId ?? '', answer: choice.answer } : {}),
      ...(biz.askZip ? { zip: typedZip } : {}),
      ...(opts.zipConfirmed || outside ? { zipConfirmed: true } : {}),
      ...(Object.keys(attribution).length ? { attribution } : {}),
    }
    const { status, data, retryAfter } = await post(`/api/book/${id}/lead`, body)
    if (status === 201) {
      const l = { ...data, email: form.email.trim(), firstName: form.name.trim().split(' ')[0], street: visitMode ? address.street.trim() : null, zip: zip5(typedZip) }
      setLead(l)
      if (!data.qualified) {
        setSlot(null)
        return go('outside')
      }
      if (data.flow === 'request' || area === 'notimes') {
        report('requested', service?.id)
        return go('requested')
      }
      if (!at) {
        // Details were left for an area the business turned out to book online: the times, with nothing to type again.
        setArea('in')
        loadTimes(service)
        return go('time')
      }
      await book(l, at)
      return setState((s) => ({ ...s, saving: false }))
    }
    if (data.error === 'unknown_zip') return setState({ unknownZip: typedZip })
    if (data.error === 'service_unavailable' || data.error === 'invalid_service') {
      await loadPage()
      setChoice({ serviceId: null, answer: '', other: '' })
      return go('service', { error: 'That service isn’t offered online any more. Please choose again.' })
    }
    if (status === 429) return setState({ error: lockoutText(retryAfter) })
    const field = FIELD_OF[data.error]
    if (!field) return setState({ error: 'Something went wrong. Please try again.' })
    // The server found a problem the page did not: shown on the screen that has that field.
    if (stepOfField(field) !== 'details') return go(stepOfField(field), { errors: { [field]: FIELD_ERRORS[data.error] } })
    refuse({ [field]: FIELD_ERRORS[data.error] })
  }

  const bookAnother = () => {
    writeStore(id, null)
    window.location.assign(`/book/${id}`)
  }

  const zone = zoneName(tz, slot || booked?.start || Date.now())
  // One real way to reach the business after a result: its phone on record, else its live website or chat page (BOOK-03).
  const call = biz.phone ? (
    <a className="pub-btn pub-btn--quiet" href={telHref(biz.phone)}>
      Call {phoneText(biz.phone)}
    </a>
  ) : biz.reach ? (
    <a className="pub-btn pub-btn--quiet" href={biz.reach.url} target="_blank" rel="noopener" data-reach={biz.reach.kind}>
      {biz.reach.kind === 'website' ? `Visit ${biz.name}’s website` : `Chat with ${biz.name}`}
    </a>
  ) : null
  const summary = (
    <Summary biz={biz} product={product} service={service} isOther={isOther} minutes={minutes} request={request} slot={finished ? null : slot} zone={zone} tz={tz} step={step} onChange={(s) => go(s)} canChangeService={hadServiceStep && !lead} canChangeTime={!request && !booked} />
  )

  return (
    <PublicShell
      name={biz.name}
      brand={biz.brand}
      homeHref={product ? '/' : undefined}
      preview={preview}
      aside={
        biz.phone ? (
          <a className="pub-top-link" href={telHref(biz.phone)}>
            Call {phoneText(biz.phone)}
          </a>
        ) : null
      }
    >
      <div className="bk">
        <aside className="bk-side">{summary}</aside>
        <section ref={panel} className="pub-card bk-panel" key={step}>
          {stepNo > 0 && flowSteps.length > 1 && !finished && (
            <p className="pub-eyebrow">
              Step {stepNo} of {flowSteps.length}
            </p>
          )}

          {step === 'service' && (
            <form className="bk-form" onSubmit={continueService} noValidate>
              <h1 className="pub-h1">{product ? title : one && service ? service.name : 'What can we help with?'}</h1>
              {product && service?.description && <p className="pub-lede">{service.description}</p>}
              {!one && services.length > 0 && (
                <ServicePicker
                  services={services}
                  allowOther={biz.allowOther}
                  choice={choice}
                  setChoice={(c) => {
                    setChoice(c)
                    setState({})
                  }}
                  error={errors.service}
                />
              )}
              {services.length === 0 && (
                <Field id="bk-need" label="What do you need?" error={errors.need}>
                  <textarea id="bk-need" className="pub-input" rows={2} maxLength={500} value={form.need} onChange={type(setForm, 'need')} {...invalid('bk-need', errors.need)} />
                </Field>
              )}
              {service?.question && (
                <Field
                  id="bk-answer"
                  className="bk-reveal"
                  error={errors.answer}
                  label={
                    <>
                      {service.question.label} {!service.question.required && <small>(optional)</small>}
                    </>
                  }
                >
                  <textarea id="bk-answer" className="pub-input" rows={2} maxLength={300} value={choice.answer} onChange={type(setChoice, 'answer')} {...invalid('bk-answer', errors.answer)} />
                </Field>
              )}
              {isOther && (
                <Field id="bk-other" className="bk-reveal" label="Tell us what you need" error={errors.other}>
                  <textarea id="bk-other" className="pub-input" rows={3} maxLength={500} value={choice.other} onChange={type(setChoice, 'other')} {...invalid('bk-other', errors.other)} autoFocus />
                </Field>
              )}
              {biz.areaCheck && (
                <Field
                  id="bk-zip"
                  className="bk-zip"
                  error={errors.zip}
                  label={
                    <>
                      Your ZIP code <small>so we can check we serve your area</small>
                    </>
                  }
                >
                  <input
                    id="bk-zip"
                    className="pub-input"
                    value={zip}
                    onChange={(e) => {
                      setZip(e.target.value)
                      if (errors.zip) setState((s) => ({ ...s, errors: { ...s.errors, zip: undefined } }))
                    }}
                    inputMode="numeric"
                    autoComplete="postal-code"
                    maxLength={10}
                    {...invalid('bk-zip', errors.zip)}
                  />
                </Field>
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
                go('details')
              }}
              onContinue={() => {
                report('time', service?.id)
                if (lead) return submit()
                report('details', service?.id)
                go('details')
              }}
            />
          )}

          {step === 'details' && (
            <form className="bk-form" onSubmit={submit} noValidate>
              <h1 className="pub-h1">{area === 'review' ? 'We may be able to help in your area' : area === 'notimes' ? 'Leave your details' : request ? 'Where should we reply?' : 'Your details'}</h1>
              <p className="pub-lede bk-sub">
                {area === 'review'
                  ? `Leave your details and ${biz.name} will confirm availability for ZIP ${zip5(zip)} with you. No ${visitWord} is booked yet.`
                  : area === 'notimes'
                    ? `${biz.name} will reach out to arrange a time.`
                    : request
                      ? `${biz.name} will get back to you about ${service.name.toLowerCase()}.`
                      : 'We’ll send your calendar invitation to your email.'}
              </p>
              {services.length === 0 && !hadServiceStep && (
                <Field id="bk-need" label="What do you need?" error={errors.need}>
                  <textarea id="bk-need" className="pub-input" rows={2} maxLength={500} required value={form.need} onChange={type(setForm, 'need')} {...invalid('bk-need', errors.need)} />
                </Field>
              )}
              <Field id="bk-name" label="Name" error={errors.name}>
                <input id="bk-name" className="pub-input" value={form.name} onChange={type(setForm, 'name')} maxLength={80} required autoComplete="name" {...invalid('bk-name', errors.name)} />
              </Field>
              <div className="pub-row">
                <Field id="bk-phone" label="Phone" error={errors.phone}>
                  <input id="bk-phone" className="pub-input" type="tel" inputMode="tel" value={form.phone} onChange={type(setForm, 'phone')} maxLength={25} required autoComplete="tel" {...invalid('bk-phone', errors.phone)} />
                </Field>
                <Field id="bk-email" label="Email" error={errors.email}>
                  <input id="bk-email" className="pub-input" type="email" inputMode="email" value={form.email} onChange={type(setForm, 'email')} required autoComplete="email" {...invalid('bk-email', errors.email)} />
                </Field>
              </div>
              {visitMode && (
                <fieldset className="pub-field bk-address">
                  <legend>Service address</legend>
                  <input className="pub-input" aria-label="Street address" placeholder="Street address" value={address.street} onChange={type(setAddress, 'street')} required maxLength={100} autoComplete="address-line1" {...invalid('bk-street', errors.street)} />
                  <FieldError id="bk-street" error={errors.street} />
                  <input className="pub-input" aria-label="Apt, suite (optional)" placeholder="Apt, suite (optional)" value={address.unit} onChange={type(setAddress, 'unit')} maxLength={20} autoComplete="address-line2" />
                  <div className="bk-address-row">
                    <input className="pub-input" aria-label="City" placeholder="City" value={address.city} onChange={type(setAddress, 'city')} required maxLength={60} autoComplete="address-level2" {...invalid('bk-city', errors.city)} />
                    <input className="pub-input" aria-label="State" placeholder="State" value={address.state} onChange={type(setAddress, 'state')} required maxLength={2} autoComplete="address-level1" {...invalid('bk-state', errors.state)} />
                    <input className="pub-input" aria-label="ZIP" placeholder="ZIP" value={address.zip} onChange={type(setAddress, 'zip')} required maxLength={10} inputMode="numeric" autoComplete="postal-code" {...invalid('bk-azip', errors.zip)} />
                  </div>
                  <FieldError id="bk-city" error={errors.city} />
                  <FieldError id="bk-state" error={errors.state} />
                  <FieldError id="bk-azip" error={errors.zip} />
                </fieldset>
              )}
              {biz.offerSms && (
                <label className="pub-check">
                  <input type="checkbox" checked={form.smsConsent} onChange={type(setForm, 'smsConsent')} />
                  <span>
                    Text me about this appointment (confirmation and reminders) from {biz.name} via GetShowUps. Message frequency varies. Msg &amp; data rates may apply. Reply STOP to opt out, HELP for help. Not required to book.{' '}
                    <a href={`/sms-terms/${id}`} target="_blank" rel="noopener">
                      Texting terms
                    </a>{' '}
                    ·{' '}
                    <a href="/privacy" target="_blank" rel="noopener">
                      Privacy
                    </a>
                  </span>
                </label>
              )}
              <input className="bk-hp" tabIndex={-1} autoComplete="off" aria-hidden="true" value={form.website} onChange={type(setForm, 'website')} name="website" />
              {/* On a phone the summary column's notes are not on screen: the owner's notes come before Confirm (BOOK-04). */}
              <GoodToKnow policies={biz.policies} />
              {state.error && (
                <p className="pub-error" role="alert">
                  {state.error}
                </p>
              )}
              {state.unknownZip && state.at !== 'service' && (
                <div className="pub-note" role="alert">
                  <p>We couldn’t find ZIP {state.unknownZip}. Please check it, or continue with it as typed.</p>
                  <button type="button" className="pub-btn pub-btn--quiet" onClick={() => submit(null, { zipConfirmed: true })}>
                    Continue with {state.unknownZip}
                  </button>
                </div>
              )}
              {state.mismatch && (
                <div className="pub-note bk-mismatch" role="alert">
                  <p>
                    <strong>
                      The ZIP in your address ({state.mismatch.address}) is not the ZIP you checked ({state.mismatch.checked}).
                    </strong>{' '}
                    {biz.name} books online for {state.mismatch.checked}. For {state.mismatch.address}, {biz.name} first has to confirm they can come to you, so your {slot ? `${fmt(slot, tz, { weekday: 'short', hour: 'numeric', minute: '2-digit' })} time` : 'time'} would not be booked.
                  </p>
                  <button
                    type="button"
                    className="pub-btn pub-btn--quiet"
                    onClick={() => {
                      setAddress((a) => ({ ...a, zip: state.mismatch.checked }))
                      setState({})
                    }}
                  >
                    Use {state.mismatch.checked} in my address
                  </button>
                  <button type="button" className="pub-btn pub-btn--quiet" disabled={state.saving} onClick={() => submit(null, { outsideOk: true })}>
                    Send my details for {state.mismatch.address} (no time booked)
                  </button>
                </div>
              )}
              {!state.mismatch && (
                <button className="pub-btn pub-btn--primary pub-btn--block" disabled={state.saving}>
                  {state.saving ? 'One moment…' : request || area === 'review' || area === 'notimes' ? 'Send request' : slot ? `Confirm ${fmt(slot, tz, { weekday: 'short', hour: 'numeric', minute: '2-digit' })}` : 'Confirm booking'}
                </button>
              )}
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
                {fmt(booked.start, tz, { weekday: 'long', month: 'long', day: 'numeric' })} · {fmt(booked.start, tz, { hour: 'numeric', minute: '2-digit' })} <span className="bk-zone">{zone}</span>
              </p>
              <ul className="bk-next">
                {service && (
                  <li>
                    {service.name} · {minutesLabel(minutes)}
                    {service.price ? ` · ${service.price}` : ''}
                  </li>
                )}
                {asked && <li>You asked for: “{asked}”</li>}
                {lead?.street && (
                  <li>
                    {biz.name} will visit {lead.street}.
                  </li>
                )}
                {!lead?.street && biz.appointmentMode !== 'at_customer' && biz.address && <li data-business-address>Where: {biz.address}</li>}
                {booked.invited !== false && <li>A calendar invitation is on its way to {lead?.email || 'your email'}.</li>}
                <li>{biz.phone ? `To change or cancel, call ${biz.name}: ${phoneText(biz.phone)}.` : biz.reach ? `To change or cancel, reach ${biz.name} through its ${biz.reach.kind === 'website' ? 'website' : 'chat'}.` : `${biz.name} has your details and will be in touch if anything changes.`}</li>
              </ul>
              <ResultActions call={call} onAnother={bookAnother} label={`Book another ${visitWord}`} />
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
              {asked && <p>You asked for: “{asked}”</p>}
              <ResultActions call={call} onAnother={bookAnother} label="Send another request" />
              <GoodToKnow policies={biz.policies} />
            </div>
          )}

          {step === 'outside' && (
            <div className="bk-done" role="status">
              <h1 className="pub-h1">{lead?.firstName ? `Thanks, ${lead.firstName}` : 'Thanks'}</h1>
              <p className="pub-lede">We may be able to help in your area.</p>
              <p>
                <strong>No {visitWord} is booked yet.</strong> {biz.name} has your details{lead?.zip ? ` for ZIP ${lead.zip}` : ''} and will confirm availability with you. You won’t need to fill this in again.
              </p>
              <ResultActions call={call} onAnother={bookAnother} label="Start a new request" />
            </div>
          )}
        </section>
      </div>
    </PublicShell>
  )
}

// After a result: a tappable way to reach the business (its phone on record), and a fresh start.
function ResultActions({ call, onAnother, label }) {
  if (!call && !onAnother) return null
  return (
    <p className="bk-actions">
      {call}
      {onAnother && (
        <button type="button" className="pub-btn pub-btn--link" onClick={onAnother}>
          {label}
        </button>
      )}
    </p>
  )
}

function Summary({ biz, product, service, isOther, minutes, request, slot, zone, tz, step, onChange, canChangeService, canChangeTime }) {
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
              <small> {zone}</small>
            </dd>
          </div>
        )}
        {biz.appointmentMode === 'at_customer' && (
          <div>
            <dt>Where</dt>
            <dd>At your address</dd>
          </div>
        )}
        {/* The business's own address: sent only when the owner shows it and customers come to the business (BOOK-08). */}
        {biz.appointmentMode !== 'at_customer' && biz.address && (
          <div>
            <dt>Where</dt>
            <dd data-business-address>{biz.address}</dd>
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

function ServicePicker({ services, allowOther, choice, setChoice, error }) {
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
      <ul className="pub-choices" role="radiogroup" aria-labelledby="bk-services" {...invalid('bk-services', error)}>
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
      <FieldError id="bk-services" error={error} />
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
  // The day on screen: the one the customer pressed, else the day of the time already chosen (BOOK-07), else the first.
  const [pressed, setDay] = useState(null)
  const chosen = slot ? days.findIndex((d) => d.includes(slot)) : -1
  const day = Math.min(pressed ?? Math.max(chosen, 0), Math.max(days.length - 1, 0))
  const strip = useRef(null)
  useEffect(() => {
    // Bring the shown day into view inside the day strip (never scrolls the page).
    const row = strip.current
    const el = row?.querySelector('[aria-pressed="true"]')
    if (row && el && (el.offsetLeft < row.scrollLeft || el.offsetLeft + el.offsetWidth > row.scrollLeft + row.clientWidth)) row.scrollLeft = Math.max(0, el.offsetLeft - 8)
  }, [day, days.length])
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
  const current = days[day]
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
      <p className="pub-fine bk-zone-note">Times are in {zoneName(tz, current[0])}.</p>
      <div className="bk-days" role="group" aria-label="Day" ref={strip}>
        {days.map((slots, i) => (
          <button
            key={slots[0]}
            type="button"
            aria-pressed={i === day}
            className="bk-day"
            onClick={() => {
              if (i === day) return
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
