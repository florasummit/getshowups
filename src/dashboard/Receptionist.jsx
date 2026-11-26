import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import AiWrite from './AiWrite.jsx'
import { api, phoneText, whenFull } from '../lib/api.js'
import { Ago, PageHeader, Pill, SaveStatus, Section } from './ui.jsx'
import { useSaveState } from './ui-hooks.js'
import ReceptionistVoice from './ReceptionistVoice.jsx'

// Owner: the AI receptionist. Order = what an owner needs first: is it working → who needs me → what it booked →
// what happened in each conversation → settings. Every status is the real one; nothing that isn't connected looks on.
const MODES = [
  ['ai_first', 'AI answers'],
  ['human_first', 'Your team first, AI if nobody picks up'],
  ['after_hours', 'Your team during business hours, AI after hours'],
]
// How the team was (or wasn't) told about a request, never assumed: the state comes from the email records, and each
// says in one sentence whether an email went out. `emailOn` = owner emails are being delivered (capabilities.staffEmail).
const NO_EMAIL = 'Emails to your team aren’t switched on yet'
const notifyFor = (state, emailOn) =>
  ({
    recorded: ['info', 'Recorded', emailOn ? 'No email yet: your team is emailed about this within a few minutes.' : `You haven’t been emailed about this. ${NO_EMAIL}, so it waits here.`],
    pending: ['info', 'Email queued', 'An email to your team about this is on its way.'],
    sent: ['ok', 'Team emailed', 'Your team was emailed about this.'],
    failed: ['bad', 'Email failed', 'The email to your team failed, so nobody was told. Please call them back from here.'],
    not_sent: ['warn', 'Not emailed', `You weren’t emailed about this. ${NO_EMAIL}, so please check this page.`],
  })[state]
// A conversation that asked for a person needs attention until every request it left is marked done (`handled`, from
// the server); then it counts as completed, like the request list above it.
const CATEGORY = { booked: ['ok', 'Booked'], handoff: ['bad', 'Needs attention'] }
const kindOf = (c) => (c.status === 'handoff' && c.handled ? 'closed' : CATEGORY[c.status] ? c.status : 'closed')
const category = (c) => CATEGORY[kindOf(c)] || ['neutral', 'Completed']
// Plain-language activity for owners. Internal-only events (overlaps, removed narration) are not shown.
const REASON = {
  slot_unavailable: 'the time was just taken',
  confirmation_required: 'waiting for the customer to confirm',
  details_missing: 'some details were missing',
  out_of_area: 'outside your service area',
  slot_not_offered: 'that time wasn’t offered',
  name_needed: 'needed their name first',
  phone_needed: 'needed a phone number first',
  contact_needed: 'needed a phone number or email first',
  calendar_unavailable: 'your calendar couldn’t be reached',
  rules_not_ready: 'your AI rules needed something first',
  not_said: 'the customer hadn’t said it yet',
}
const ACTIVITY = {
  save_customer_details: ['Noted the customer’s details', 'Asked the customer to repeat a detail'],
  check_service_area: ['Checked your service area', 'Couldn’t check the service area'],
  find_available_times: ['Looked up open times on your calendar', 'Couldn’t look up times'],
  book_appointment: ['Booked the appointment', 'Not booked'],
  request_callback: ['Recorded a callback request', 'Callback request not recorded yet'],
  leave_message: ['Recorded a message', 'Message not recorded yet'],
  blocked_price: [null, 'Held back a price that isn’t in your Settings'],
  model: [null, 'The AI was briefly unavailable; the customer was given your booking link'],
  limit: [null, 'Conversation limit reached; the customer was given your booking link'],
  ended: ['Customer ended the conversation', null],
  note_answer: ['Noted an answer to one of your questions', null],
}
function activity(e) {
  const [ok, fail] = ACTIVITY[e.kind] || []
  const label = e.ok ? ok : fail
  if (!label) return null
  const why = !e.ok && REASON[e.detail] ? ` (${REASON[e.detail]})` : e.ok && e.kind === 'request_callback' && e.detail === 'urgent' ? ' (urgent)' : ''
  return label + why
}
const channelName = (c) => (c === 'voice' ? 'Browser voice' : 'Chat')

// Every tile states the channel's real state, the reason and the next step, from the server's capability facts
// (functions/api/dashboard/receptionist/index.js: chat = model configured; voiceStatus = the business's ACTIVE voice
// provider resolved server-side: 'available' | 'testing' (Retell not released for this business, RECEPTIONIST_VOICE_
// BUSINESSES) | 'not_configured'; staffEmail = the MESSAGES_LIVE gate; no phone line exists). Never a hardcoded state.
function channelTiles(cap, on, chatUrl, admin, panel) {
  const voice = !on
    ? ['neutral', 'Off', 'Turn the receptionist on below; voice follows the same switch as chat.']
    : cap.voiceStatus === 'available'
      ? ['ok', 'Active', 'Customers can talk to it by microphone on your chat page; it books the same way as chat.']
      : cap.voiceStatus === 'testing'
        ? ['neutral', 'Not turned on yet', `Customers can’t talk to it by microphone yet; chat answers meanwhile. GetShowUps turns browser voice on business by business: to ask for yours, email hello@getshowups.com. This tile says Active once it is on.${admin ? ' Admin: add it to the Retell release list (RECEPTIONIST_VOICE_BUSINESSES) or switch its provider in the Admin Console.' : ''}`]
        : ['neutral', 'Not available', 'The voice provider is not configured on the platform; chat works meanwhile.']
  return [
    ['Website chat', !on ? ['neutral', 'Off', 'Turn it on below.'] : cap.chatClosed === 'setup' ? ['warn', 'Not reachable yet', 'It is on, but customers can open the chat only once your calendar is connected and your booking hours are confirmed in Settings.'] : cap.chat ? ['ok', 'Active', panel ? `Customers chat in a panel on your website, or at ${chatUrl}.` : `Customers chat at ${chatUrl}, linked from your website.`] : ['bad', 'Unavailable', 'The AI model is not configured on the platform, so nothing answers.']],
    ['Browser voice', voice],
    ['Phone calls', ['neutral', 'Not available yet', 'No phone line can be connected yet: calls are not answered, transferred or dialed.']],
    ['Team notifications', cap.staffEmail === 'live' ? ['ok', 'Email on', 'Your team gets an email about each callback request and message.'] : ['warn', 'Email off', `You won’t get an email about a callback request or message right now. ${NO_EMAIL}; every request shows on this page.`]],
  ]
}
function Channels({ cap, on, chatUrl, admin, panel }) {
  return (
    <ul className="ui-tiles" aria-label="Channels">
      {channelTiles(cap, on, chatUrl, admin, panel).map(([label, [tone, text, hint]]) => (
        <li key={label} className="ui-tile" data-channel={label}>
          <span className="ui-tile-label">{label}</span>
          <Pill tone={tone}>{text}</Pill>
          <span className="ui-tile-hint">{hint}</span>
        </li>
      ))}
    </ul>
  )
}

function Request({ r, onResolve, onView, busy, emailOn }) {
  const [tone, label, detail] = notifyFor(r.notification, emailOn) || notifyFor('recorded', emailOn)
  return (
    <li className="ui-inbox-item">
      <div className="ui-inbox-main">
        <p className="ui-inbox-title">
          {r.urgent && <Pill tone="bad">Urgent</Pill>} {r.kind === 'callback' ? `Call back ${r.name || 'a customer'}` : `Message from ${r.name || 'a customer'}`}
        </p>
        {r.note && <p className="ui-inbox-note">{r.note}</p>}
        <p className="ui-inbox-meta">
          {r.phone && <a href={`tel:${r.phone}`}>{phoneText(r.phone)}</a>}
          {r.email && <a href={`mailto:${r.email}`}>{r.email}</a>}
          <span>
            Received <Ago t={r.createdAt} />
          </span>
          <Pill tone={tone}>{label}</Pill>
        </p>
        <p className="ui-hint" data-notify={r.notification}>
          {detail}
        </p>
      </div>
      <div className="ui-inbox-actions">
        {r.phone && (
          <a className="btn btn-sm btn-quiet" href={`tel:${r.phone}`}>
            Call
          </a>
        )}
        <button type="button" className="btn btn-sm btn-quiet" onClick={() => onView(r.conversationId)}>
          View conversation
        </button>
        <button type="button" className="btn btn-sm btn-primary" onClick={() => onResolve(r.id)} disabled={busy}>
          Mark done
        </button>
      </div>
    </li>
  )
}

function Detail({ d, onClose }) {
  const [tone, label] = category(d)
  const steps = d.events.map((e) => ({ ...e, text: activity(e) })).filter((e) => e.text)
  const c = d.collected || {}
  const facts = [
    ['Name', c.name],
    [
      'Phone',
      c.phone && (
        <a key="phone" href={`tel:${c.phone}`}>
          {phoneText(c.phone)}
        </a>
      ),
    ],
    ['Email', c.email],
    ['Needs', c.need],
    ['Address', c.address],
    ['ZIP', !c.address && c.zip],
  ].filter(([, v]) => v)
  return (
    <article className="ui-detail" aria-label="Conversation detail">
      <header className="ui-detail-head">
        <div>
          <h3 className="ui-detail-title">{d.customerName || 'Customer'}</h3>
          <p className="ui-detail-meta">
            {channelName(d.channel)} · {whenFull(d.createdAt)}
          </p>
        </div>
        <Pill tone={tone}>{label}</Pill>
        <button type="button" className="ui-icon-btn" onClick={onClose} aria-label="Close conversation">
          ×
        </button>
      </header>
      <div className={`ui-outcome ui-outcome--${d.bookedAt ? 'ok' : d.request?.open ? 'bad' : 'neutral'}`}>
        {d.bookedAt ? (
          <>
            <strong>Booked</strong> for {whenFull(d.bookedAt)}. <a href="/dashboard/appointments">Open Appointments</a>
          </>
        ) : d.request ? (
          <>
            <strong>{d.request.kind === 'callback' ? 'Callback requested' : 'Message left'}</strong>
            {d.request.urgent ? ' (urgent)' : ''}. {d.request.open ? 'Still open, in Needs attention above.' : 'Marked done.'}
          </>
        ) : (
          <>
            <strong>No follow-up needed.</strong> {d.summary || ''}
          </>
        )}
      </div>
      {facts.length > 0 && (
        <dl className="ui-facts">
          {facts.map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
      )}
      <div className="ui-transcript" aria-label="Transcript">
        {d.transcript.map((l, i) => (
          <div key={i} className={`ui-bubble ui-bubble--${l.who}`}>
            <p>{l.text}</p>
            <span className="ui-bubble-meta">
              {l.who === 'customer' ? 'Customer' : 'Receptionist'}
              {l.channel === 'voice' ? ' · said' : ''}
              {l.at ? ` · ${new Date(l.at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}` : ''}
            </span>
          </div>
        ))}
      </div>
      {steps.length > 0 && (
        <details className="ui-activity">
          <summary>What the receptionist did</summary>
          <ol>
            {steps.map((e, i) => (
              <li key={i} className={e.ok ? '' : 'ui-step--miss'}>
                <span>{e.text}</span>
                <time dateTime={new Date(e.at).toISOString()}>{new Date(e.at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}</time>
              </li>
            ))}
          </ol>
        </details>
      )}
    </article>
  )
}

export default function Receptionist() {
  const [data, setData] = useState(null)
  const [form, setForm] = useState(null)
  const [saved, setSaved] = useState(null)
  const [msg, setMsg] = useState('')
  // The two switches (answering on/off, website panel) save the moment they change, each with its own confirmation
  // beside the control that was used. `turning` / `paneling` = the choice on its way to the server (shown at once).
  const power = useSaveState()
  const [turning, setTurning] = useState(null)
  const [powerAt, setPowerAt] = useState('switch')
  const panelSave = useSaveState()
  const [paneling, setPaneling] = useState(null)
  const [open, setOpen] = useState(null)
  const [detail, setDetail] = useState(null)
  const [filter, setFilter] = useState('all')
  const [busy, setBusy] = useState(false)
  const detailRef = useRef(null)
  const load = useCallback(
    () =>
      api('/api/dashboard/receptionist').then(({ status, data: d }) => {
        setData(status === 200 ? { ...d, loadedAt: Date.now() } : { failed: true })
        if (status === 200 && d.ready) {
          setForm((f) => f || d.settings)
          setSaved((s) => s || d.settings)
        }
      }),
    [],
  )
  // Fresh whenever the owner comes back to this tab (e.g. after testing as a customer), and every 20 s while visible.
  useEffect(() => {
    load()
    const onFocus = () => document.visibilityState === 'visible' && load()
    const timer = setInterval(onFocus, 20_000)
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onFocus)
    return () => {
      clearInterval(timer)
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onFocus)
    }
  }, [load])
  useEffect(() => {
    if (!open) return
    api(`/api/dashboard/receptionist?id=${encodeURIComponent(open)}`).then(({ status, data: d }) => setDetail(status === 200 ? d.conversation : null))
  }, [open, data])
  const view = (id) => {
    setFilter('all')
    setOpen(id)
    setTimeout(() => detailRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50)
  }
  const shown = useMemo(() => (data?.conversations || []).filter((c) => filter === 'all' || kindOf(c) === filter), [data, filter])

  if (!data) return <div aria-busy="true" className="ui-skeleton-page" />
  if (data.failed)
    return (
      <p className="form-error" role="alert">
        Couldn’t load the receptionist.{' '}
        <button type="button" className="link-btn" onClick={load}>
          Try again
        </button>
      </p>
    )
  if (!data.ready) return <p className="fine">The AI receptionist is being set up for your account.</p>

  const cap = data.capabilities
  const dirty = JSON.stringify(form) !== JSON.stringify(saved)
  const save = async (e) => {
    e.preventDefault()
    setMsg('')
    setBusy(true)
    const { status, data: d } = await api('/api/dashboard/receptionist', { method: 'POST', body: { action: 'settings', ...form } })
    setBusy(false)
    setMsg(status === 200 ? 'Saved.' : d.error === 'invalid_phone' ? 'Check the team phone number.' : 'Couldn’t save. Please try again.')
    if (status === 200) {
      setForm(d.settings)
      setSaved(d.settings)
      load()
    }
  }
  // On/off: saved at once, with the SAVED greeting, notes and phone choices (a half-edited greeting is never saved by
  // flipping the switch; it keeps waiting for Save). `at` = which control was used, so the confirmation shows there.
  const setEnabled = (value, at = 'switch') => {
    setPowerAt(at)
    setTurning(value)
    return power
      .run(async () => {
        const { status, data: d } = await api('/api/dashboard/receptionist', { method: 'POST', body: { action: 'settings', ...saved, enabled: value } })
        if (status !== 200) return { error: value ? 'Couldn’t turn it on. Please try again.' : 'Couldn’t turn it off. Please try again.' }
        setSaved(d.settings)
        setForm((f) => ({ ...f, enabled: d.settings.enabled }))
        await load()
        return { saved: value ? 'Saved. The receptionist is on.' : 'Saved. The receptionist is off: customers can’t chat with it.' }
      })
      .finally(() => setTurning(null))
  }
  // Website chat panel: the same pattern (its own small save, not part of the settings form).
  const setPanel = (value) => {
    setPaneling(value)
    return panelSave
      .run(async () => {
        const { status } = await api('/api/dashboard/receptionist', { method: 'POST', body: { action: 'website_panel', on: value } })
        if (status !== 200) return { error: true }
        await load()
        return { saved: value ? 'Saved. Your website now opens the chat in a panel. It can take a minute to show.' : 'Saved. Your website shows the chat link. It can take a minute to show.' }
      })
      .finally(() => setPaneling(null))
  }
  const resolve = async (requestId, action = 'resolve') => {
    setBusy(true)
    const { status } = await api('/api/dashboard/receptionist', { method: 'POST', body: { action, requestId } })
    setBusy(false)
    if (status === 200) load()
  }
  const on = saved.enabled
  // The headline names what answers today (chat, and voice only where it is really on for this business).
  const overall = !on ? ['neutral', 'Off'] : !cap.chat || cap.chatClosed ? ['bad', 'Not answering'] : cap.voiceStatus === 'available' ? ['ok', 'Answering on chat and browser voice'] : ['ok', 'Answering on website chat']
  const attention = data.requests.filter((r) => r.status === 'open')
  const done = data.requests.filter((r) => r.status !== 'open')
  const upcoming = data.conversations.filter((c) => c.bookedAt && new Date(c.bookedAt).getTime() > data.loadedAt)
  const counts = { all: data.conversations.length, booked: data.conversations.filter((c) => kindOf(c) === 'booked').length, handoff: data.conversations.filter((c) => kindOf(c) === 'handoff').length }
  counts.closed = counts.all - counts.booked - counts.handoff
  const emailOn = cap.staffEmail === 'live'
  const panelOn = paneling ?? Boolean(data.websitePanel?.on)
  // "Try it as a customer" is offered only when the customer chat page really opens (capabilities.chatClosed, the same
  // checks as that page). Otherwise: the reason, and when the reason is the off switch, the one tap that fixes it.
  const tryIt = (at) =>
    !cap.chatClosed ? (
      <a className="btn btn-quiet btn-sm" href={data.chatUrl} target="_blank" rel="noreferrer">
        Try it as a customer
      </a>
    ) : (
      <div className="rx-try-off" data-try-closed={cap.chatClosed}>
        <span className="fine">
          {cap.chatClosed === 'off'
            ? 'You can try it as a customer once it’s on: the chat page is closed while the receptionist is off.'
            : cap.chatClosed === 'setup'
              ? 'You can try it as a customer once your calendar is connected and your booking hours are confirmed in Settings.'
              : 'The chat isn’t answering right now, so there is nothing to try yet.'}
        </span>
        {cap.chatClosed === 'off' && (
          <button type="button" className="btn btn-primary btn-sm" disabled={power.pending} onClick={() => setEnabled(true, at)}>
            {power.pending ? 'Turning on…' : 'Turn on'}
          </button>
        )}
        {powerAt === at && <SaveStatus save={power} />}
      </div>
    )
  return (
    <div className="ui-page">
      <PageHeader
        title="AI receptionist"
        status={
          <>
            <Pill tone="neutral" dot={false}>
              Beta
            </Pill>
            <Pill tone={overall[0]}>{overall[1]}</Pill>
          </>
        }
        actions={
          <>
            {tryIt('header')}
            {!cap.chatClosed && powerAt === 'header' && <SaveStatus save={power} />}
          </>
        }
      >
        {on ? 'Answers questions, books real appointments on your calendar, and takes callback requests when someone wants a person.' : 'Turn it on below to answer customers on your website.'}
      </PageHeader>
      <Channels cap={cap} on={on} chatUrl={data.chatUrl} admin={Boolean(data.admin)} panel={Boolean(data.websitePanel?.on)} />

      <Section title={attention.length ? `Needs attention (${attention.length})` : 'Needs attention'} label="Needs attention" className={attention.length ? 'ui-section--attention' : ''}>
        {attention.length ? (
          <ul className="ui-inbox">
            {attention.map((r) => (
              <Request key={r.id} r={r} onResolve={resolve} onView={view} busy={busy} emailOn={emailOn} />
            ))}
          </ul>
        ) : (
          <p className="ui-all-clear">
            <Pill tone="ok">All caught up</Pill> Nobody is waiting on you.
          </p>
        )}
        {done.length > 0 && (
          <details className="ui-done-list">
            <summary>Done ({done.length})</summary>
            <ul>
              {done.slice(0, 10).map((r) => (
                <li key={r.id}>
                  <span>
                    {r.kind === 'callback' ? 'Callback' : 'Message'}: {r.name} · <Ago t={r.createdAt} />
                  </span>
                  <button type="button" className="link-btn" disabled={busy} onClick={() => resolve(r.id, 'reopen')} aria-label={`Reopen the ${r.kind === 'callback' ? 'callback request' : 'message'} from ${r.name || 'a customer'}`}>
                    Reopen
                  </button>
                </li>
              ))}
            </ul>
          </details>
        )}
      </Section>

      {upcoming.length > 0 && (
        <Section title="Booked by the receptionist" action={<a className="link-btn" href="/dashboard/appointments">All appointments</a>}>
          <ul className="ui-list">
            {upcoming.map((c) => (
              <li key={c.id} className="ui-list-row">
                <span className="ui-list-main">
                  <strong>{c.customerName || 'Customer'}</strong>
                  {c.need ? ` · ${c.need}` : ''}
                </span>
                <span className="ui-list-side">{whenFull(c.bookedAt)}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section
        title="Conversations"
        label="Receptionist conversations"
        action={
          <button type="button" className="link-btn" onClick={load}>
            Refresh
          </button>
        }
      >
        {data.conversations.length === 0 ? (
          <div className="ui-empty-state">
            <p>
              <strong>No conversations yet.</strong>
            </p>
            <p className="fine">When customers chat or talk with the receptionist, every conversation shows up here.{cap.chatClosed ? '' : ' Try it yourself first.'}</p>
            {tryIt('empty')}
            {!cap.chatClosed && powerAt === 'empty' && <SaveStatus save={power} />}
          </div>
        ) : (
          <>
            <div className="fchips" role="group" aria-label="Show">
              {[
                ['all', 'All'],
                ['booked', 'Booked'],
                ['handoff', 'Needs attention'],
                ['closed', 'Completed'],
              ].map(([v, l]) => (
                <button key={v} type="button" className="fchip" aria-pressed={filter === v} onClick={() => setFilter(v)}>
                  {l} <span className="fchip-count">{counts[v]}</span>
                </button>
              ))}
            </div>
            <div className={`ui-split${open ? ' ui-split--open' : ''}`}>
              <ul className="ui-convs">
                {shown.map((c) => {
                  const [tone, label] = category(c)
                  return (
                    <li key={c.id}>
                      <button type="button" className="ui-conv" onClick={() => (open === c.id ? setOpen(null) : view(c.id))} aria-expanded={open === c.id} aria-current={open === c.id || undefined}>
                        <span className="ui-conv-top">
                          <span className="ui-conv-name">{c.customerName || 'Customer'}</span>
                          <span className="ui-conv-when">
                            <Ago t={c.updatedAt} />
                          </span>
                        </span>
                        <span className="ui-conv-sub">
                          <Pill tone={tone}>{label}</Pill>
                          <span>{channelName(c.channel)}</span>
                          {c.summary && <span className="ui-conv-summary">{c.summary}</span>}
                        </span>
                      </button>
                    </li>
                  )
                })}
                {shown.length === 0 && <li className="fine">Nothing here.</li>}
              </ul>
              <div ref={detailRef} className="ui-split-detail">
                {open && detail && detail.id === open && <Detail d={detail} onClose={() => setOpen(null)} />}
                {open && (!detail || detail.id !== open) && <div className="ui-skeleton-block" aria-busy="true" />}
              </div>
            </div>
          </>
        )}
      </Section>

      {data.websitePanel && (
        <Section title="On your website" label="Website chat panel">
          <div className="ui-settings">
            <fieldset className="ui-group">
              <legend>How customers open the chat</legend>
              <label className="ui-switch-row">
                <input type="checkbox" role="switch" checked={panelOn} disabled={panelSave.pending} onChange={(e) => setPanel(e.target.checked)} />
                <span>
                  <strong>Open the chat in a panel on my website</strong>
                  <span className="ui-hint">
                    {panelOn ? 'Visitors chat without leaving your site.' : 'Off: your website shows a “Chat or talk with us” button that opens the chat page.'} It’s the same receptionist either way, and it only appears while the receptionist is
                    on.
                  </span>
                </span>
              </label>
              <SaveStatus save={panelSave} />
            </fieldset>
          </div>
        </Section>
      )}

      <Section title="Settings" label="Receptionist settings">
        <form className="ui-settings" onSubmit={save}>
          <fieldset className="ui-group">
            <legend>Answering</legend>
            <label className="ui-switch-row">
              <input type="checkbox" role="switch" checked={turning ?? on} disabled={power.pending} onChange={(e) => setEnabled(e.target.checked)} />
              <span>
                <strong>Answer customers with the AI receptionist</strong>
                <span className="ui-hint">On your website’s chat and browser voice. It checks your real calendar and books only after the customer confirms. Saved as soon as you switch it.</span>
              </span>
            </label>
            {powerAt === 'switch' && <SaveStatus save={power} />}
          </fieldset>
          <fieldset className="ui-group">
            <legend>What it says and knows</legend>
            <label className="field">
              <span>Greeting</span>
              <input value={form.greeting} maxLength={240} onChange={(e) => setForm({ ...form, greeting: e.target.value })} placeholder="Hi! Thanks for reaching out. How can we help?" />
            </label>
            <AiWrite field="greeting" draft />
            <label className="field">
              <span>Notes for the receptionist</span>
              <textarea rows={4} maxLength={3000} value={form.knowledge} onChange={(e) => setForm({ ...form, knowledge: e.target.value })} placeholder={'e.g. Weekly service includes chemicals.\nWe don’t service commercial pools.'} />
              <span className="ui-hint">
                Services, prices, service area and hours come from <a href="/dashboard/settings">Settings</a>, so you only keep them in one place. If a note disagrees with a listed price,
                the listed price is used.
              </span>
              <span className="ui-hint" data-also="teach-excluded">
                A note like “We don’t service commercial pools” is something your AI reads and answers from. <a href="/dashboard/teach#ta-about">Teach Your AI → Services you don’t offer</a> is the stricter list: a
                service on it is also never booked, once your published rules are used with customers. The two add up, and that list decides whether a booking is refused.
              </span>
            </label>
            {data.warnings.map((w) => (
              <p key={w} className="ui-callout ui-callout--warn" role="note">
                {w}
              </p>
            ))}
          </fieldset>
          <fieldset className="ui-group">
            <legend>When someone asks for a person</legend>
            <p className="ui-hint">
              {cap.callbacks
                ? 'It explains it can’t transfer them, then records a callback request or a message with their name and number. It shows up in Needs attention above.'
                : 'It gives them your business phone number.'}{' '}
              {emailOn ? 'Your team is also emailed.' : `${NO_EMAIL}, so check this page.`}
            </p>
            <p className="ui-hint" data-also="teach-handoffs">
              This always happens, on chat and voice. <a href="/dashboard/teach#ta-how">Teach Your AI → Hand-offs to your team</a> can’t switch it off: a rule there only picks which is offered (a callback request or a message)
              and adds other situations, once your published rules are used with customers.
            </p>
          </fieldset>
          <details className="ui-group ui-group--advanced rx-phone">
            <summary>
              Phone calls (not available yet) <Pill tone="neutral">Not available yet</Pill>
            </summary>
            <p className="ui-hint">No phone number is connected yet, so phone calls aren’t answered or transferred and nothing is dialed. These choices are kept for when a line is connected.</p>
            <fieldset className="field" disabled>
              <legend>Who answers phone calls</legend>
              {MODES.map(([v, l]) => (
                <label key={v} className="check">
                  <input type="radio" name="mode" checked={form.mode === v} onChange={() => setForm({ ...form, mode: v })} />
                  <span>{l}</span>
                </label>
              ))}
            </fieldset>
            <label className="field">
              <span>Team number for transfers (optional)</span>
              <input value={form.transferPhone} inputMode="tel" onChange={(e) => setForm({ ...form, transferPhone: e.target.value })} placeholder="(843) 555-0100" />
              <span className="ui-hint">Not used until a phone line is connected.</span>
            </label>
          </details>
          <div className="ui-form-actions">
            <button type="submit" className="btn btn-primary btn-sm" disabled={busy || !dirty}>
              {busy ? 'Saving…' : 'Save'}
            </button>
            <span className="fine" role="status">
              {msg || (dirty ? 'Unsaved changes' : '')}
            </span>
          </div>
        </form>
      </Section>

      {/* Voice is a refinement of an answering receptionist, so it follows the on/off switch, greeting and notes. */}
      {data.voice && <ReceptionistVoice voice={data.voice} admin={Boolean(data.admin)} providers={data.providers || null} reload={load} heard={on && !cap.chatClosed && cap.voiceStatus === 'available'} off={!on} />}
    </div>
  )
}
