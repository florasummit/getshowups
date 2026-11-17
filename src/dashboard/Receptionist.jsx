import { useEffect, useState } from 'react'
import { api } from '../lib/api.js'

// Owner: the AI receptionist. Turn it on, choose how calls are answered, correct what it knows, and review every
// conversation (what was said, what it did, the outcome). Services, prices, area and hours come from Settings.
const MODES = [
  ['ai_first', 'AI answers first', 'The AI receptionist answers; it can transfer callers to your team while you are open.'],
  ['human_first', 'My team answers first', 'Calls ring your team first; the AI answers the ones nobody picks up.'],
  ['after_hours', 'AI after hours', 'Your team answers during business hours; the AI answers outside them.'],
]
const OUTCOME = { booked: 'Booked', handoff: 'Needs you', handoff_urgent: 'Urgent: needs you', out_of_area: 'Outside your area', info: 'Answered questions', error: 'Couldn’t answer' }
const EVENT = {
  check_service_area: 'Checked service area',
  find_available_times: 'Looked up open times',
  book_appointment: 'Booking',
  request_human: 'Handed off to you',
  blocked_price: 'Blocked a price not in your records',
  model: 'AI unavailable',
  limit: 'Limit reached',
  concurrent_turn: 'Overlapping turn',
}
const when = (t) => new Date(t).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })

export default function Receptionist() {
  const [data, setData] = useState(null)
  const [form, setForm] = useState(null)
  const [msg, setMsg] = useState('')
  const [open, setOpen] = useState(null)
  const [detail, setDetail] = useState(null)
  const [tick, setTick] = useState(0)
  useEffect(() => {
    api('/api/dashboard/receptionist').then(({ status, data: d }) => {
      setData(status === 200 ? d : { failed: true })
      if (status === 200 && d.ready) setForm(d.settings)
    })
  }, [tick])
  useEffect(() => {
    if (open) api(`/api/dashboard/receptionist?id=${encodeURIComponent(open)}`).then(({ status, data: d }) => setDetail(status === 200 ? d.conversation : null))
  }, [open])

  if (!data) return <div aria-busy="true" />
  if (data.failed) return <p className="form-error">Couldn’t load the receptionist. Please refresh.</p>
  if (!data.ready) return <p className="fine">The AI receptionist is being set up for your account.</p>

  const save = async (e) => {
    e.preventDefault()
    setMsg('')
    const { status, data: d } = await api('/api/dashboard/receptionist', { method: 'POST', body: { action: 'settings', ...form } })
    setMsg(status === 200 ? 'Saved.' : d.error === 'invalid_phone' ? 'Check the transfer number.' : 'Couldn’t save. Please try again.')
    if (status === 200) setTick((n) => n + 1)
  }
  return (
    <div className="rx-grid">
      <h1 className="title title--page">AI receptionist</h1>
      {!data.configured && <p className="fu-attn">The AI receptionist isn’t switched on for GetShowUps yet. You can set it up now; customers will see it once it is.</p>}
      <section className="card" aria-label="Receptionist settings">
        <form className="fu-form" onSubmit={save}>
          <label className="check">
            <input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} />
            <span>
              <strong>Answer customers with the AI receptionist</strong> — website chat{data.voice ? ' and voice' : ''}. It answers from your services, prices, area, hours and the
              notes below, checks your real calendar, and books only after the customer confirms.
            </span>
          </label>
          <fieldset className="field">
            <legend>How calls are answered</legend>
            {MODES.map(([v, l, d]) => (
              <label key={v} className="check">
                <input type="radio" name="mode" checked={form.mode === v} onChange={() => setForm({ ...form, mode: v })} />
                <span>
                  <strong>{l}.</strong> {d}
                </span>
              </label>
            ))}
            <span className="fine">Right now: {data.route.text} Phone calls need a phone number connected to GetShowUps (not set up yet); website chat and browser voice are always answered by the AI.</span>
          </fieldset>
          <label className="field">
            <span>Team phone for transfers (optional)</span>
            <input value={form.transferPhone} inputMode="tel" onChange={(e) => setForm({ ...form, transferPhone: e.target.value })} placeholder="(843) 555-0100" />
          </label>
          <label className="field">
            <span>Greeting</span>
            <input value={form.greeting} maxLength={240} onChange={(e) => setForm({ ...form, greeting: e.target.value })} placeholder="Hi! Thanks for reaching out — how can we help?" />
          </label>
          <label className="field">
            <span>What the receptionist should know (your approved answers)</span>
            <textarea rows={6} maxLength={3000} value={form.knowledge} onChange={(e) => setForm({ ...form, knowledge: e.target.value })} placeholder={'e.g. Weekly service includes chemicals and skimming.\nWe don’t service commercial pools.\nFor a green pool we quote after seeing it.'} />
            <span className="fine">It never states prices or promises beyond your services list and these notes. Services, prices, area and hours are edited in Settings.</span>
          </label>
          <div className="card-actions">
            <button type="submit" className="btn btn-primary btn-sm">
              Save
            </button>
            <a className="btn btn-quiet btn-sm" href={data.chatUrl} target="_blank" rel="noreferrer">
              Try it as a customer
            </a>
            {msg && <span className="fine" role="status">{msg}</span>}
          </div>
        </form>
      </section>

      <section className="card" aria-label="Receptionist conversations">
        <h2 className="card-title">Conversations</h2>
        <p className="fine">
          {data.counts.total} conversations · {data.counts.booked} booked · {data.counts.handoff} need you
        </p>
        {data.conversations.length === 0 ? (
          <p className="empty">No conversations yet. Use “Try it as a customer” to test.</p>
        ) : (
          <ul className="rows">
            {data.conversations.map((c) => (
              <li key={c.id} className="row">
                <button type="button" className="row-main link-btn" onClick={() => setOpen(open === c.id ? null : c.id)} aria-expanded={open === c.id}>
                  <span className="row-title">
                    {c.channel === 'voice' ? 'Voice' : 'Chat'} · {OUTCOME[c.outcome] || 'Started'} <span className="fine">{when(c.updatedAt)}</span>
                  </span>
                  <span className="row-sub">{c.summary || ''}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {open && detail && detail.id === open && (
          <div className="rx-convo" aria-label="Conversation detail">
            {detail.handoff && (
              <p className="fu-attn">
                Hand-off ({detail.handoff.reason}
                {detail.handoff.urgent ? ', urgent' : ''}): {detail.handoff.note}
              </p>
            )}
            {detail.transcript.map((l, i) => (
              <p key={i} className={`rc-msg rc-msg--${l.who}`}>
                {l.text}
              </p>
            ))}
            <ol className="rx-events" aria-label="What the receptionist did">
              {detail.events.map((e, i) => (
                <li key={i} className={e.ok ? '' : 'bad'}>
                  {EVENT[e.kind] || e.kind}
                  {e.detail ? ` — ${e.detail}` : ''} · {when(e.at)}
                </li>
              ))}
            </ol>
            <p className="fine">
              {detail.turns} turns · AI cost ${(detail.costMicros / 1e6).toFixed(3)}
              {detail.appointmentId ? ' · booked (see Appointments)' : ''}
            </p>
          </div>
        )}
      </section>
    </div>
  )
}
