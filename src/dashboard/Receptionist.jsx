import { useCallback, useEffect, useState } from 'react'
import { api } from '../lib/api.js'

// Owner: the AI receptionist on one screen. What needs attention first, then recent conversations, then settings.
// Every status is the real one; nothing that isn't connected is presented as working.
const MODES = [
  ['ai_first', 'AI answers'],
  ['human_first', 'Your team first, AI if nobody picks up'],
  ['after_hours', 'Your team during business hours, AI after hours'],
]
const NOTIFY = {
  recorded: 'Recorded here. Checking within 5 minutes whether your team can be emailed.',
  sent: 'Emailed to your team',
  pending: 'Email to your team is on its way',
  failed: 'Email to your team failed. Please call them back from here.',
  not_sent: 'Not emailed (messaging is in test mode). Please check here.',
}
const EVENT = {
  save_customer_details: 'Saved customer details',
  check_service_area: 'Checked service area',
  find_available_times: 'Looked up open times',
  book_appointment: 'Booking',
  request_callback: 'Recorded a callback request',
  leave_message: 'Recorded a message',
  blocked_price: 'Blocked a price not in your records',
  blocked_narration: 'Removed text not meant for the customer',
  model: 'AI unavailable',
  limit: 'Limit reached',
  ended: 'Customer ended the conversation',
  concurrent_turn: 'Overlapping turn',
}
// A refused/failed action reads as what did NOT happen (the detail says why), never like the success.
const EVENT_FAILED = {
  save_customer_details: 'Some details need checking',
  find_available_times: 'Couldn’t look up times',
  book_appointment: 'Not booked',
  request_callback: 'Callback request not recorded yet',
  leave_message: 'Message not recorded yet',
}
const eventLabel = (e) => (!e.ok && EVENT_FAILED[e.kind]) || EVENT[e.kind] || e.kind
const when = (t) => new Date(t).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
const category = (c) => (c.status === 'booked' ? ['Booked', 'ok'] : c.status === 'handoff' ? ['Needs attention', 'attn'] : ['Completed', ''])

function Status({ ok, children }) {
  return (
    <li className={`rx-status${ok ? ' rx-status--ok' : ''}`}>
      <span aria-hidden="true">{ok ? '●' : '○'}</span> {children}
    </li>
  )
}

export default function Receptionist() {
  const [data, setData] = useState(null)
  const [form, setForm] = useState(null)
  const [msg, setMsg] = useState('')
  const [open, setOpen] = useState(null)
  const [detail, setDetail] = useState(null)
  const load = useCallback(
    () =>
      api('/api/dashboard/receptionist').then(({ status, data: d }) => {
        setData(status === 200 ? d : { failed: true })
        if (status === 200 && d.ready) setForm((f) => f || d.settings)
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
    if (open) api(`/api/dashboard/receptionist?id=${encodeURIComponent(open)}`).then(({ status, data: d }) => setDetail(status === 200 ? d.conversation : null))
  }, [open, data])

  if (!data) return <div aria-busy="true" />
  if (data.failed) return <p className="form-error">Couldn’t load the receptionist. Please refresh.</p>
  if (!data.ready) return <p className="fine">The AI receptionist is being set up for your account.</p>

  const save = async (e) => {
    e.preventDefault()
    setMsg('')
    const { status, data: d } = await api('/api/dashboard/receptionist', { method: 'POST', body: { action: 'settings', ...form } })
    setMsg(status === 200 ? 'Saved.' : d.error === 'invalid_phone' ? 'Check the team phone number.' : 'Couldn’t save. Please try again.')
    if (status === 200) {
      setForm(d.settings)
      load()
    }
  }
  const resolve = async (requestId) => {
    const { status } = await api('/api/dashboard/receptionist', { method: 'POST', body: { action: 'resolve', requestId } })
    if (status === 200) load()
  }
  const cap = data.capabilities
  const attention = data.requests.filter((r) => r.status === 'open')
  return (
    <div className="rx-grid">
      <div className="rx-row rx-head">
        <h1 className="title title--page">AI receptionist</h1>
        <a className="btn btn-quiet btn-sm" href={data.chatUrl} target="_blank" rel="noreferrer">
          Try it as a customer
        </a>
      </div>
      <ul className="rx-statuses" aria-label="What's working">
        <Status ok={form.enabled && cap.chat}>{form.enabled && cap.chat ? 'Answering website chat' : form.enabled ? 'Chat is waiting for GetShowUps to switch the AI on' : 'Off: customers can’t chat with it yet'}</Status>
        <Status ok={form.enabled && cap.voice}>{cap.voice ? 'Customers can talk to it from your website (browser microphone)' : 'Browser voice isn’t set up'}</Status>
        <Status ok={false}>Phone calls: no phone number connected yet</Status>
        <Status ok={cap.callbacks}>{cap.callbacks ? 'When someone asks for a person, it records a callback request or message for you below. It can’t transfer calls.' : 'When someone asks for a person, it gives your phone number'}</Status>
      </ul>

      {attention.length > 0 && (
        <section className="card" aria-label="Needs attention">
          <h2 className="card-title">Needs attention ({attention.length})</h2>
          <ul className="rows">
            {attention.map((r) => (
              <li key={r.id} className="row">
                <div className="row-main">
                  <p className="row-title">
                    {r.urgent && <span className="tag tag--bad">Urgent</span>} {r.kind === 'callback' ? 'Call back' : 'Message from'} {r.name || 'a customer'}
                    {r.phone && (
                      <>
                        {' · '}
                        <a href={`tel:${r.phone}`}>{r.phone}</a>
                      </>
                    )}
                  </p>
                  <p className="row-sub">
                    {r.note} · {when(r.createdAt)}
                  </p>
                  <p className="fine">{NOTIFY[r.notification]}</p>
                </div>
                <button type="button" className="btn btn-sm btn-quiet" onClick={() => resolve(r.id)}>
                  Mark done
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="card" aria-label="Receptionist conversations">
        <div className="rx-row">
          <h2 className="card-title">Conversations</h2>
          <span className="fine">
            {data.counts.booked} booked · {data.counts.needsAttention} need attention · {data.counts.total} total
          </span>
          <button type="button" className="link-btn" onClick={load}>
            Refresh
          </button>
        </div>
        {data.conversations.length === 0 ? (
          <p className="empty">No conversations yet. Use “Try it as a customer” to test.</p>
        ) : (
          <ul className="rows">
            {data.conversations.map((c) => {
              const [label, tone] = category(c)
              return (
                <li key={c.id} className="row">
                  <button type="button" className="row-main link-btn rx-open" onClick={() => setOpen(open === c.id ? null : c.id)} aria-expanded={open === c.id}>
                    <span className="row-title">
                      <span className={`tag${tone === 'ok' ? ' tag--ok' : tone === 'attn' ? ' tag--bad' : ''}`}>{label}</span> {c.customerName || 'Customer'} · {c.channel === 'voice' ? 'Voice' : 'Chat'} · <span className="fine">{when(c.updatedAt)}</span>
                    </span>
                    <span className="row-sub">{c.summary || ''}</span>
                  </button>
                </li>
              )
            })}
          </ul>
        )}
        {open && detail && detail.id === open && (
          <div className="rx-convo" aria-label="Conversation detail">
            {detail.transcript.map((l, i) => (
              <p key={i} className={`rc-msg rc-msg--${l.who}`}>
                {l.channel === 'voice' && <span className="rc-tag">said</span>}
                {l.text}
              </p>
            ))}
            <details>
              <summary className="fine">What the receptionist did</summary>
              <ol className="rx-events">
                {detail.events.map((e, i) => (
                  <li key={i} className={e.ok ? '' : 'bad'}>
                    {eventLabel(e)}
                    {e.detail ? ` (${e.detail})` : ''} · {when(e.at)}
                  </li>
                ))}
              </ol>
              <p className="fine">
                {detail.turns} turns · AI cost ${(detail.costMicros / 1e6).toFixed(3)}
                {detail.appointmentId ? ' · booked: see Appointments' : ''}
              </p>
            </details>
          </div>
        )}
      </section>

      <section className="card" aria-label="Receptionist settings">
        <form className="fu-form" onSubmit={save}>
          <h2 className="card-title">Settings</h2>
          <label className="check">
            <input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} />
            <span>
              <strong>Answer customers with the AI receptionist.</strong> It uses your services, prices, area and hours from Settings plus the notes below,
              checks your real calendar, and books only after the customer confirms.
            </span>
          </label>
          <label className="field">
            <span>Greeting</span>
            <input value={form.greeting} maxLength={240} onChange={(e) => setForm({ ...form, greeting: e.target.value })} placeholder="Hi! Thanks for reaching out. How can we help?" />
          </label>
          <label className="field">
            <span>Notes for the receptionist</span>
            <textarea rows={5} maxLength={3000} value={form.knowledge} onChange={(e) => setForm({ ...form, knowledge: e.target.value })} placeholder={'e.g. Weekly service includes chemicals.\nWe don’t service commercial pools.'} />
            <span className="fine">Services, prices, area and hours come from Settings; if a note disagrees with a listed price, the listed price is used.</span>
          </label>
          {data.warnings.map((w) => (
            <p key={w} className="fu-attn">
              {w}
            </p>
          ))}
          <details className="rx-phone">
            <summary>Phone calls (not connected)</summary>
            <p className="fine">
              No phone number is connected to GetShowUps yet, so phone calls aren’t answered or transferred and nothing is dialed. These choices are saved for when a line is
              connected.
            </p>
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
              <span className="fine">Not used until a phone line is connected.</span>
            </label>
          </details>
          <div className="card-actions">
            <button type="submit" className="btn btn-primary btn-sm">
              Save
            </button>
            {msg && (
              <span className="fine" role="status">
                {msg}
              </span>
            )}
          </div>
        </form>
      </section>
    </div>
  )
}
