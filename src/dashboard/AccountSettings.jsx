// Settings: people and access, connected services, notifications, the business's data, closing, the person's own account.
// Every status comes from the server; anything that isn't available says so instead of looking like a working control.
import { useCallback, useEffect, useState } from 'react'
import { api, whenFull } from '../lib/api.js'
import { clearMemory } from './assistant-memory.js'
import { LoadError, Pill } from './ui.jsx'

const day = (ms) => new Date(ms).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
const SIGN_IN_AGAIN = '/api/auth/google/start?next=/dashboard/settings'
const ERR = {
  owner_only: 'Only the business owner can do this.',
  last_member: 'You’re the only person here. Invite someone first, or close the business.',
  already_member: 'That person is already here.',
  too_many: 'That’s the most people a business can have.',
  invalid_email: 'Enter an email address.',
  name_mismatch: 'The name doesn’t match.',
  email_mismatch: 'The email doesn’t match.',
  protected_business: 'This business can’t be closed from here. Contact us.',
  only_member: 'You’re the only person in this business. Close the business first.',
  platform_admin: 'An administrator account can’t be deleted here.',
  already_requested: 'You already asked.',
  not_scheduled: 'It’s too late to undo.',
  rate_limited: 'Too many tries. Wait a few minutes.',
  campaigns_running: 'Some ads are still running.',
  ads_on_hold_pause_first: 'Your running ads must be paused first.',
  pause_failed: 'An ad couldn’t be paused, so nothing was disconnected.',
}
// Refused for a known reason: nothing changed. Anything else (lost connection, server error) may have finished partly.
const errText = (c) => ERR[c] || (['network_error', 'storage_error', 'failed', 'not_confirmed', 'export_failed'].includes(c) ? 'We couldn’t confirm whether this finished. Reload the page to see where it stands.' : 'That was refused. Please check and try again.')

// A refused action: the reason, or the way to sign in again (asked for consequential changes only).
export function ActionError({ code }) {
  if (!code) return null
  if (code === 'reauth_required')
    return (
      <p className="notice-info" role="alert" data-reauth>
        For your security, sign in again to do this. <a href={SIGN_IN_AGAIN}>Sign in again with Google</a>
      </p>
    )
  return (
    <p className="form-error" role="alert">
      {errText(code)}
    </p>
  )
}

function useLoad(path) {
  const [d, setD] = useState(undefined)
  const load = useCallback(() => api(path).then(({ status, data }) => setD(status === 200 ? data : null)), [path])
  useEffect(() => {
    load()
  }, [load])
  return [d, load]
}
const send = async (path, body) => {
  const { status, data } = await api(path, { method: 'POST', body })
  return { ok: status >= 200 && status < 300, code: data.error || 'failed', data }
}

// ---------- setup check ----------
const LEVEL = { critical: ['bad', 'Fix now'], important: ['warn', 'Important'], optional: ['neutral', 'Optional'] }
export function SetupCheck({ go, compact = false }) {
  const [d, load] = useLoad('/api/dashboard/setup-check')
  useEffect(() => {
    window.addEventListener('gsu:settings-saved', load)
    return () => window.removeEventListener('gsu:settings-saved', load)
  }, [load])
  if (d === undefined) return <div aria-busy="true" />
  if (d === null) return <LoadError what="your setup check" onRetry={load} />
  const items = compact ? d.items.filter((x) => x.level !== 'optional') : d.items
  if (compact && !items.length) return null
  const open = (e, x) => {
    const [tab, id] = x.where.split('#')
    e.preventDefault()
    if (tab !== 'settings' || compact) go?.(tab)
    if (id) setTimeout(() => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), compact ? 250 : 0)
  }
  return (
    <div data-setup-check>
      {items.length ? (
        <ul className="rows">
          {(compact ? items.slice(0, 3) : items).map((x) => (
            <li key={x.id} className="row" data-check={x.id}>
              <div className="row-main">
                <p className="row-title">
                  <Pill tone={LEVEL[x.level][0]}>{LEVEL[x.level][1]}</Pill> {x.title}
                </p>
                <p className="row-sub">
                  {x.why} <a href={`/dashboard/${x.where}`} onClick={(e) => open(e, x)}>{x.fix}</a>
                </p>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="fine">Nothing missing that we can check. Wording and photos are yours to judge.</p>
      )}
      {compact && items.length > 3 && (
        <a className="link-btn" href="/dashboard/settings" onClick={(e) => (e.preventDefault(), go?.('settings'))}>
          {items.length - 3} more
        </a>
      )}
      {d.unread.length > 0 && <p className="fine">Couldn’t check: {d.unread.join(', ')}.</p>}
    </div>
  )
}

// ---------- people ----------
export function People() {
  const [d, load] = useLoad('/api/dashboard/people')
  const [state, setState] = useState({})
  const [email, setEmail] = useState('')
  const [confirm, setConfirm] = useState(null)
  if (d === undefined) return <div aria-busy="true" />
  if (d === null) return <LoadError what="the people here" onRetry={load} />
  const run = async (body, done) => {
    setState({ busy: true })
    const r = await send('/api/dashboard/people', body)
    setState(r.ok ? { done, link: r.data.url ? r.data : null } : { code: r.code })
    setConfirm(null)
    if (r.ok) {
      setEmail('')
      if (r.data.left) {
        clearMemory()
        return location.replace('/dashboard')
      }
      load()
    }
  }
  const others = d.members.length > 1
  return (
    <div className="stack">
      <p className="fine">Everyone here sees the whole business. The owner also invites and removes people, changes the plan, downloads the data and closes the business.</p>
      <ul className="rows">
        {d.members.map((m) => (
          <li key={m.email} className="row">
            <div className="row-main">
              <p className="row-title">
                {m.email} {m.owner && <Pill tone="info">Owner</Pill>} {m.you && <Pill tone="neutral">You</Pill>}
              </p>
              <p className="row-sub">Since {day(m.since)}</p>
            </div>
            {((d.you.owner && !m.you) || (m.you && others)) && (
              <div className="row-actions">
                {confirm === m.email ? (
                  <>
                    <button type="button" className="btn btn-sm btn-quiet" onClick={() => setConfirm(null)}>
                      Cancel
                    </button>
                    <button type="button" className="btn btn-sm btn-danger" disabled={state.busy} onClick={() => run(m.you ? { action: 'leave', confirm: true } : { action: 'remove', email: m.email, confirm: true }, 'Removed and signed out.')}>
                      {m.you ? `Confirm: leave${m.owner ? ' (the next person becomes owner)' : ''}` : 'Confirm: remove'}
                    </button>
                  </>
                ) : (
                  <button type="button" className="btn btn-sm btn-quiet" onClick={() => setConfirm(m.email)}>
                    {m.you ? 'Leave this business…' : 'Remove…'}
                  </button>
                )}
              </div>
            )}
          </li>
        ))}
        {d.invites.map((i) => (
          <li key={i.id} className="row">
            <div className="row-main">
              <p className="row-title">
                {i.email} <Pill tone="neutral">Invited</Pill>
              </p>
              <p className="row-sub">Link works until {day(i.expiresAt)}</p>
            </div>
            {d.you.owner && (
              <button type="button" className="btn btn-sm btn-quiet" disabled={state.busy} onClick={() => run({ action: 'cancel_invite', id: i.id }, 'Invitation cancelled.')}>
                Cancel invitation
              </button>
            )}
          </li>
        ))}
      </ul>
      {d.you.owner && (
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault()
            run({ action: 'invite', email }, 'Invitation created.')
          }}
        >
          <label className="field">
            <span>Invite someone (their Google account email)</span>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="off" />
          </label>
          <button className="btn btn-quiet" disabled={state.busy}>
            Create invitation
          </button>
        </form>
      )}
      {state.link && (
        <label className="field" data-invite-link>
          <span>{state.link.emailed ? 'We’re emailing this link. You can also send it yourself:' : 'Send them this link yourself (we don’t email it yet):'}</span>
          <input readOnly value={state.link.url} onFocus={(e) => e.target.select()} />
        </label>
      )}
      <ActionError code={state.code} />
      {state.done && (
        <p className="fine" role="status">
          {state.done}
        </p>
      )}
    </div>
  )
}

// ---------- sign-in and sessions ----------
export function SignInSecurity() {
  const [d, load] = useLoad('/api/dashboard/people')
  const [state, setState] = useState({})
  if (d === undefined) return <div aria-busy="true" />
  if (d === null) return <LoadError what="your sessions" onRetry={load} />
  const end = async (all) => {
    const r = await send('/api/dashboard/people', { action: 'end_sessions', all })
    if (!r.ok) return setState({ code: r.code })
    if (all) {
      clearMemory()
      return location.replace('/dashboard')
    }
    setState({ done: r.data.ended ? `${r.data.ended} other ${r.data.ended === 1 ? 'session' : 'sessions'} ended.` : 'There were no others.' })
    load()
  }
  return (
    <div className="stack">
      <p>
        You sign in with Google as <strong>{d.you.email}</strong>.
      </p>
      <p className="fine">GetShowUps has no password. Your name, password and two-step verification are managed in your Google Account. To use another email, invite it above, then leave with this one.</p>
      <p className="fine">
        {d.sessions.length} signed-in {d.sessions.length === 1 ? 'session' : 'sessions'}; each ends within 7 days.
        {d.you.signedInAt ? ` This one started ${whenFull(d.you.signedInAt)}.` : ''}
      </p>
      <div className="row-actions">
        <button type="button" className="btn btn-sm btn-quiet" onClick={() => end(false)}>
          Sign out other devices
        </button>
        <button type="button" className="btn btn-sm btn-quiet" onClick={() => end(true)}>
          Sign out everywhere
        </button>
      </div>
      <ActionError code={state.code} />
      {state.done && (
        <p className="fine" role="status">
          {state.done}
        </p>
      )}
    </div>
  )
}

// ---------- notifications ----------
export function Notices() {
  const [d, load] = useLoad('/api/dashboard/people')
  const [code, setCode] = useState(null)
  if (d === undefined) return <div aria-busy="true" />
  if (d === null) return <LoadError what="your notifications" onRetry={load} />
  if (!d.notices) return <p className="fine">You get every notice. Choosing which ones isn’t available yet.</p>
  return (
    <div className="stack">
      <p className="fine">Emails to {d.you.email} about this business. Others here choose their own. Billing and security emails can’t be turned off.</p>
      {d.notices.map((n) => (
        <label key={n.kind} className="check">
          <input
            type="checkbox"
            checked={n.on}
            onChange={async (e) => {
              const r = await send('/api/dashboard/people', { action: 'notice', kind: n.kind, on: e.target.checked })
              setCode(r.ok ? null : r.code)
              load()
            }}
          />
          <span>{n.label}</span>
        </label>
      ))}
      <ActionError code={code} />
    </div>
  )
}

// ---------- connected services ----------
const STATE = { connected: ['ok', 'Connected'], attention: ['warn', 'Needs attention'], off: ['neutral', 'Not connected'], unavailable: ['neutral', 'Not available yet'], unknown: ['warn', 'Couldn’t check'] }
export function Services({ go }) {
  const [d, load] = useLoad('/api/dashboard/integrations')
  const [open, setOpen] = useState(null)
  const [state, setState] = useState({})
  if (d === undefined) return <div aria-busy="true" />
  if (d === null) return <LoadError what="your connected services" onRetry={load} />
  const disconnect = async (id, pauseRunning) => {
    setState({ busy: true })
    const r = await send('/api/dashboard/integrations', { action: 'disconnect', id, confirm: true, pauseRunning })
    setState(r.ok ? { id, done: `Disconnected here.${r.data.revokeAsked ? ' We also asked Google to remove our access.' : ' The provider’s own permission may remain: see above to remove it there.'}` } : { id, code: r.code })
    if (r.ok) load()
  }
  return (
    <ul className="rows" data-services>
      {d.items.map((x) => {
        const on = ['connected', 'attention'].includes(x.state)
        return (
          <li key={x.id} className="row" data-service={x.id}>
            <div className="row-main">
              <p className="row-title">
                {x.name} <Pill tone={STATE[x.state][0]}>{STATE[x.state][1]}</Pill>
              </p>
              <p className="row-sub">
                {x.detail ? `${x.detail} · ` : ''}
                {x.does}
              </p>
              {open === x.id && (
                <div className="stack">
                  <p className="fine">
                    <strong>If you disconnect:</strong> {x.stops}
                  </p>
                  {x.external && <p className="fine">{x.external}</p>}
                  <div className="row-actions">
                    <button type="button" className="btn btn-sm btn-quiet" onClick={() => setOpen(null)}>
                      Close
                    </button>
                    {x.here ? (
                      <button type="button" className="btn btn-sm btn-danger" disabled={state.busy} onClick={() => disconnect(x.id, state.code === 'campaigns_running' || state.code === 'ads_on_hold_pause_first')}>
                        {['campaigns_running', 'ads_on_hold_pause_first'].includes(state.code) && state.id === x.id ? 'Pause running ads and disconnect' : `Disconnect ${x.name}`}
                      </button>
                    ) : (
                      x.page !== 'settings' && (
                        <button type="button" className="btn btn-sm btn-primary" onClick={() => go(x.page)}>
                          Manage on its page
                        </button>
                      )
                    )}
                  </div>
                </div>
              )}
              {state.id === x.id && <ActionError code={state.code} />}
              {state.id === x.id && state.done && (
                <p className="fine" role="status">
                  {state.done}
                </p>
              )}
            </div>
            {on && open !== x.id && (
              <button type="button" className="btn btn-sm btn-quiet" onClick={() => setOpen(x.id)}>
                Manage<span className="sr-only"> {x.name}</span>
              </button>
            )}
          </li>
        )
      })}
    </ul>
  )
}

// ---------- your data ----------
export function YourData() {
  const [state, setState] = useState({})
  const download = async () => {
    setState({ busy: true })
    const { status, data } = await api('/api/dashboard/export?check=1')
    if (status !== 200) return setState({ code: data.error || 'failed' })
    try {
      const res = await fetch('/api/dashboard/export', { credentials: 'same-origin' })
      if (!res.ok) return setState({ code: (await res.json().catch(() => ({}))).error || 'failed' })
      const url = URL.createObjectURL(await res.blob())
      const a = document.createElement('a')
      a.href = url
      a.download = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') || '')?.[1] || 'getshowups-export.zip'
      a.click()
      setTimeout(() => URL.revokeObjectURL(url), 60000)
      setState({ done: true })
    } catch {
      setState({ code: 'failed' })
    }
  }
  return (
    <div className="stack">
      <p>Download everything this business owns: customers, appointments, recorded payments, call-backs, messages, receptionist conversations, settings, what you taught the AI, your website and photos.</p>
      <p className="fine">One .zip with spreadsheets (CSV) and JSON. It holds your customers’ details: keep it somewhere safe. Keys and passwords are never included.</p>
      <button type="button" className="btn btn-quiet" onClick={download} disabled={state.busy}>
        {state.busy ? 'Preparing…' : 'Download my data'}
      </button>
      <ActionError code={state.code} />
      {state.done && (
        <p className="fine" role="status">
          Downloaded. README.txt inside says if anything didn’t fit.
        </p>
      )}
    </div>
  )
}

// ---------- closing the business ----------
const PLATFORM = { google: 'Google Ads', meta: 'Meta', openai: 'ChatGPT ads' }
const count = (n, one, many = `${one}s`) => (n === null ? `${many}: couldn’t be checked` : `${n} ${n === 1 ? one : many}`)
function Impact({ i, deletes, recoveryDays }) {
  const ads = i.ads === null ? 'Running ads couldn’t be checked' : i.ads.length ? `${i.ads.map((a) => `${a.n} running on ${PLATFORM[a.platform] || a.platform}`).join(', ')}: paused and checked first. They stay in your own ad account, paused.` : 'No ads started here are running. Ads you run yourself in Google, Meta or OpenAI are not touched and keep running.'
  return (
    <>
      {!deletes && (
        <p className="notice-info" data-request-only>
          Sending this request changes nothing yet: your website, bookings, ads and plan continue, and charges with them, until a person closes the business with you. To stop renewing now, cancel under Plan and billing. What closing would mean:
        </p>
      )}
      <ul className="fine" data-impact>
        <li>
          Goes offline: {i.site === null ? 'website (couldn’t be checked)' : i.site ? 'your website' : 'no published website'}, your booking page and receptionist{i.domain ? `, ${i.domain} (the domain stays yours)` : ''}.
        </li>
        <li>{count(i.upcoming, 'upcoming appointment')}: not cancelled for you. They stay in your Google Calendar; tell your customers yourself.</li>
        <li>{count(i.messages, 'scheduled message')} won’t be sent.</li>
        <li>{ads}</li>
        <li>{i.subscription === null ? 'Your plan couldn’t be checked.' : !i.subscription ? 'There’s no plan to end.' : !deletes ? 'Your plan would end.' : !recoveryDays ? 'Your plan ends right away, with no further charges. The current period isn’t refunded automatically.' : 'Your plan is set to end, so it doesn’t renew. An unpaid invoice may still be collected.'}</li>
        <li>Disconnected here: {i.services === null ? 'couldn’t be checked' : i.services.length ? i.services.join(', ') : 'nothing connected'}. Those accounts stay yours.</li>
        <li>
          Erased: {count(i.customers, 'customer record')}, {count(i.conversations, 'receptionist conversation')}, {count(i.images, 'photo')}, your website, settings and what you taught the AI.
        </li>
        <li>{count(i.members, 'person', 'people')} lose access. Other businesses are not affected.</li>
        <li>Kept: billing records and a log without your customers’ details. Copies in backups go away as the backups expire.</li>
      </ul>
    </>
  )
}

export function CloseBusiness() {
  const [d, load] = useLoad('/api/dashboard/account')
  const [open, setOpen] = useState(false)
  const [typed, setTyped] = useState('')
  const [state, setState] = useState({})
  if (d === undefined) return <div aria-busy="true" />
  if (d === null) return <LoadError what="this" onRetry={load} />
  const b = d.business
  if (!b) return null
  const norm = (s) => String(s).trim().replace(/\s+/g, ' ').toLowerCase()
  const act = async (body) => {
    setState({ busy: true })
    const r = await send('/api/dashboard/account', { ...body, confirm: true })
    if (!r.ok) return setState({ code: r.code })
    if (body.action === 'delete' && !r.data.scheduledFor) {
      clearMemory()
      return setState({ gone: r.data.status === 'completed' ? 'done' : 'working' })
    }
    setState({})
    setOpen(false)
    load()
  }
  if (state.gone)
    return (
      <div className="stack" role="status" data-account-deleted>
        <p>
          <strong>{state.gone === 'done' ? 'Your business has been deleted.' : 'Your account is being deleted.'}</strong>{' '}
          {state.gone === 'done' ? 'Everything listed above was checked and erased.' : 'Your website and booking page are offline. Some steps aren’t finished yet (for example ending your plan or pausing ads); we keep trying and a person is alerted if they can’t be finished.'} This can’t be undone.
        </p>
        <a className="btn btn-sm" href="/">
          Done
        </a>
      </div>
    )
  if (b.scheduledFor)
    return (
      <div className="stack" data-closing>
        <p className="notice-info" role="status">
          This business is closed and will be permanently deleted on {day(b.scheduledFor)}. Until then nothing is erased. {b.chargesStopped ? 'Your plan won’t renew.' : 'We’re still confirming with Stripe that your plan won’t renew.'}
          {b.adsPending ? ' Some ads couldn’t be paused yet; check your ad account.' : ''}
        </p>
        {b.owner && (
          <button type="button" className="btn btn-primary" disabled={state.busy} onClick={() => act({ action: 'undo_delete' })}>
            Keep my business
          </button>
        )}
        <p className="fine">Keeping it puts your website and booking page back, if they were on before and your plan hasn’t ended. Ads stay paused and your plan still ends until you choose otherwise. Reminders that were due meanwhile aren’t sent.</p>
        <ActionError code={state.code} />
      </div>
    )
  if (b.protected) return <p className="fine">This business can’t be closed from here. Contact hello@getshowups.com.</p>
  if (!b.owner) return <p className="fine">Only the owner can close the business. You can leave it under People.</p>
  return (
    <div className="stack">
      <p className="fine">
        {d.enabled
          ? `Permanently deletes ${b.name}. ${d.recoveryDays ? `You have ${d.recoveryDays} days to change your mind; then there is no undo.` : 'There is no undo.'} To stop paying but keep everything, cancel your plan under Plan and billing instead.`
          : 'Deleting a business online isn’t switched on yet. Ask here and a person at GetShowUps handles it and confirms when it’s done. To stop paying but keep everything, cancel your plan under Plan and billing instead.'}
      </p>
      {b.request ? (
        <div className="stack" data-closure-requested>
          <p className="notice-info" role="status">
            You asked to close this business on {day(b.request.at)}. Nothing has been changed or deleted yet.
          </p>
          <button type="button" className="btn btn-sm btn-quiet" disabled={state.busy} onClick={() => act({ action: 'withdraw_closure' })}>
            Withdraw my request
          </button>
        </div>
      ) : !open ? (
        <button type="button" className="btn btn-sm btn-quiet" onClick={() => setOpen(true)}>
          {d.enabled ? 'Delete business…' : 'Ask to close this business…'}
        </button>
      ) : (
        <form
          className="stack"
          aria-label="Confirm closing"
          onSubmit={(e) => {
            e.preventDefault()
            act(d.enabled ? { action: 'delete', name: typed } : { action: 'request_closure' })
          }}
        >
          <p>
            <strong>What happens</strong>
          </p>
          <Impact i={b.impact} deletes={d.enabled} recoveryDays={d.recoveryDays} />
          <p className="fine">You may want to download your data first (above). You don’t have to.</p>
          {d.enabled && (
            <label className="field">
              <span>Type the business name ({b.name}) to confirm</span>
              <input value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
            </label>
          )}
          <ActionError code={state.code} />
          <div className="row-actions">
            <button type="button" className="btn btn-sm btn-quiet" onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button type="submit" className="btn btn-sm btn-danger" disabled={state.busy || (d.enabled && norm(typed) !== norm(b.name))}>
              {d.enabled ? (d.recoveryDays ? `Close now, delete in ${d.recoveryDays} days` : 'Permanently delete business') : 'Send my request'}
            </button>
          </div>
        </form>
      )}
      {!open && <ActionError code={state.code} />}
    </div>
  )
}

// ---------- the person's own account ----------
export function YourAccount() {
  const [d, load] = useLoad('/api/dashboard/account')
  const [open, setOpen] = useState(false)
  const [typed, setTyped] = useState('')
  const [state, setState] = useState({})
  if (d === undefined) return <div aria-busy="true" />
  if (d === null) return <LoadError what="your account" onRetry={load} />
  if (state.done)
    return (
      <p role="status" data-person-deleted>
        Your account has been deleted and you’re signed out. <a href="/">Done</a>
      </p>
    )
  const submit = async (e) => {
    e.preventDefault()
    setState({ busy: true })
    const r = await send('/api/dashboard/account', { action: 'delete_me', email: typed, confirm: true })
    if (r.ok) clearMemory()
    setState(r.ok ? { done: true } : { code: r.code })
  }
  const why = { platform_admin: 'This account administers GetShowUps, so it can’t be deleted here.', only_member: 'You’re the only person in this business. Close the business first, or invite someone who will take it over.' }[d.person]
  return (
    <div className="stack">
      <p className="fine">
        Removes your sign-in, sessions, invitations and emails we sent you, and takes you out of the business. Your Google Account is not touched. The business and its records stay with the people who remain.
      </p>
      {!d.enabled ? (
        <p className="fine">
          Deleting your account online isn’t switched on yet. Email <a href="mailto:hello@getshowups.com?subject=Delete%20my%20account">hello@getshowups.com</a> and a person handles it.
        </p>
      ) : why ? (
        <p className="fine">{why}</p>
      ) : !open ? (
        <button type="button" className="btn btn-sm btn-quiet" onClick={() => setOpen(true)}>
          Delete my account…
        </button>
      ) : (
        <form className="stack" aria-label="Confirm deleting your account" onSubmit={submit}>
          <label className="field">
            <span>Type your email ({d.email}) to confirm. There is no undo.</span>
            <input value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
          </label>
          <ActionError code={state.code} />
          <div className="row-actions">
            <button type="button" className="btn btn-sm btn-quiet" onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button type="submit" className="btn btn-sm btn-danger" disabled={state.busy || typed.trim().toLowerCase() !== d.email}>
              Permanently delete my account
            </button>
          </div>
        </form>
      )}
    </div>
  )
}
