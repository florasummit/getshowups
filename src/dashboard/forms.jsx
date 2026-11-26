// Business and booking-hours forms, shared by setup and settings.
import { useEffect, useRef, useState } from 'react'
import { LoadError, SaveBar, SaveStatus } from './ui.jsx'
import { useSaveState } from './ui-hooks.js'
import AiWrite from './AiWrite.jsx'
import { api, browserTimeZone, DAY_SHORT, timeZones } from '../lib/api.js'
import { suggestionsFor } from '../content/service-suggestions.js'
import { plural } from '../lib/format.js'
import { oddZips, US_ZONES } from './owner-lib.js'

// A settings save refused because the saved values changed elsewhere (another tab or device) since this page loaded.
const CHANGED_ELSEWHERE = 'These settings were changed somewhere else (another tab or device) since this page opened, so this change wasn’t saved. Reload the page to see the latest, then make your change again.'

const ERRORS = {
  invalid_name: 'Enter your business name.',
  invalid_timezone: 'Choose a time zone.',
  invalid_zips: 'Use ZIP codes separated by commas.',
  invalid_hours: 'End time must be after start time.',
  invalid_workdays: 'Choose at least one day.',
  invalid_slot_minutes: 'Choose an appointment length.',
  invalid_mode: 'Choose where appointments happen.',
  already_exists: 'Your business was just created. Refreshing…',
}
// The setup check re-reads after any save on this page.
const saved = () => window.dispatchEvent(new Event('gsu:settings-saved'))
const errorText = (code) => ERRORS[code] || 'Something went wrong. Please try again.'

// Time zone: the US zones by the names people use, then (only when asked for) every other zone. The stored value is the
// same zone id as before ("America/New_York"); a business already on another zone keeps it, shown by its own name.
const zoneName = (tz) => tz.replaceAll('_', ' ')
const OTHER = '__other__'
// Works controlled (value + onChange) or inside a FormData form (name + defaultValue).
export function TimeZoneSelect({ value, defaultValue, onChange, name }) {
  const [own, setOwn] = useState(defaultValue ?? '')
  const current = value ?? own
  const named = US_ZONES.some(([id]) => id === current)
  const [all, setAll] = useState(false)
  const pick = (e) => {
    if (e.target.value === OTHER) return setAll(true)
    setOwn(e.target.value)
    onChange?.(e.target.value)
  }
  return (
    <select name={name} value={current} onChange={pick} data-time-zone>
      <optgroup label="United States">
        {US_ZONES.map(([id, label]) => (
          <option key={id} value={id}>
            {label}
          </option>
        ))}
      </optgroup>
      {all ? (
        <optgroup label="Other">
          {[...new Set([current, ...timeZones()])]
            .filter((id) => id && !US_ZONES.some(([us]) => us === id))
            .map((id) => (
              <option key={id} value={id}>
                {zoneName(id)}
              </option>
            ))}
        </optgroup>
      ) : (
        <>
          {!named && current && <option value={current}>{zoneName(current)}</option>}
          <option value={OTHER}>Other time zone…</option>
        </>
      )}
    </select>
  )
}

// `inline` (Settings): the standard save row. Without it (onboarding) the save is the step's full-width button.
export function BusinessForm({ customer, submitLabel, onSaved, inline = false }) {
  const [name, setName] = useState(customer?.name || '')
  const [timezone, setTimezone] = useState(customer?.timezone || browserTimeZone())
  // The stored ZIP list as text. When a save changes it (the server tidies the list) the field follows, without
  // remounting the form: a remount would drop the "Saved" confirmation.
  const storedZips = (customer?.serviceZips || []).join(', ')
  const [zips, setZips] = useState(storedZips)
  const [seenZips, setSeenZips] = useState(storedZips)
  if (storedZips !== seenZips) {
    setSeenZips(storedZips)
    setZips(storedZips)
  }
  const [mode, setMode] = useState(customer?.appointmentMode || 'at_business')
  const save = useSaveState()
  // ZIP entries that don't look like US ZIP codes are named beside the field before anything is saved; the owner fixes
  // them or says "Save anyway" (a list is never stored with entries the owner wasn't shown).
  const odd = oddZips(zips, timezone)
  const [asked, setAsked] = useState(false) // a save was held back for the warning
  const [accepted, setAccepted] = useState('') // the exact list the owner chose to save anyway
  const zipField = useRef(null)

  const submit = (e, anyway = false) => {
    e?.preventDefault()
    if (odd.length && !anyway && accepted !== zips) {
      setAsked(true)
      save.reset()
      return zipField.current?.focus()
    }
    setAsked(false)
    save.run(async () => {
      let source
      try {
        source = localStorage.getItem('gsu_source') || undefined
      } catch {
        source = undefined
      }
      const { status, data } = await api('/api/dashboard/business', { method: 'POST', body: { name, timezone, serviceZips: zips, appointmentMode: mode, source } })
      if (status === 200 || status === 201) saved()
      else if (data.error !== 'already_exists') return { error: errorText(data.error) }
      onSaved?.(data)
      return undefined
    })
  }

  return (
    <form className="form" onSubmit={submit}>
      <label className="field">
        <span>Business name</span>
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} required autoComplete="organization" autoFocus={!customer} />
      </label>
      <fieldset className="field">
        <legend>Where do appointments happen?</legend>
        <div className="choice" role="radiogroup">
          {[
            ['at_business', 'At my location'],
            ['at_customer', 'At the customer’s location'],
          ].map(([value, label]) => (
            <label key={value} className="choice-option">
              <input type="radio" name="appointmentMode" value={value} checked={mode === value} onChange={() => setMode(value)} />
              <span>{label}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <label className="field">
        <span>Time zone</span>
        <TimeZoneSelect value={timezone} onChange={setTimezone} />
      </label>
      <label className="field">
        <span>
          Service ZIP codes <em>optional</em>
        </span>
        <input ref={zipField} value={zips} onChange={(e) => setZips(e.target.value)} placeholder="Leave empty to accept everyone" inputMode="text" aria-describedby={odd.length ? 'zip-warning' : undefined} aria-invalid={odd.length && asked ? true : undefined} />
      </label>
      {odd.length > 0 && accepted !== zips && (
        <div className="zip-warning" id="zip-warning" role={asked ? 'alert' : 'status'} data-zip-warning>
          <p>
            {odd.length === 1 ? 'This doesn’t look like a 5-digit ZIP code' : 'These don’t look like 5-digit ZIP codes'}: <strong>{odd.join(', ')}</strong>. Customers are matched on the exact ZIP they type, so a mistyped one never matches.
          </p>
          {asked && (
            <div className="ui-confirm-actions">
              <button type="button" className="btn btn-sm btn-quiet" onClick={() => zipField.current?.focus()}>
                Fix the list
              </button>
              <button
                type="button"
                className="btn btn-sm btn-quiet"
                onClick={() => {
                  setAccepted(zips)
                  submit(null, true)
                }}
              >
                Save anyway
              </button>
            </div>
          )}
        </div>
      )}
      <SaveBar save={save} block={!inline}>
        {submitLabel}
      </SaveBar>
    </form>
  )
}

const LENGTHS = [30, 45, 60, 90, 120]

export function HoursForm({ customer, submitLabel, onSaved, inline = false }) {
  const [workdays, setWorkdays] = useState(customer.workdays)
  const [dayStart, setDayStart] = useState(customer.dayStart)
  const [dayEnd, setDayEnd] = useState(customer.dayEnd)
  const [slotMinutes, setSlotMinutes] = useState(customer.slotMinutes)
  const save = useSaveState()
  // The saved hours this form started from: sent as `base` (a change made elsewhere meanwhile → 409, nothing replaced).
  const base = useRef({ workdays: customer.workdays, dayStart: customer.dayStart, dayEnd: customer.dayEnd, slotMinutes: customer.slotMinutes })

  const toggle = (d) => setWorkdays((w) => (w.includes(d) ? w.filter((x) => x !== d) : [...w, d].sort()))

  const submit = (e) => {
    e.preventDefault()
    save.run(async () => {
      const { status, data } = await api('/api/dashboard/hours', { method: 'POST', body: { workdays, dayStart, dayEnd, slotMinutes, base: base.current } })
      if (status !== 200) return { error: status === 409 ? CHANGED_ELSEWHERE : errorText(data.error) }
      base.current = data.hours || base.current
      saved()
      onSaved?.()
      return undefined
    })
  }

  return (
    <form className="form" onSubmit={submit}>
      <fieldset className="field">
        <legend>Days</legend>
        <div className="day-toggles">
          {DAY_SHORT.map((label, d) => (
            <button key={label} type="button" className="day-toggle" aria-pressed={workdays.includes(d)} onClick={() => toggle(d)}>
              {label}
            </button>
          ))}
        </div>
      </fieldset>
      <div className="field-row">
        <label className="field">
          <span>From</span>
          <input type="time" value={dayStart} onChange={(e) => setDayStart(e.target.value)} required step={900} />
        </label>
        <label className="field">
          <span>To</span>
          <input type="time" value={dayEnd} onChange={(e) => setDayEnd(e.target.value)} required step={900} />
        </label>
      </div>
      <p className="fine" data-hours-note>
        These times apply to every day you select. A different time on one day (closing early on Fridays, for example) isn’t available.{inline ? ' To close a whole date, use “Closed dates” in the next card.' : ''}
      </p>
      <label className="field">
        <span>{customer.appointmentMode === 'at_customer' ? 'Visit length' : 'Appointment length'}</span>
        <select value={slotMinutes} onChange={(e) => setSlotMinutes(Number(e.target.value))}>
          {[...new Set([slotMinutes, ...LENGTHS])].sort((a, b) => a - b).map((m) => (
            <option key={m} value={m}>
              {m < 60 ? `${m} minutes` : m % 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m / 60} hour${m > 60 ? 's' : ''}`}
            </option>
          ))}
        </select>
      </label>
      <SaveBar save={save} block={!inline}>
        {submitLabel}
      </SaveBar>
    </form>
  )
}

// Business details shown on the website (phone, what you do, towns, description).
export function ProfileForm({ onSaved }) {
  const [p, setP] = useState(undefined)
  const save = useSaveState()
  // The saved details this form shows (only when they loaded): sent as `base`, so a change made elsewhere meanwhile is
  // never silently replaced (409 conflict).
  const base = useRef(null)
  const load = () =>
    api('/api/dashboard/profile').then(({ status, data }) => {
      if (status === 200 && data.profile) base.current = data.profile
      setP(status === 200 ? data.profile || {} : null)
    })
  useEffect(() => {
    load()
    // The services form saves the same record: keep what this form starts from current, without touching what's typed.
    const on = (e) => {
      base.current = e.detail
      setP(e.detail)
    }
    window.addEventListener('gsu:profile', on)
    return () => window.removeEventListener('gsu:profile', on)
  }, [])
  if (p === null) return <LoadError what="your details" onRetry={load} />
  if (p === undefined) return <div aria-busy="true" />
  const submit = (e) => {
    e.preventDefault()
    const f = new FormData(e.currentTarget)
    save.run(async () => {
      const { status, data } = await api('/api/dashboard/profile', {
        method: 'POST',
        body: { phone: f.get('phone'), industry: f.get('industry'), description: f.get('description'), cities: f.get('cities'), services: p.services || [], ...(base.current ? { base: base.current } : {}) },
      })
      if (status === 409) return { error: CHANGED_ELSEWHERE }
      if (status !== 200) return { error: data.fields?.includes('phone') ? 'Enter a 10-digit US phone number, or leave it empty.' : data.fields?.includes('industry') ? 'Tell us what kind of business this is.' : 'Please check the details and try again.' }
      base.current = data.profile
      setP(data.profile)
      window.dispatchEvent(new CustomEvent('gsu:profile', { detail: data.profile }))
      saved()
      onSaved?.()
      return undefined
    })
  }
  return (
    <form className="form" onSubmit={submit}>
      <label className="field">
        <span>Business phone <em>(shown on your website)</em></span>
        <input name="phone" type="tel" defaultValue={p.phone || ''} autoComplete="tel" inputMode="tel" />
      </label>
      <label className="field">
        <span>What do you do?</span>
        <input name="industry" defaultValue={p.industry || ''} maxLength={60} required placeholder="Pool service" />
      </label>
      <label className="field">
        <span>Towns you serve <em>(comma separated)</em></span>
        <input name="cities" defaultValue={(p.cities || []).join(', ')} />
      </label>
      <label className="field">
        <span>Short description <em>(optional)</em></span>
        <textarea name="description" rows={3} maxLength={400} defaultValue={p.description || ''} />
      </label>
      <AiWrite field="description" draft />
      <SaveBar save={save}>Save details</SaveBar>
    </form>
  )
}

const POLICY_ERRORS = {
  beforeVisit: 'Keep “Before the appointment” under 300 characters.',
  cancellation: 'Keep the cancellation note under 300 characters.',
  'beforeVisit:unapproved_claim': 'Please remove promises like guarantees, discounts, ratings or “licensed/insured” unless we’ve verified them with you.',
  'cancellation:unapproved_claim': 'Please remove promises like guarantees, discounts, ratings or “licensed/insured” unless we’ve verified them with you.',
}

// What customers should know: shown on the booking page and in the confirmation and day-before reminder.
export function PoliciesForm() {
  const [p, setP] = useState(undefined)
  const save = useSaveState()
  const base = useRef(null) // the saved policies this form shows (see ProfileForm)
  const load = () =>
    api('/api/dashboard/policies').then(({ status, data }) => {
      if (status === 200) base.current = data.policies
      setP(status === 200 ? data.policies : null)
    })
  useEffect(() => {
    load()
  }, [])
  if (p === null) return <LoadError what="these notes" onRetry={load} />
  if (p === undefined) return <div aria-busy="true" />
  const submit = (e) => {
    e.preventDefault()
    const f = new FormData(e.currentTarget)
    save.run(async () => {
      const { status, data } = await api('/api/dashboard/policies', { method: 'POST', body: { beforeVisit: f.get('beforeVisit'), cancellation: f.get('cancellation'), ...(base.current ? { base: base.current } : {}) } })
      if (status === 409) return { error: CHANGED_ELSEWHERE }
      if (status !== 200) return { error: POLICY_ERRORS[data.fields?.[0]] || 'Couldn’t save. Please try again.' }
      base.current = data.policies
      setP(data.policies)
      saved()
      return undefined
    })
  }
  return (
    <form className="form" onSubmit={submit}>
      <p className="fine">Shown on your booking page and in the confirmation and day-before reminder. Leave a box empty to leave it out.</p>
      <label className="field">
        <span>Before the appointment <em>(optional)</em></span>
        <textarea name="beforeVisit" rows={3} maxLength={300} defaultValue={p.beforeVisit} placeholder="Please unlock the gate and keep pets inside." />
      </label>
      <AiWrite field="beforeVisit" />
      <label className="field">
        <span>Cancellations <em>(optional)</em></span>
        <textarea name="cancellation" rows={2} maxLength={300} defaultValue={p.cancellation} placeholder="Please cancel at least 24 hours ahead." />
      </label>
      <AiWrite field="cancellation" />
      <SaveBar save={save}>Save</SaveBar>
    </form>
  )
}

// Services and prices: ONE list (server/services.js) for the booking page, the receptionist, the assistant, ads and new
// websites. The published website keeps its own copy (a visitor never sees it change without a publish); the setup check
// says when the two disagree. Per service: what it is, its price as the owner writes it, how long it takes, how customers
// get it (book a time / request / not on the booking page), one optional question, and a temporary hide switch.
const FLOWS = [
  ['book', 'Customers pick a time'],
  ['request', 'Customers send a request (quote or call back)'],
  ['off', 'Not on the booking page (the receptionist can still answer about it)'],
]
const blankService = () => ({ name: '', price: '', description: '', slots: 1, hidden: false, booking: 'book', question: null })
const withDefaults = (s) => ({ ...blankService(), ...s, question: s?.question?.label ? s.question : null })
const lengthLabel = (m) => (m < 60 ? `${m} min` : m % 60 === 0 ? `${m / 60} hour${m === 60 ? '' : 's'}` : `${Math.floor(m / 60)} h ${m % 60} min`)

export function ServicesForm() {
  const [p, setP] = useState(undefined)
  const [rows, setRows] = useState(null)
  const [open, setOpen] = useState(null)
  const [state, setState] = useState({}) // "Copy from my website": busy / note / error
  const save = useSaveState() // the form's save
  const otherSave = useSaveState() // the "Other / Not sure" box saves on change
  const [booking, setBooking] = useState(null)
  const base = useRef(null)
  const load = () =>
    api('/api/dashboard/profile').then(({ status, data }) => {
      if (status === 200 && data.profile) base.current = data.profile
      setP(status === 200 ? data.profile || {} : null)
    })
  const loadBooking = () => api('/api/dashboard/booking').then(({ status, data }) => setBooking(status === 200 ? data : false))
  useEffect(() => {
    load()
    loadBooking()
    const on = (e) => {
      base.current = e.detail
      setP(e.detail)
    }
    window.addEventListener('gsu:profile', on)
    return () => window.removeEventListener('gsu:profile', on)
  }, [])
  if (p === null) return <LoadError what="your services" onRetry={load} />
  if (p === undefined) return <div aria-busy="true" />
  const slot = booking?.slotMinutes || 60
  const list = rows ?? (p.services?.length ? p.services.map(withDefaults) : [blankService()])
  const update = (i, patch) => setRows(list.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  const set = (i, k) => (e) => update(i, { [k]: e.target.value })
  const move = (i, d) => {
    const l = [...list]
    ;[l[i], l[i + d]] = [l[i + d], l[i]]
    setRows(l)
    if (open === i) setOpen(i + d)
  }
  const ideas = suggestionsFor(p.industry, list.map((r) => r.name))
  const fromWebsite = async () => {
    save.reset()
    setState({ busy: true })
    const { status, data } = await api('/api/dashboard/website')
    const found = (status === 200 ? data.draft?.services || [] : []).filter((x) => x?.name).slice(0, 16).map((x) => ({ ...blankService(), name: String(x.name).slice(0, 60), price: String(x.price || '').slice(0, 40), description: String(x.description || '').slice(0, 160) }))
    if (found.length) setRows(found)
    setState(found.length ? { note: 'Copied from your website. Check them, then save.' } : { error: 'Your website lists no services.' })
  }
  const submit = (e) => {
    e.preventDefault()
    const industry = p.industry || new FormData(e.currentTarget).get('industry')
    setState({})
    const services = list
      .filter((r) => r.name.trim())
      .map((r) => ({ ...(r.id ? { id: r.id } : {}), name: r.name, price: r.price || '', description: r.description || '', slots: r.slots || 1, hidden: r.hidden === true, booking: r.booking || 'book', question: r.question?.label?.trim() ? { label: r.question.label, required: r.question.required === true } : null }))
    save.run(async () => {
      const { status, data } = await api('/api/dashboard/profile', { method: 'POST', body: { phone: p.phone, industry, description: p.description, cities: p.cities || [], services, ...(base.current ? { base: base.current } : {}) } })
      if (status !== 200) return { error: status === 409 ? CHANGED_ELSEWHERE : data.fields?.includes('services:unapproved_claim') ? 'Please remove promises like guarantees, discounts or ratings from names, prices and descriptions.' : data.fields?.includes('industry') ? 'Tell us what kind of business this is.' : 'Please check the services and try again: names up to 60 characters, prices up to 40, descriptions up to 160.' }
      base.current = data.profile
      setP(data.profile)
      setRows(null)
      setOpen(null)
      window.dispatchEvent(new CustomEvent('gsu:profile', { detail: data.profile }))
      saved()
      return { saved: 'Saved. Your booking page and the receptionist use it now. Your website changes when you edit and publish it.' }
    })
  }
  // Saves on change: the same confirmation as a save button, next to the box (reference usage of the pattern).
  const toggleOther = (allowOther) =>
    otherSave.run(async () => {
      setBooking((b) => ({ ...b, options: { ...b.options, allowOther } }))
      const { status } = await api('/api/dashboard/booking', { method: 'POST', body: { allowOther } })
      if (status !== 200) {
        loadBooking() // show what is actually stored
        return { error: 'Couldn’t save that. Please try again.' }
      }
      saved()
      return undefined
    })
  return (
    <form className="form svc-form" onSubmit={submit}>
      <p className="fine">What customers can book, and what the receptionist and the assistant say you do. Write what a price covers: “$300 per month”, “From $150 per visit”, “$95 per hour”.</p>
      {!p.industry && (
        <label className="field">
          <span>What do you do?</span>
          <input name="industry" maxLength={60} required placeholder="Pool service" />
        </label>
      )}
      <ol className="svc-list">
        {list.map((r, i) => {
          const minutes = (r.slots || 1) * slot
          return (
            <li key={r.id || `new-${i}`} className={`svc${r.hidden ? ' is-hidden' : ''}`}>
              <div className="svc-main">
                <label className="field">
                  <span className="sr-only">Service {i + 1}</span>
                  <input value={r.name} onChange={set(i, 'name')} maxLength={60} placeholder="Service name" aria-label={`Service ${i + 1}`} />
                </label>
                <label className="field field--price">
                  <span className="sr-only">Price for service {i + 1}</span>
                  <input value={r.price || ''} onChange={set(i, 'price')} maxLength={40} placeholder="$150 per visit" aria-label={`Price for service ${i + 1}`} />
                </label>
                <div className="svc-tools">
                  <button type="button" className="icon-btn" aria-label={`Move ${r.name || `service ${i + 1}`} up`} disabled={i === 0} onClick={() => move(i, -1)}>
                    ↑
                  </button>
                  <button type="button" className="icon-btn" aria-label={`Move ${r.name || `service ${i + 1}`} down`} disabled={i === list.length - 1} onClick={() => move(i, 1)}>
                    ↓
                  </button>
                  <button type="button" className="link-btn" aria-expanded={open === i} aria-controls={`svc-more-${i}`} onClick={() => setOpen(open === i ? null : i)}>
                    {open === i ? 'Done' : 'Options'}
                  </button>
                  <button type="button" className="link-btn service-remove" aria-label={`Remove service ${i + 1}`} onClick={() => setRows(list.filter((_, j) => j !== i))} disabled={list.length === 1}>
                    Remove
                  </button>
                </div>
              </div>
              <p className="svc-meta">
                {r.booking === 'off' ? 'Not on the booking page' : r.booking === 'request' ? 'Request' : lengthLabel(minutes)}
                {r.question?.label ? ' · asks one question' : ''}
                {r.hidden ? ' · Hidden' : ''}
              </p>
              {open === i && (
                <div className="svc-more" id={`svc-more-${i}`}>
                  <label className="field">
                    <span>Description (optional)</span>
                    <textarea rows={2} maxLength={160} value={r.description || ''} onChange={set(i, 'description')} placeholder="What’s included, in one line" />
                  </label>
                  <fieldset className="field">
                    <legend>How customers get it</legend>
                    {FLOWS.map(([v, label]) => (
                      <label key={v} className="check">
                        <input type="radio" name={`flow-${i}`} checked={(r.booking || 'book') === v} onChange={() => update(i, { booking: v })} />
                        <span>{label}</span>
                      </label>
                    ))}
                  </fieldset>
                  {(r.booking || 'book') === 'book' && (
                    <label className="field">
                      <span>How long it takes</span>
                      <select value={r.slots || 1} onChange={(e) => update(i, { slots: Number(e.target.value) })}>
                        {[1, 2, 3, 4].map((n) => (
                          <option key={n} value={n}>
                            {lengthLabel(n * slot)}
                          </option>
                        ))}
                      </select>
                      <small className="fine">Times are offered on your {lengthLabel(slot)} booking grid (Booking hours).</small>
                    </label>
                  )}
                  {r.booking !== 'off' && (
                    <div className="svc-question">
                      <label className="field">
                        <span>Ask customers who choose it (optional)</span>
                        <input maxLength={80} value={r.question?.label || ''} onChange={(e) => update(i, { question: { label: e.target.value, required: r.question?.required === true } })} placeholder="Which equipment, and what’s it doing?" />
                      </label>
                      {r.question?.label && (
                        <label className="check">
                          <input type="checkbox" checked={r.question?.required === true} onChange={(e) => update(i, { question: { ...r.question, required: e.target.checked } })} />
                          <span>Required</span>
                        </label>
                      )}
                    </div>
                  )}
                  <label className="check">
                    <input type="checkbox" checked={r.hidden === true} onChange={(e) => update(i, { hidden: e.target.checked })} />
                    <span>Hide for now (not offered on the booking page or by the receptionist; past requests keep it)</span>
                  </label>
                </div>
              )}
            </li>
          )
        })}
      </ol>
      <div className="row-actions">
        {list.length < 16 && (
          <button type="button" className="btn btn-sm btn-quiet" onClick={() => setRows([...list, blankService()])}>
            Add a service
          </button>
        )}
        <button type="button" className="btn btn-sm btn-quiet" onClick={fromWebsite} disabled={state.busy}>
          Copy from my website
        </button>
      </div>
      {ideas?.names.length > 0 && list.length < 16 && (
        <div className="svc-ideas">
          <span className="fine">Common for {ideas.label}, if you offer them:</span>
          {ideas.names.map((n) => (
            <button key={n} type="button" className="chip" onClick={() => setRows([...list.filter((r) => r.name.trim()), { ...blankService(), name: n }])}>
              + {n}
            </button>
          ))}
        </div>
      )}
      {state.error && (
        <p className="form-error" role="alert">
          {state.error}
        </p>
      )}
      {state.note && save.status !== 'saved' && (
        <p className="fine" role="status">
          {state.note}
        </p>
      )}
      <SaveBar save={save} disabled={state.busy}>
        Save services
      </SaveBar>
      {booking && (
        <div className="svc-booking">
          {booking.options?.ready && (
            <>
              <label className="check">
                <input type="checkbox" checked={booking.options.allowOther !== false} disabled={otherSave.pending} onChange={(e) => toggleOther(e.target.checked)} />
                <span>Offer “Other / Not sure” on the booking page (customers describe what they need)</span>
              </label>
              <SaveStatus save={otherSave} />
            </>
          )}
          <p className="fine">
            <a href={`${booking.bookingUrl}?preview=1`} target="_blank" rel="noopener">
              Preview your booking page
            </a>{' '}
            · nothing is booked from a preview.
          </p>
          <FunnelLine funnel={booking.funnel} />
        </div>
      )}
    </form>
  )
}

// Last 30 days of the booking page (server/booking-funnel.js): counts only, no rate when there were no visits.
function FunnelLine({ funnel }) {
  if (!funnel) return null
  const v = funnel.stages.view
  if (!v) return <p className="fine">No booking page visits in the last 30 days.</p>
  const done = funnel.stages.booked + funnel.stages.requested
  return (
    <p className="fine svc-funnel">
      Last 30 days: {plural(v, 'visit')} · {funnel.stages.time} chose a time · {done} booked or requested ({funnel.conversion}%)
    </p>
  )
}

const NOTICE = [
  [0, 'None: any open time'],
  [60, '1 hour'],
  [120, '2 hours'],
  [240, '4 hours'],
  [720, '12 hours'],
  [1440, '1 day (no same-day)'],
  [2880, '2 days'],
]
const AVAIL_ERRORS = { invalid_date: 'Choose a date.', too_many_closures: 'That’s too many closed dates.', invalid_label: 'Keep the note under 60 characters.', not_available_yet: 'Closed dates aren’t available yet. Block the time in Google Calendar (as Busy) meanwhile.' }
const longDate = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' })

// Closed dates and minimum notice: the booking page, the receptionist and every booking link follow them at once.
export function AvailabilityForm() {
  const [d, setD] = useState(undefined)
  const [edit, setEdit] = useState(null)
  const [date, setDate] = useState('')
  const [label, setLabel] = useState('')
  const save = useSaveState()
  const load = () => api('/api/dashboard/availability').then(({ status, data }) => setD(status === 200 ? data : null))
  useEffect(() => {
    load()
  }, [])
  if (d === null) return <LoadError what="your closed dates" onRetry={load} />
  if (d === undefined) return <div aria-busy="true" />
  if (!d.ready) return <p className="fine">Closed dates and minimum notice aren’t available yet. Meanwhile, block time in Google Calendar and mark it Busy; booking follows it.</p>
  const cur = edit ?? { minNoticeMinutes: d.minNoticeMinutes, closures: d.closures }
  const add = (x) => setEdit({ ...cur, closures: [...cur.closures.filter((c) => c.date !== x.date), x].sort((a, b) => a.date.localeCompare(b.date)) })
  const submit = (e) => {
    e.preventDefault()
    const body = date ? { ...cur, closures: [...cur.closures.filter((c) => c.date !== date), { date, label }] } : cur
    save.run(async () => {
      const { status, data } = await api('/api/dashboard/availability', { method: 'POST', body: { ...body, base: { minNoticeMinutes: d.minNoticeMinutes, closures: d.closures } } })
      if (status !== 200) return { error: status === 409 && data.error === 'conflict' ? CHANGED_ELSEWHERE : AVAIL_ERRORS[data.error] || 'Couldn’t save. Please try again.' }
      setD(data)
      setEdit(null)
      setDate('')
      setLabel('')
      saved()
      return { saved: 'Saved. Customers see it now.' }
    })
  }
  const suggested = d.suggested.filter((h) => !cur.closures.some((c) => c.date === h.date))
  return (
    <form className="form" onSubmit={submit}>
      <label className="field">
        <span>Minimum notice before a visit</span>
        <select value={cur.minNoticeMinutes} onChange={(e) => setEdit({ ...cur, minNoticeMinutes: Number(e.target.value) })}>
          {NOTICE.map(([v, t]) => (
            <option key={v} value={v}>
              {t}
            </option>
          ))}
        </select>
      </label>
      <fieldset className="field">
        <legend>Closed dates</legend>
        {cur.closures.length ? (
          <ul className="rows" data-closures-list>
            {cur.closures.map((c) => (
              <li key={c.date} className="row">
                <div className="row-main">
                  <p className="row-title">{longDate(c.date)}</p>
                  <p className="row-sub">
                    {c.label}
                    {d.booked[c.date] ? ` ${d.booked[c.date]} booked already: closing doesn’t cancel ${d.booked[c.date] === 1 ? 'it' : 'them'}.` : ''}
                  </p>
                </div>
                <button type="button" className="link-btn" onClick={() => setEdit({ ...cur, closures: cur.closures.filter((x) => x.date !== c.date) })}>
                  Remove<span className="sr-only"> {longDate(c.date)}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="fine">None. You’re open on every booking day.</p>
        )}
      </fieldset>
      {suggested.length > 0 && (
        <div className="row-actions" role="group" aria-label="Upcoming holidays">
          {suggested.map((h) => (
            <button key={h.date} type="button" className="btn btn-sm btn-quiet" onClick={() => add(h)}>
              Close {h.label}
            </button>
          ))}
        </div>
      )}
      <div className="field-row">
        <label className="field">
          <span>Another date</span>
          <input type="date" value={date} min={d.today} onChange={(e) => setDate(e.target.value)} />
        </label>
        <label className="field">
          <span>
            Note <em>optional</em>
          </span>
          <input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={60} />
        </label>
      </div>
      <SaveBar save={save}>Save closed dates and notice</SaveBar>
    </form>
  )
}
