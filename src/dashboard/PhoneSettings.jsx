// Settings → Phone (docs/TELEPHONE.md): which number customers call, who answers, what happens when nobody does, recent
// calls and this month's usage. Everything comes from /api/dashboard/phone; nothing here claims a call that isn't recorded.
import { useEffect, useState } from 'react'
import { ConfirmInline, LoadError, Loading, SaveBar } from './ui.jsx'
import { useSaveState } from './ui-hooks.js'
import { api, phoneText, whenFull } from '../lib/api.js'

const SOURCE_TEXT = { general: 'Everywhere', website: 'Website', google_ads: 'Google ads', print: 'Flyers and print', vehicle: 'Truck or sign', other: 'Somewhere else' }
const ERRORS = {
  invalid_phone: 'Enter a 10-digit US phone number.',
  forwarding_loop: 'That number forwards to your line, so ringing it would loop. Use another phone.',
  too_many: 'That’s the most this line can have.',
  already_added: 'That number is already on the list.',
  rate_limited: 'Too many tries today. Try again tomorrow.',
  no_line: 'Get a number first.',
  test_business: 'Test businesses can’t place real calls.',
  provider_not_configured: 'Phone service isn’t set up yet.',
  provider_refused: 'The phone provider refused that. Nothing was changed.',
  unknown_outcome: 'We couldn’t tell whether that went through. Check your number list before trying again.',
  purchase_off: 'Getting a number isn’t available yet.',
  ai_unavailable: 'Turn on the AI receptionist first (Receptionist page).',
  stale: 'These settings changed elsewhere. Reload to see them.',
  conflict: 'Your website phone changed elsewhere. Reload to see it.',
  profile_missing: 'Fill in Details on your website first.',
}
const errorText = (data) => ERRORS[data?.error] || 'That didn’t work. Please try again.'
const mins = (s) => (s == null ? '' : s < 60 ? `${s}s` : `${Math.round(s / 60)} min`)

export default function PhoneSettings() {
  const [st, setSt] = useState(undefined)
  const load = () => api('/api/dashboard/phone').then(({ status, data }) => setSt(status === 200 ? data : null))
  useEffect(() => {
    load()
  }, [])
  if (st === null) return <LoadError what="your phone line" onRetry={load} />
  if (st === undefined) return <Loading what="phone line" />
  if (st.unavailable) return <p className="fine">Phone lines aren’t available yet.</p>
  const act = async (body) => {
    const { status, data } = await api('/api/dashboard/phone', { method: 'POST', body })
    if (status === 200 && data.state) setSt(data.state)
    return { status, data }
  }
  return (
    <div className="phone-settings" data-phone>
      <p className="fine">{st.setup.next}</p>
      <Lines st={st} act={act} />
      {st.lines.length > 0 && <Answering st={st} act={act} />}
      {st.lines.length > 0 && <Team st={st} act={act} />}
      <Calls st={st} />
      <Usage st={st} />
      <p className="fine">Call recording: Off. Calls are never recorded or transcribed by the phone line.</p>
    </div>
  )
}

function Lines({ st, act }) {
  const [area, setArea] = useState('')
  const [found, setFound] = useState(null)
  const [pick, setPick] = useState(null)
  const [msg, setMsg] = useState('')
  const [confirm, setConfirm] = useState(null)
  const search = async (e) => {
    e.preventDefault()
    setMsg('')
    const { status, data } = await act({ action: 'search_numbers', areaCode: area.trim() })
    if (status === 200) setFound(data.numbers)
    else setMsg(errorText(data))
  }
  const buy = async () => {
    const { status, data } = await act({ action: 'buy_number', number: pick, source: 'general', confirm: true })
    setConfirm(null)
    if (status === 200) {
      setFound(null)
      setPick(null)
    } else setMsg(errorText(data))
  }
  return (
    <section aria-labelledby="phone-number-title">
      <h3 className="subhead" id="phone-number-title">
        The number customers call
      </h3>
      {st.lines.map((l) => (
        <LineRow key={l.id} line={l} st={st} act={act} />
      ))}
      {!st.lines.length && !st.purchase && <p className="fine">Getting a GetShowUps number isn’t available yet. Your website shows the phone in Details on your website.</p>}
      {!st.lines.length && st.purchase && (
        <form className="form" onSubmit={search}>
          <label className="field">
            <span>Area code</span>
            <input value={area} onChange={(e) => setArea(e.target.value)} inputMode="numeric" maxLength={3} placeholder="843" />
          </label>
          <button className="btn btn-sm" type="submit">
            Find numbers
          </button>
          {found && !found.length && <p className="fine">No numbers there right now. Try a nearby area code.</p>}
          {found?.length > 0 && (
            <fieldset className="field">
              <legend>Choose one</legend>
              {found.map((n) => (
                <label key={n.number} className="check">
                  <input type="radio" name="pick" checked={pick === n.number} onChange={() => setPick(n.number)} />
                  <span>
                    {phoneText(n.number)} {n.place && <em>({n.place})</em>}
                  </span>
                </label>
              ))}
            </fieldset>
          )}
          {pick && !confirm && (
            <button type="button" className="btn btn-primary btn-sm" onClick={() => setConfirm(true)}>
              Get this number
            </button>
          )}
          {confirm && (
            <ConfirmInline
              question={`Get ${phoneText(pick)}?`}
              detail={`About $${st.costs.numberMonthly.toFixed(2)} a month for the number, plus call minutes. You can give it back any time.`}
              confirmLabel="Get the number"
              danger={false}
              onConfirm={buy}
              onCancel={() => setConfirm(null)}
            />
          )}
          {msg && <p className="form-error" role="alert">{msg}</p>}
        </form>
      )}
    </section>
  )
}

function LineRow({ line, st, act }) {
  const save = useSaveState()
  const [mode, setMode] = useState(line.forwardMode)
  const [from, setFrom] = useState(line.forwardedFrom || '')
  const [source, setSource] = useState(line.source)
  const [ask, setAsk] = useState(null)
  const [msg, setMsg] = useState('')
  const submit = (e) => {
    e.preventDefault()
    save.run(async () => {
      const { status, data } = await act({ action: 'update_line', id: line.id, source, forwardMode: mode, forwardedFrom: mode === 'none' ? '' : from })
      return status === 200 ? undefined : { error: data.error === 'invalid_forwarding' ? 'Enter the number that forwards here.' : errorText(data) }
    })
  }
  const run = async (body) => {
    const { status, data } = await act(body)
    setAsk(null)
    setMsg(status === 200 ? '' : errorText(data))
  }
  return (
    <form className="form" onSubmit={submit} data-line={line.id}>
      <p>
        <strong>{phoneText(line.number)}</strong> {line.shown ? <em>(on your website and booking page)</em> : null}
      </p>
      {!line.shown && (
        <p>
          <button type="button" className="btn btn-sm" onClick={() => setAsk('show')}>
            Show this number on my website
          </button>
        </p>
      )}
      {ask === 'show' && (
        <ConfirmInline
          question="Show this number to customers?"
          detail={`It replaces ${st.websitePhone ? phoneText(st.websitePhone) : 'no number'} on your website, booking page and receptionist.`}
          confirmLabel="Show it"
          danger={false}
          onConfirm={() => run({ action: 'show_number', id: line.id, confirm: true, base: st.websitePhone })}
          onCancel={() => setAsk(null)}
        />
      )}
      <label className="field">
        <span>Where customers see it</span>
        <select value={source} onChange={(e) => setSource(e.target.value)}>
          {Object.entries(SOURCE_TEXT).map(([v, t]) => (
            <option key={v} value={v}>
              {t}
            </option>
          ))}
        </select>
        <small className="fine">Calls are labelled with this. It’s the only way a call is linked to where it came from.</small>
      </label>
      <fieldset className="field">
        <legend>Keeping your own number?</legend>
        {[
          ['none', 'No, customers call this number'],
          ['all', 'My number forwards every call here'],
          ['no_answer', 'My number forwards calls I don’t answer here'],
        ].map(([v, t]) => (
          <label key={v} className="check">
            <input type="radio" name={`mode-${line.id}`} checked={mode === v} onChange={() => setMode(v)} />
            <span>{t}</span>
          </label>
        ))}
        {mode !== 'none' && (
          <label className="field">
            <span>Your own number</span>
            <input value={from} onChange={(e) => setFrom(e.target.value)} inputMode="tel" placeholder="(843) 555-0100" />
            <small className="fine">Turn on call forwarding with your phone company to {phoneText(line.number)}. Each company has its own steps.</small>
          </label>
        )}
      </fieldset>
      <SaveBar save={save}>Save number</SaveBar>
      <p>
        <button type="button" className="btn btn-sm btn-quiet" onClick={() => setAsk('release')}>
          Give this number back…
        </button>
      </p>
      {ask === 'release' && (
        <ConfirmInline
          question={`Give back ${phoneText(line.number)}?`}
          detail="Customers calling it will no longer reach you, and the number may go to someone else. Call history stays."
          confirmLabel="Give it back"
          onConfirm={() => run({ action: 'release_line', id: line.id, confirm: true })}
          onCancel={() => setAsk(null)}
        />
      )}
      {msg && <p className="form-error" role="alert">{msg}</p>}
    </form>
  )
}

function Answering({ st, act }) {
  const save = useSaveState()
  const [s, setS] = useState(st.settings)
  const set = (k) => (v) => setS({ ...s, [k]: v })
  const submit = (e) => {
    e.preventDefault()
    save.run(async () => {
      const { status, data } = await act({ action: 'settings', ...s, version: st.settings.version })
      if (status === 200) setS(data.state.settings)
      return status === 200 ? undefined : { error: errorText(data) }
    })
  }
  return (
    <form className="form" onSubmit={submit} aria-labelledby="phone-answer-title">
      <h3 className="subhead" id="phone-answer-title">
        Who answers
      </h3>
      <fieldset className="field">
        <legend>When a customer calls</legend>
        <label className="check">
          <input type="radio" name="answer" checked={s.answer === 'team'} onChange={() => set('answer')('team')} />
          <span>Ring my team first</span>
        </label>
        <label className="check">
          <input type="radio" name="answer" checked={s.answer === 'fallback'} onChange={() => set('answer')('fallback')} />
          <span>Don’t ring anyone</span>
        </label>
      </fieldset>
      {s.answer === 'team' && (
        <label className="field">
          <span>Ring for</span>
          <select value={s.ringSeconds} onChange={(e) => set('ringSeconds')(Number(e.target.value))}>
            {[15, 20, 25, 30, 45].map((n) => (
              <option key={n} value={n}>
                {n} seconds
              </option>
            ))}
          </select>
        </label>
      )}
      <fieldset className="field">
        <legend>If nobody answers</legend>
        <label className="check">
          <input type="radio" name="fallback" checked={s.fallback === 'callback'} onChange={() => set('fallback')('callback')} />
          <span>Tell the caller you’ll call back, and add it to Needs attention</span>
        </label>
        <label className="check">
          <input type="radio" name="fallback" checked={s.fallback === 'ai'} disabled={!st.ai.available} onChange={() => set('fallback')('ai')} />
          <span>The AI receptionist answers {!st.ai.available && <em>({st.ai.receptionistOn ? 'not available for phone calls yet' : 'turn it on first on the Receptionist page'})</em>}</span>
        </label>
      </fieldset>
      <label className="check">
        <input type="checkbox" checked={s.afterHours === 'fallback'} onChange={(e) => set('afterHours')(e.target.checked ? 'fallback' : 'same')} />
        <span>Outside booking hours, don’t ring my team</span>
      </label>
      <label className="check">
        <input type="checkbox" checked={s.screen} onChange={(e) => set('screen')(e.target.checked)} />
        <span>My team presses 1 to take a call (so a voicemail never counts as answered)</span>
      </label>
      <SaveBar save={save}>Save who answers</SaveBar>
    </form>
  )
}

function Team({ st, act }) {
  const [num, setNum] = useState('')
  const [label, setLabel] = useState('')
  const [msg, setMsg] = useState('')
  const [codes, setCodes] = useState({})
  const add = async (e) => {
    e.preventDefault()
    const { status, data } = await act({ action: 'add_destination', number: num, label })
    setMsg(status === 200 ? '' : errorText(data))
    if (status === 200) {
      setNum('')
      setLabel('')
    }
  }
  const verify = async (id) => {
    const { status, data } = await act({ action: 'verify_destination', id })
    if (status === 200 && data.code) setCodes({ ...codes, [id]: data.code })
    setMsg(status === 200 ? '' : errorText(data))
  }
  return (
    <section aria-labelledby="phone-team-title">
      <h3 className="subhead" id="phone-team-title">
        Phones that ring
      </h3>
      <p className="fine">Only verified numbers ring. Verifying calls that phone once; you type the code shown here.</p>
      <ul className="plain-list">
        {st.destinations.map((d) => (
          <li key={d.id} data-destination={d.id}>
            {phoneText(d.number)} {d.label && <em>({d.label})</em>} · {d.verified ? 'Verified' : codes[d.id] ? <strong>Answer the call and enter {codes[d.id]}</strong> : 'Not verified'}{' '}
            {!d.verified && (
              <button type="button" className="btn btn-sm" onClick={() => verify(d.id)}>
                {codes[d.id] ? 'Call again' : 'Verify by phone call'}
              </button>
            )}{' '}
            <button type="button" className="btn btn-sm btn-quiet" onClick={() => act({ action: 'remove_destination', id: d.id })}>
              Remove
            </button>
          </li>
        ))}
      </ul>
      <form className="form" onSubmit={add}>
        <label className="field">
          <span>Phone number</span>
          <input value={num} onChange={(e) => setNum(e.target.value)} inputMode="tel" placeholder="(843) 555-0100" />
        </label>
        <label className="field">
          <span>Whose phone <em>(optional)</em></span>
          <input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={40} placeholder="Owner’s cell" />
        </label>
        <button className="btn btn-sm" type="submit">
          Add phone
        </button>
      </form>
      {msg && <p className="form-error" role="alert">{msg}</p>}
    </section>
  )
}

function Calls({ st }) {
  if (!st.calls.length) return <p className="fine">No calls in the last 30 days.</p>
  return (
    <section aria-labelledby="phone-calls-title">
      <h3 className="subhead" id="phone-calls-title">
        Recent calls
      </h3>
      <ul className="plain-list" data-calls>
        {st.calls.map((c) => (
          <li key={c.id}>
            {whenFull(c.at)} · {c.callerState === 'known' ? phoneText(c.caller) : 'Hidden number'}
            {c.customer && ` · ${c.customer.name}`}
            {c.shared && ' · shared number'} · {c.outcomeText}
            {c.seconds ? ` · ${mins(c.seconds)}` : ''}
            {c.bookedByAi ? ' · booked by the AI' : c.bookedAfter ? ' · booked afterwards' : ''}
            {c.callbackOpen && ' · in Needs attention'}
          </li>
        ))}
      </ul>
    </section>
  )
}

function Usage({ st }) {
  const u = st.usage
  return (
    <p className="fine" data-usage>
      This month: {u.calls} {u.calls === 1 ? 'call' : 'calls'}, {u.missed} missed, {u.minutes} min ({u.aiMinutes} with the AI).{' '}
      {u.verifiedUsd != null ? `Cost reported by the phone provider: $${u.verifiedUsd.toFixed(2)}.` : `Estimated cost: about $${u.estimatedUsd.toFixed(2)} (published prices, not a bill).`} Limit: {st.limits.dailyMinutes} minutes a day,{' '}
      {st.limits.concurrent} calls at once.
    </p>
  )
}
