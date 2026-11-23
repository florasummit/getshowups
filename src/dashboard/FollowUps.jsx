// Follow-ups: who contacted the business, who was answered, who replied, who booked — and the conversation itself.
// The owner can take over from the assistant, reply, pause automatic messages, adjust a few preferences, and see
// (and prepare) texting setup. No workflow graphs, prompts or technical settings.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { api, phoneText } from '../lib/api.js'

const STAGE = { new: 'New', contacted: 'Contacted', replied: 'Replied', booked: 'Booked', closed: 'Closed', opted_out: 'Opted out' }
const SOURCE = { website_form: 'Website form', booking_page: 'Booking page', sms: 'Text message', google_ads: 'Google Ads', gbp: 'Google Business Profile', call: 'Phone call', enterprise_inquiry: 'Enterprise inquiry', other: 'Other' }
const NEEDS = {
  human_requested: 'Asked for a person',
  ai_unsure: 'The assistant wasn’t sure how to answer',
  ai_fallback: 'Got a standard reply — please follow up',
  ai_limit: 'Many questions today — please take over',
  needs_reply: 'Waiting for your reply',
  cancel_request: 'Wants to cancel',
}
const AUTHOR = { lead: null, ai: 'Assistant', auto: 'Automatic', owner: 'You', system: 'Automatic' }
// Why a message didn't go out, in plain words.
const WHY = {
  sms_not_ready: 'texting isn’t set up yet',
  no_consent: 'they didn’t agree to texts',
  opted_out: 'they opted out',
  test_mode: 'test mode: only test recipients get messages',
  automation_paused: 'automatic messages are paused',
  human_takeover: 'you took over',
  quiet_hours: 'quiet hours',
  paused_by_platform: 'messaging is paused by GetShowUps',
  business_daily_limit: 'daily limit reached',
  lead_daily_limit: 'enough messages to this person today',
  suppressed: 'their email bounced',
  not_needed: 'no longer needed',
  interrupted: 'delivery couldn’t be confirmed',
  no_email: 'no email address',
  business_inactive: 'your account isn’t active',
  no_provider: 'email isn’t available right now',
}
const SMS_REASON = {
  provider_not_configured: 'Texting isn’t available on GetShowUps yet.',
  no_sender: 'Your texting number hasn’t been set up yet.',
  no_account: 'GetShowUps hasn’t set up your texting account yet.',
  registration_not_configured: 'Carriers require a one-time business registration before texting. Start it below.',
  registration_ready: 'Your registration details are ready to review and approve.',
  registration_pending: 'Your registration is with the carriers. This usually takes a few days.',
  registration_rejected: 'Carriers didn’t accept the registration. See what to fix below.',
  registration_suspended: 'Texting is suspended. Contact GetShowUps support.',
  paused_by_platform: 'Messaging is temporarily paused by GetShowUps.',
}
const KIND = { lead_ack: 'Thank-you reply', lead_followup_1: 'Reminder to pick a time', lead_followup_2: 'Second reminder to pick a time', interested_followup: 'Nudge to book', coverage_ok: 'Your area is covered: pick a time', confirmation: 'Booking confirmation', reminder_24h: 'Day-before reminder', reminder_2h: 'Two-hour reminder', no_show_rebook: 'Invitation to rebook', after_visit: 'Thank-you after the visit' }

const ago = (t) => {
  const s = Math.max(0, (Date.now() - t) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}
const when = (t) => new Date(t).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })

export default function FollowUps() {
  const [data, setData] = useState(null)
  const [open, setOpen] = useState(null)
  const [filter, setFilter] = useState('all')
  const [tick, setTick] = useState(0)
  const load = useCallback(() => setTick((n) => n + 1), [])
  useEffect(() => {
    api('/api/dashboard/followups').then(({ status, data: d }) => setData(status === 200 ? d : { failed: true }))
  }, [tick])
  useEffect(() => {
    const t = setInterval(load, 30_000)
    return () => clearInterval(t)
  }, [load])

  if (!data) return <div aria-busy="true" className="fu-loading">Loading follow-ups…</div>
  if (data.failed) return <p className="notice" role="alert">Follow-ups couldn’t be loaded. Please try again in a moment.</p>
  if (!data.ready)
    return (
      <>
        <h1 className="title title--page">Follow-ups</h1>
        <section className="card">
          <p>Follow-ups are being set up for your account. Your automatic emails, confirmations and reminders keep working as before.</p>
        </section>
      </>
    )
  const threads = data.threads.filter((t) => (filter === 'needs' ? t.needsOwner : filter === 'booked' ? t.stage === 'booked' : true))
  return (
    <>
      <div className="fu-head">
        <h1 className="title title--page">Follow-ups</h1>
        <Automation on={data.automations} onChange={load} />
      </div>
      <Notices channels={data.channels} />
      <dl className="fu-stats" aria-label="Last 30 days">
        {[
          ['New leads', data.counts.leads],
          ['Contacted', data.counts.contacted],
          ['Replied', data.counts.replied],
          ['Booked', data.counts.booked],
          ['Need you', data.counts.needsYou],
        ].map(([k, v]) => (
          <div key={k} className={k === 'Need you' && v ? 'fu-stat fu-stat--attn' : 'fu-stat'}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      <div className={`fu-inbox${open ? ' fu-inbox--open' : ''}`}>
        <section className="fu-list" aria-label="Conversations">
          <div className="segmented segmented--sm" role="group" aria-label="Show">
            {[
              ['all', 'All'],
              ['needs', `Need you${data.counts.needsYou ? ` (${data.counts.needsYou})` : ''}`],
              ['booked', 'Booked'],
            ].map(([k, l]) => (
              <button key={k} type="button" aria-pressed={filter === k} onClick={() => setFilter(k)}>
                {l}
              </button>
            ))}
          </div>
          {threads.length === 0 ? (
            <p className="fu-empty">{filter === 'all' ? 'New leads from your website and booking page will appear here.' : 'Nothing here right now.'}</p>
          ) : (
            <ul>
              {threads.map((t) => (
                <li key={t.id}>
                  <button type="button" className={`fu-row${open === t.id ? ' is-open' : ''}`} onClick={() => setOpen(t.id)} aria-current={open === t.id ? 'true' : undefined}>
                    <span className="fu-row-top">
                      <strong>{t.name}</strong>
                      <span className="fu-time">{ago(t.lastActivity)}</span>
                    </span>
                    <span className="fu-row-mid">
                      <Stage stage={t.stage} />
                      {t.needsOwner && <span className="fu-pill fu-pill--attn">{NEEDS[t.needsOwner] ? 'Needs you' : 'Needs you'}</span>}
                      {t.takenOver && <span className="fu-pill">You’re handling it</span>}
                      {t.failures > 0 && <span className="fu-pill fu-pill--bad">Not delivered</span>}
                      {t.test && <span className="fu-pill">Test</span>}
                    </span>
                    <span className="fu-preview">{t.preview || t.need}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="fu-convo" aria-label="Conversation">
          {open ? <Conversation key={open} id={open} onBack={() => setOpen(null)} onChanged={load} /> : <p className="fu-empty">Choose a conversation to see the messages.</p>}
        </section>
      </div>
      <Preferences settings={data.settings} onSaved={load} />
      <Texting texting={data.texting} channels={data.channels} onSaved={load} />
    </>
  )
}

function Stage({ stage }) {
  return <span className={`fu-stage fu-stage--${stage}`}>{STAGE[stage] || stage}</span>
}

function Automation({ on, onChange }) {
  const [busy, setBusy] = useState(false)
  const toggle = async () => {
    if (on && !window.confirm('Pause all automatic messages (replies, reminders to book, confirmations and reminders)? You can resume any time.')) return
    setBusy(true)
    await api('/api/dashboard/followups', { method: 'POST', body: { action: 'automations', enabled: !on } })
    setBusy(false)
    onChange()
  }
  return (
    <div className="fu-auto">
      <span className={`status status--${on ? 'ok' : 'pending'}`}>
        <span className="status-dot" aria-hidden="true" />
        {on ? 'Automatic follow-ups on' : 'Automatic follow-ups paused'}
      </span>
      <button type="button" className="btn btn-quiet btn-sm" onClick={toggle} disabled={busy}>
        {on ? 'Pause' : 'Resume'}
      </button>
    </div>
  )
}

function Notices({ channels: c }) {
  const items = []
  if (c.paused) items.push('Messaging is temporarily paused by GetShowUps. Nothing is sent until it resumes; nothing will be sent late in a burst.')
  if (!c.email) items.push('Email isn’t available right now, so automatic emails are not being sent.')
  if (c.testMode) items.push('Test mode: messages go only to GetShowUps test recipients while we finish launch checks.')
  if (!items.length) return null
  return (
    <div className="fu-notices" role="status">
      {items.map((t) => (
        <p key={t}>{t}</p>
      ))}
    </div>
  )
}

function Conversation({ id, onBack, onChanged }) {
  const [v, setV] = useState(null)
  const [text, setText] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    api(`/api/dashboard/followups/thread?id=${encodeURIComponent(id)}`).then(({ status, data }) => setV(status === 200 ? data : { failed: true }))
  }, [id])
  const act = async (action, extra = {}) => {
    setBusy(true)
    setErr('')
    const { status, data } = await api('/api/dashboard/followups/thread', { method: 'POST', body: { id, action, ...extra } })
    setBusy(false)
    if (status !== 200) {
      setErr(
        { opted_out: 'They opted out of texts. Reply by email instead.', no_consent: 'They didn’t agree to texts. Reply by email instead.', sms_not_ready: 'Texting isn’t set up yet. Reply by email instead.', no_email: 'There’s no email address for this person.', invalid_message: 'Please write a message (up to 1,000 characters).' }[data?.error] ||
          'That didn’t work. Please try again.',
      )
      return false
    }
    setV(data)
    onChanged()
    return true
  }
  if (!v) return <div aria-busy="true" className="fu-loading">Loading…</div>
  if (v.failed) return <p className="notice">This conversation couldn’t be loaded.</p>
  const t = v.thread
  const canText = t.smsConsent && !t.smsOptedOut
  return (
    <div className="fu-thread">
      <header className="fu-thread-head">
        <button type="button" className="link-btn fu-back" onClick={onBack}>
          ← All conversations
        </button>
        <div>
          <h2>{t.name}</h2>
          <p className="fu-meta">
            <Stage stage={t.stage} /> · {SOURCE[t.source] || 'Lead'} · “{t.need}”
          </p>
          <p className="fu-contact">
            {t.phone && <a href={`tel:${t.phone}`}>{phoneText(t.phone)}</a>}
            {t.phone && t.email && ' · '}
            {t.email && <a href={`mailto:${t.email}`}>{t.email}</a>}
            {t.smsOptedOut && <span className="fu-pill fu-pill--bad">Opted out of texts</span>}
          </p>
        </div>
        <div className="fu-actions">
          {t.takenOver ? (
            <button type="button" className="btn btn-quiet btn-sm" onClick={() => act('release')} disabled={busy}>
              Hand back to automatic replies
            </button>
          ) : (
            <button type="button" className="btn btn-quiet btn-sm" onClick={() => act('takeover')} disabled={busy}>
              Take over
            </button>
          )}
          {t.needsOwner && (
            <button type="button" className="btn btn-quiet btn-sm" onClick={() => act('done')} disabled={busy}>
              Mark handled
            </button>
          )}
          {!['closed', 'booked', 'opted_out'].includes(t.stage) && (
            <button type="button" className="link-btn" onClick={() => window.confirm('Stop follow-ups for this lead? Confirmations and reminders for booked appointments still go out.') && act('close')} disabled={busy}>
              Stop follow-ups
            </button>
          )}
        </div>
      </header>
      {t.needsOwner && <p className="fu-attn">{NEEDS[t.needsOwner] || 'Please take a look.'}</p>}
      {t.takenOver && <p className="fu-hint">You’re handling this conversation. Automatic replies are paused for this person.</p>}
      <ol className="fu-msgs">
        {v.messages.map((m) => (
          <li key={m.id} className={`fu-msg fu-msg--${m.direction}${m.status === 'skipped' || m.status === 'failed' ? ' fu-msg--muted' : ''}`}>
            <div className="fu-bubble">{m.body}</div>
            <div className="fu-msg-meta">
              {AUTHOR[m.author] && `${AUTHOR[m.author]} · `}
              {m.channel === 'sms' ? 'Text' : m.channel === 'email' ? 'Email' : 'Note'} · {when(m.at)}
              {m.direction === 'out' && <Delivery m={m} />}
            </div>
          </li>
        ))}
        {v.messages.length === 0 && <li className="fu-empty">No messages yet.</li>}
      </ol>
      {v.upcoming.length > 0 && (
        <div className="fu-upcoming">
          <h3>Scheduled</h3>
          <ul>
            {v.upcoming.map((u) => (
              <li key={`${u.kind}${u.channel}`}>
                {KIND[u.kind] || 'Message'} · {u.channel === 'sms' ? 'text' : 'email'} · {when(u.at)}
              </li>
            ))}
          </ul>
        </div>
      )}
      <form
        className="fu-compose"
        onSubmit={async (e) => {
          e.preventDefault()
          if (await act('reply', { text })) setText('')
        }}
      >
        <label htmlFor="fu-reply" className="sr-only">
          Your reply
        </label>
        <textarea id="fu-reply" rows={3} maxLength={1000} value={text} onChange={(e) => setText(e.target.value)} placeholder={`Write to ${t.name.split(' ')[0]}…`} />
        <div className="fu-compose-row">
          <span className="fine">{canText ? 'Sends as a text when texting is set up, otherwise by email.' : t.email ? 'Sends by email.' : 'No way to reach this person by message.'} Replying takes over from automatic replies.</span>
          <button type="submit" className="btn btn-primary btn-sm" disabled={busy || !text.trim()}>
            Send
          </button>
        </div>
        {err && (
          <p className="form-error" role="alert">
            {err}
          </p>
        )}
      </form>
    </div>
  )
}

function Delivery({ m }) {
  if (m.status === 'delivered') return <span className="fu-ok"> · Delivered</span>
  if (m.status === 'sent') return <span> · Sent</span>
  if (m.status === 'queued' || m.status === 'sending') return <span> · Sending…</span>
  if (m.status === 'failed') return <span className="fu-bad"> · Not delivered{m.error && WHY[m.error] ? ` (${WHY[m.error]})` : ''}</span>
  return <span className="fu-muted"> · Not sent{m.error && WHY[m.error] ? `: ${WHY[m.error]}` : ''}</span>
}

function Preferences({ settings, onSaved }) {
  const [s, setS] = useState(settings)
  const [state, setState] = useState('')
  const save = async (next) => {
    setS(next)
    setState('saving')
    const { status, data } = await api('/api/dashboard/followups', { method: 'POST', body: { action: 'settings', settings: next } })
    setState(status === 200 ? 'saved' : data?.error === 'quiet_hours_too_short' ? 'Quiet hours must be at least 8 hours.' : 'Couldn’t save. Please try again.')
    if (status === 200) onSaved()
  }
  const hours = useMemo(() => Array.from({ length: 24 }, (_, h) => [h, new Date(2026, 0, 1, h).toLocaleTimeString(undefined, { hour: 'numeric' })]), [])
  return (
    <section className="card fu-prefs" aria-label="Follow-up preferences">
      <details>
        <summary>
          <h2 className="card-title">Preferences</h2>
          <span className="fine">{state === 'saving' ? 'Saving…' : state === 'saved' ? 'Saved' : state}</span>
        </summary>
        <label className="check">
          <input type="checkbox" checked={s.acknowledge} onChange={(e) => save({ ...s, acknowledge: e.target.checked })} />
          <span>Reply right away to messages from my website</span>
        </label>
        <label className="check">
          <input type="checkbox" checked={s.aiReplies} onChange={(e) => save({ ...s, aiReplies: e.target.checked })} />
          <span>Let the assistant answer simple questions by text (using only my services, prices, area and policies)</span>
        </label>
        <label className="field">
          <span>Reminders to book for people who haven’t booked</span>
          <select value={s.nudges} onChange={(e) => save({ ...s, nudges: Number(e.target.value) })}>
            <option value={0}>None</option>
            <option value={1}>One</option>
            <option value={2}>Two (recommended)</option>
          </select>
        </label>
        <label className="check">
          <input type="checkbox" checked={s.afterVisit} onChange={(e) => save({ ...s, afterVisit: e.target.checked })} />
          <span>Send a thank-you after a completed visit</span>
        </label>
        <div className="fu-quiet">
          <span>No automatic texts between</span>
          <select aria-label="Quiet hours start" value={s.quietStart} onChange={(e) => save({ ...s, quietStart: Number(e.target.value) })}>
            {hours.map(([h, l]) => (
              <option key={h} value={h}>
                {l}
              </option>
            ))}
          </select>
          <span>and</span>
          <select aria-label="Quiet hours end" value={s.quietEnd} onChange={(e) => save({ ...s, quietEnd: Number(e.target.value) })}>
            {hours.map(([h, l]) => (
              <option key={h} value={h}>
                {l}
              </option>
            ))}
          </select>
        </div>
      </details>
    </section>
  )
}

const BUSINESS_TYPES = [
  ['', 'Choose…'],
  ['sole_proprietor', 'Sole proprietor'],
  ['llc', 'LLC'],
  ['corporation', 'Corporation'],
  ['partnership', 'Partnership'],
  ['nonprofit', 'Nonprofit'],
]
// [key, label, hint, onlyForBusinessesWithEin]
const FIELDS = [
  ['legalName', 'Legal business name', 'Exactly as on your IRS EIN letter (or your own name if you’re a sole proprietor)'],
  ['ein', 'EIN (tax ID)', 'Not needed for sole proprietors', true],
  ['street', 'Street address', 'Not a P.O. box'],
  ['street2', 'Suite / unit', 'Optional'],
  ['city', 'City', ''],
  ['region', 'State', 'Two letters, e.g. SC'],
  ['postalCode', 'ZIP code', ''],
  ['website', 'Business website', 'Where customers find you'],
  ['firstName', 'Your first name', 'The person authorized to register the business'],
  ['lastName', 'Your last name', ''],
  ['repTitle', 'Your title', 'e.g. Owner', true],
  ['contactEmail', 'Your email', ''],
  ['contactPhone', 'Your mobile number', 'A real mobile number (sole proprietors get a one-time code here)'],
]
const SHOWN = ['legalName', 'businessType', 'address', 'website', 'contactName', 'contactEmail', 'contactPhone']
const FACT_LABELS = { legalName: 'Legal business name', businessType: 'Business type', address: 'Business address', website: 'Business website', contactName: 'Authorized representative', contactEmail: 'Email', contactPhone: 'Mobile' }
const INDUSTRIES = [
  ['', 'Choose…'],
  ['PROFESSIONAL', 'Professional / home services'],
  ['CONSTRUCTION', 'Construction / trades'],
  ['REAL_ESTATE', 'Real estate'],
  ['RETAIL', 'Retail'],
  ['HEALTHCARE', 'Health care'],
  ['HOSPITALITY', 'Hospitality'],
  ['TRANSPORTATION', 'Transportation'],
  ['AGRICULTURE', 'Agriculture / landscaping'],
  ['EDUCATION', 'Education / tutoring'],
  ['ENTERTAINMENT', 'Entertainment / events'],
  ['TECHNOLOGY', 'Technology'],
  ['FINANCIAL', 'Financial'],
  ['INSURANCE', 'Insurance'],
  ['LEGAL', 'Legal'],
  ['MANUFACTURING', 'Manufacturing'],
  ['ENERGY', 'Energy'],
  ['COMMUNICATION', 'Communication'],
  ['HUMAN_RESOURCES', 'Staffing / HR'],
  ['NGO', 'Nonprofit'],
]
const JOB_POSITIONS = ['', 'Director', 'GM', 'VP', 'CEO', 'CFO', 'General Counsel', 'Other']
const STATUS_TEXT = { not_configured: 'Not started', ready: 'Ready for your approval', pending: 'Pending with carriers', approved: 'Approved', rejected: 'Needs changes', suspended: 'Suspended' }

function Texting({ texting: t, channels, onSaved }) {
  const [editing, setEditing] = useState(false)
  const [form, setForm] = useState(() => ({
    ...Object.fromEntries(FIELDS.map(([k]) => [k, ''])),
    businessType: '',
    industry: '',
    repJobPosition: '',
    ...(t.facts ? { ...t.facts, ein: '' } : {}),
  }))
  const sole = form.businessType === 'sole_proprietor'
  const [bad, setBad] = useState([])
  const [agree, setAgree] = useState(false)
  const [msg, setMsg] = useState('')
  const canEdit = ['not_configured', 'ready', 'rejected'].includes(t.status)
  const save = async (e) => {
    e.preventDefault()
    setMsg('')
    const { status, data } = await api('/api/dashboard/followups/texting', { method: 'POST', body: { action: 'save', details: form } })
    if (status === 200) {
      setBad([])
      setEditing(false)
      onSaved()
    } else if (data?.fields) setBad(data.fields)
    else setMsg('Couldn’t save. Please try again.')
  }
  const approve = async () => {
    const { status } = await api('/api/dashboard/followups/texting', { method: 'POST', body: { action: 'approve', confirm: true } })
    if (status === 200) onSaved()
    else setMsg('Couldn’t record your approval. Please try again.')
  }
  return (
    <section className="card fu-texting" aria-label="Texting setup">
      <div className="fu-texting-head">
        <h2 className="card-title">Texting</h2>
        <span className={`fu-pill${t.status === 'approved' ? ' fu-pill--ok' : t.status === 'rejected' || t.status === 'suspended' ? ' fu-pill--bad' : ''}`}>{STATUS_TEXT[t.status]}</span>
      </div>
      {channels.sms ? (
        <p>{channels.smsTestMode ? 'Texting is set up. Texts go only to test recipients until GetShowUps finishes launch checks.' : 'Texting is on. Customers who agree to texts get replies, confirmations and reminders by text.'}</p>
      ) : (
        <p>{SMS_REASON[channels.smsReasons.find((r) => r.startsWith('registration_')) || channels.smsReasons[0]] || 'Texting isn’t available yet.'} Until then, follow-ups go by email.</p>
      )}
      {t.note && <p className="fu-attn">Carrier feedback: {t.note}</p>}
      {t.facts && !editing && (
        <dl className="fu-facts">
          {SHOWN.map((k) =>
            t.facts[k] ? (
              <div key={k}>
                <dt>{FACT_LABELS[k]}</dt>
                <dd>{k === 'businessType' ? BUSINESS_TYPES.find(([v]) => v === t.facts[k])?.[1] || t.facts[k] : t.facts[k]}</dd>
              </div>
            ) : null,
          )}
          {t.path && (
            <div>
              <dt>Carrier registration</dt>
              <dd>{t.path === 'sole_proprietor' ? 'Sole proprietor (no EIN)' : 'Low-volume business (EIN)'}</dd>
            </div>
          )}
        </dl>
      )}
      {canEdit && !editing && (
        <button type="button" className="btn btn-quiet btn-sm" onClick={() => setEditing(true)}>
          {t.facts ? 'Edit business details' : 'Start texting registration'}
        </button>
      )}
      {editing && (
        <form className="fu-form" onSubmit={save} noValidate>
          <p className="fine">US carriers require this once per business. We only use it for your registration.</p>
          <label className="field">
            <span>Business type</span>
            <select value={form.businessType} onChange={(e) => setForm({ ...form, businessType: e.target.value })} aria-invalid={bad.includes('businessType')}>
              {BUSINESS_TYPES.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </label>
          {sole && <p className="fine">Sole proprietors register with their own name and mobile number; carriers text a one-time code to that mobile to verify it.</p>}
          {FIELDS.map(([k, l, hint, einOnly]) =>
            einOnly && sole ? null : (
              <label key={k} className="field">
                <span>{l}</span>
                <input
                  value={form[k]}
                  inputMode={k === 'website' ? 'url' : k === 'contactPhone' ? 'tel' : k === 'contactEmail' ? 'email' : k === 'postalCode' ? 'numeric' : undefined}
                  maxLength={k === 'region' ? 2 : undefined}
                  onChange={(e) => setForm({ ...form, [k]: e.target.value })}
                  aria-invalid={bad.includes(k)}
                />
                {bad.includes(k) ? <span className="form-error">Please check this.</span> : hint ? <span className="fine">{hint}</span> : null}
              </label>
            ),
          )}
          {!sole && (
            <label className="field">
              <span>Your position</span>
              <select value={form.repJobPosition} onChange={(e) => setForm({ ...form, repJobPosition: e.target.value })} aria-invalid={bad.includes('repJobPosition')}>
                {JOB_POSITIONS.map((v) => (
                  <option key={v} value={v}>
                    {v || 'Choose…'}
                  </option>
                ))}
              </select>
              {bad.includes('repJobPosition') && <span className="form-error">Please choose one.</span>}
            </label>
          )}
          <label className="field">
            <span>Industry</span>
            <select value={form.industry} onChange={(e) => setForm({ ...form, industry: e.target.value })} aria-invalid={bad.includes('industry')}>
              {INDUSTRIES.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
            {bad.includes('industry') && <span className="form-error">Please choose one.</span>}
          </label>
          <div className="card-actions">
            <button type="submit" className="btn btn-primary btn-sm">
              Save details
            </button>
            <button type="button" className="link-btn" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}
      {t.status === 'ready' && !t.approvedAt && !editing && (
        <div className="fu-approve">
          <h3>Review and approve</h3>
          <p className="fine">What carriers will see:</p>
          <p>{t.useCase}</p>
          <p className="fine">How customers agree to texts:</p>
          <p>{t.messageFlow}</p>
          <p className="fine">Example messages:</p>
          <ul className="fu-samples">
            {t.samples.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
          <label className="check">
            <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
            <span>{t.attestation}</span>
          </label>
          <p className="fine">
            Once you approve, the optional texting box appears on your booking page and website forms so carriers can review it. No texts are sent until
            carriers approve your registration. <a href={t.termsUrl}>Your texting terms</a>
          </p>
          <button type="button" className="btn btn-primary btn-sm" disabled={!agree} onClick={approve}>
            Approve submission
          </button>
        </div>
      )}
      {t.status === 'ready' && t.approvedAt && <p className="fine">Thanks. The texting box is now on your booking page and website forms. GetShowUps will submit your registration to the carriers and update this status; no texts go out before carriers approve.</p>}
      {msg && <p className="form-error">{msg}</p>}
    </section>
  )
}
