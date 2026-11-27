// Admin → Sales: assisted enrollment for a live sales call (server/enrollment.js, GET/POST /api/sales/enrollments).
// ONE screen: the list on the left, the selected enrollment on the right as the call goes: prospect → workspace →
// payment link (Stripe-hosted; GetShowUps never sees a card) → setup (opens the ordinary setup in configure mode) →
// readiness → ownership invitation. Platform admins see every enrollment and manage staff access; sales representatives
// see only their own; onboarding personnel configure and invite. The server checks all of it on every request; this
// screen only hides what a role can't use. Paid is what Stripe's verified webhook recorded, never a button here.
import { useCallback, useEffect, useState } from 'react'
import { api, browserTimeZone, timeZones } from '../lib/api.js'
import { EmptyState, LoadError, Loading, Pill, Section } from '../dashboard/ui.jsx'
import { humanDate } from '../lib/format.js'

const STAGE = {
  prospect: ['Prospect', 'info'],
  payment_sent: ['Payment link sent', 'warn'],
  paid: ['Paid', 'ok'],
  configuring: ['Setting up', 'warn'],
  ready: ['Ready to hand off', 'ok'],
  invited: ['Invitation sent', 'warn'],
  claimed: ['Claimed by owner', 'neutral'],
  abandoned: ['Abandoned', 'neutral'],
}
const ERRORS = {
  card_data_refused: 'That looks like a card number. Never type card details here: the owner pays on Stripe’s page.',
  invalid_name: 'Enter the business name (2–80 characters).',
  invalid_email: 'Enter the owner’s email address.',
  invalid_phone: 'Enter a 10-digit US phone number, or leave it empty.',
  invalid_timezone: 'Choose a time zone.',
  not_a_rep: 'That email isn’t an active sales representative.',
  plan_required: 'Choose a plan first.',
  workspace_exists: 'The workspace already exists.',
  workspace_required: 'Create the workspace first.',
  billing_not_live: 'Online payment isn’t open yet (Stripe is in test mode), so a payment link can only be made for test businesses and testers.',
  subscription_exists: 'This business already has a subscription in Stripe.',
  already_paid: 'Already paid.',
  payment_required: 'Waiting for Stripe to confirm the payment.',
  not_ready: 'Finish the required setup first.',
  already_claimed: 'The owner already claimed this business.',
  invitation_pending: 'Revoke the pending invitation before changing the owner’s email.',
  no_invitation: 'There is no invitation to revoke.',
  forbidden_role: 'Your role can’t do that.',
  not_found: 'This enrollment isn’t available to you.',
  migration_required: 'Enrollments aren’t available yet (database update pending).',
  rate_limited: 'Too many actions in a short time. Wait a few minutes.',
}
const say = (status, data) => ERRORS[status === 429 ? 'rate_limited' : data?.error] || 'Something went wrong. Try again.'
const post = (body) => api('/api/sales/enrollments', { method: 'POST', body })
const idFromHash = () => (/^#enr_[A-Za-z0-9_-]{16}$/.test(window.location.hash) ? window.location.hash.slice(1) : null)
const EMPTY = { businessName: '', ownerName: '', ownerEmail: '', phone: '', timezone: browserTimeZone(), planId: '', notes: '', assignedRepEmail: '' }

function StagePill({ stage, stale }) {
  const [label, tone] = stale ? ['Unpaid, maybe abandoned', 'neutral'] : STAGE[stage] || [stage, 'neutral']
  return <Pill tone={tone}>{label}</Pill>
}

function ProspectForm({ initial, plans, reps, onSave, locked, saveLabel }) {
  const [f, setF] = useState(initial)
  const [state, setState] = useState({})
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }))
  const submit = async (e) => {
    e.preventDefault()
    setState({ busy: true })
    const r = await onSave(f)
    setState(r?.error ? { error: r.error } : { saved: true })
  }
  return (
    <form className="form" onSubmit={submit} data-prospect-form>
      <label className="field">
        <span>Business name</span>
        <input required value={f.businessName} onChange={set('businessName')} maxLength={80} disabled={locked} />
      </label>
      <div className="field-row">
        <label className="field">
          <span>Owner’s name</span>
          <input value={f.ownerName} onChange={set('ownerName')} maxLength={80} autoComplete="off" />
        </label>
        <label className="field">
          <span>Owner’s email</span>
          <input type="email" required value={f.ownerEmail} onChange={set('ownerEmail')} autoComplete="off" />
        </label>
      </div>
      <div className="field-row">
        <label className="field">
          <span>Phone</span>
          <input inputMode="tel" value={f.phone} onChange={set('phone')} autoComplete="off" />
        </label>
        <label className="field">
          <span>Plan</span>
          <select value={f.planId || ''} onChange={set('planId')} disabled={locked}>
            {plans.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      {!locked && (
        <label className="field">
          <span>Time zone</span>
          <select value={f.timezone} onChange={set('timezone')}>
            {[...new Set([f.timezone, ...timeZones()])].map((tz) => (
              <option key={tz} value={tz}>
                {tz.replaceAll('_', ' ')}
              </option>
            ))}
          </select>
        </label>
      )}
      {reps && (
        <label className="field">
          <span>Sales representative</span>
          <select value={f.assignedRepEmail || ''} onChange={set('assignedRepEmail')}>
            <option value="">Founder (no representative)</option>
            {reps.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className="field">
        <span>Notes from the call</span>
        <textarea rows={3} value={f.notes} onChange={set('notes')} maxLength={2000} />
        <small className="fine">Never write card details here. The owner pays on Stripe’s secure page.</small>
      </label>
      {state.error && (
        <p className="form-error" role="alert">
          {state.error}
        </p>
      )}
      <button className="btn btn-primary" disabled={state.busy}>
        {state.busy ? 'Saving…' : saveLabel}
      </button>
      {state.saved && <span className="fine"> Saved</span>}
    </form>
  )
}

function CopyLink({ url, label, data }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }
  return (
    <div className="copy-link" {...{ [`data-${data}`]: url }}>
      <input readOnly value={url} aria-label={label} onFocus={(e) => e.target.select()} />
      <button type="button" className="btn btn-sm btn-quiet" onClick={copy}>
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  )
}

const ITEM_TONE = { ok: 'ok', action: 'warn', pending: 'info', off: 'neutral' }
const ITEM_WORD = { ok: 'Done', action: 'To do', pending: 'Waiting', off: 'Not available', owner: 'Owner turns it on' }

function Detail({ id, list, reload }) {
  const [d, setD] = useState(undefined)
  const [msg, setMsg] = useState(null)
  const [links, setLinks] = useState({})
  const [busy, setBusy] = useState(null)
  const load = useCallback(() => api(`/api/sales/enrollments?id=${encodeURIComponent(id)}`).then(({ status, data }) => setD(status === 200 ? data : { error: say(status, data) })), [id])
  // Keyed by id (a new enrollment mounts afresh), so the first load is all this effect does.
  useEffect(() => {
    load()
  }, [load])
  // While the owner is paying: Stripe's confirmation arrives by webhook; look again every 10 s.
  const waiting = d?.enrollment?.stage === 'payment_sent'
  useEffect(() => {
    if (!waiting) return
    const t = setInterval(load, 10000)
    return () => clearInterval(t)
  }, [waiting, load])
  const act = async (action, extra = {}, after) => {
    setBusy(action)
    setMsg(null)
    const { status, data } = await post({ action, id, ...extra })
    setBusy(null)
    if (status !== 200) return setMsg(say(status, data) + (data?.missing ? ` Missing: ${data.missing.join(', ')}.` : ''))
    after?.(data)
    await load()
    reload()
  }
  if (d === undefined) return <Loading what="enrollment" />
  if (d.error) return <p className="form-error">{d.error}</p>
  const e = d.enrollment
  const can = d.can
  const done = e.stage === 'claimed'
  return (
    <div className="stack" data-enrollment={e.id} data-stage={e.stage}>
      <div className="ui-section-head">
        <h2 className="ui-section-title">{e.businessName}</h2>
        <StagePill stage={e.stage} stale={e.stale} />
      </div>
      {e.stale && <p className="fine">Unpaid for more than {list.abandonAfterDays} days. Resend the payment link or mark it abandoned. Nothing is deleted.</p>}
      {msg && (
        <p className="form-error" role="alert">
          {msg}
        </p>
      )}
      <Section title="1. Prospect">
        {can.edit && !done ? (
          <ProspectForm
            key={e.updatedAt}
            initial={{ ...EMPTY, ...e, planId: e.planId || '', assignedRepEmail: e.assignedRep || '' }}
            plans={list.plans}
            reps={null}
            locked={Boolean(e.customer)}
            saveLabel="Save details"
            onSave={async (f) => {
              const { status, data } = await post({ action: 'update', id, ...f })
              if (status !== 200) return { error: say(status, data) }
              await load()
              reload()
              return {}
            }}
          />
        ) : (
          <p className="fine">
            {e.ownerName || 'Owner'} · {e.ownerEmail} {e.phone ? `· ${e.phone}` : ''}
          </p>
        )}
        {can.assign && list.reps && !done && (
          <label className="field">
            <span>Sales representative</span>
            <select value={e.assignedRep || ''} onChange={(ev) => act('assign', { repEmail: ev.target.value || null })} data-assign>
              <option value="">Founder (no representative)</option>
              {list.reps.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </label>
        )}
      </Section>
      <Section title="2. Workspace">
        {e.customer ? (
          <p className="fine">
            Created ({e.customer}). Until Stripe confirms payment it isn’t public, can’t take bookings and uses no paid services.
          </p>
        ) : (
          <button type="button" className="btn btn-primary" disabled={!can.workspace || busy} onClick={() => act('workspace')} data-create-workspace>
            {busy === 'workspace' ? 'Creating…' : 'Create workspace'}
          </button>
        )}
      </Section>
      {e.customer && (
        <Section title="3. Payment">
          {d.payment.paid ? (
            <p>
              <Pill tone="ok">Paid</Pill> <span className="fine">Confirmed by Stripe{e.paidAt ? ` on ${humanDate(e.paidAt)}` : ''}.</span>
            </p>
          ) : (
            <>
              <p className="fine">The owner pays on Stripe’s page (price, monthly billing and the authorization are shown there). {d.payment.sends ? `Link created ${d.payment.sends}×.` : ''}</p>
              {can.payment && !done && (
                <div className="btn-row">
                  <button type="button" className="btn btn-primary" disabled={Boolean(busy)} onClick={() => act('payment', {}, (r) => setLinks((x) => ({ ...x, pay: r.url })))} data-payment-link>
                    {busy === 'payment' ? 'Creating…' : d.payment.sends ? 'New payment link' : 'Create payment link'}
                  </button>
                  <button type="button" className="btn btn-quiet" disabled={Boolean(busy)} onClick={() => act('payment', { email: true }, (r) => setLinks((x) => ({ ...x, pay: r.url, emailed: r.emailed })))} data-payment-email>
                    Email it to the owner
                  </button>
                </div>
              )}
              {links.pay && <CopyLink url={links.pay} label="Payment link" data="pay-url" />}
              {links.emailed && <p className="fine">Queued for {e.ownerEmail} (delivered only when email sending is on for that address).</p>}
              <p className="fine">
                <Pill tone="warn">Waiting for Stripe</Pill> Paid shows here automatically once Stripe confirms.
              </p>
            </>
          )}
        </Section>
      )}
      {e.customer && !done && (
        <Section title="4. Set up the business">
          <p className="fine">Opens the owner’s setup (services, prices, hours, area, website, receptionist) for this business. You stay signed in as yourself.</p>
          <div className="btn-row">
            {d.configureUrl && can.configure && (
              <a className="btn btn-primary" href={d.configureUrl} target="_blank" rel="noopener" data-configure>
                Open setup
              </a>
            )}
            {d.previewUrl && (
              <a className="btn btn-quiet" href={d.previewUrl} target="_blank" rel="noopener" data-preview>
                Preview website
              </a>
            )}
            <button type="button" className="btn btn-quiet" onClick={load}>
              Refresh
            </button>
          </div>
        </Section>
      )}
      {e.customer && (
        <Section title="5. Ready to hand off?">
          <ul className="rows" data-checklist>
            {d.checklist.items.map((i) => (
              <li key={i.id} className="row" data-check={i.id} data-state={i.state}>
                <div className="row-main">
                  <p className="row-title">
                    {i.label}
                    {i.optional ? ' (optional)' : ''}
                  </p>
                </div>
                <Pill tone={ITEM_TONE[i.state] || 'neutral'}>{ITEM_WORD[i.state] || i.state}</Pill>
              </li>
            ))}
          </ul>
          {d.checklist.setupChecks.length > 0 && (
            <ul className="fine">
              {d.checklist.setupChecks.map((c) => (
                <li key={c.id}>{c.title}</li>
              ))}
            </ul>
          )}
        </Section>
      )}
      {e.customer && (
        <Section title="6. Ownership invitation">
          {done ? (
            <p className="fine">Claimed{e.claimedAt ? ` on ${humanDate(e.claimedAt)}` : ''}. Staff access to this business has ended.</p>
          ) : (
            <>
              <p className="fine">
                {d.invitation.state === 'pending'
                  ? `Sent to ${e.ownerEmail}; expires ${humanDate(d.invitation.expiresAt)}.`
                  : d.invitation.state === 'expired'
                    ? 'The invitation expired. Send a new one.'
                    : d.invitation.state === 'revoked'
                      ? 'The invitation was revoked.'
                      : `The owner signs in with ${e.ownerEmail}, accepts the terms and lands on this setup.`}
              </p>
              {can.invite && (
                <div className="btn-row">
                  <button type="button" className="btn btn-primary" disabled={!d.checklist.ready || Boolean(busy)} onClick={() => act('invite', {}, (r) => setLinks((x) => ({ ...x, claim: r.url })))} data-send-invite>
                    {busy === 'invite' ? 'Sending…' : d.invitation.state === 'none' ? 'Send ownership invitation' : 'Send a new invitation'}
                  </button>
                  {d.invitation.state === 'pending' && (
                    <button type="button" className="btn btn-quiet" disabled={Boolean(busy)} onClick={() => act('revoke_invite')} data-revoke-invite>
                      Revoke
                    </button>
                  )}
                </div>
              )}
              {links.claim && <CopyLink url={links.claim} label="Ownership link" data="claim-url" />}
            </>
          )}
        </Section>
      )}
      {can.abandon && !d.payment.paid && !done && e.stage !== 'abandoned' && (
        <p>
          <button type="button" className="link-btn" onClick={() => act('abandon')} data-abandon>
            Mark abandoned (keeps everything)
          </button>
        </p>
      )}
    </div>
  )
}

function StaffAccess({ roles, reload }) {
  const [f, setF] = useState({ email: '', role: 'sales_rep' })
  const [msg, setMsg] = useState(null)
  const send = async (body) => {
    setMsg(null)
    const { status, data } = await api('/api/sales/roles', { method: 'POST', body })
    if (status !== 200) return setMsg(data?.error === 'already_admin' ? 'Platform admins already have every permission.' : data?.error === 'invalid_email' ? 'Enter an email address.' : 'Couldn’t change access. Try again.')
    setF((x) => ({ ...x, email: '' }))
    reload()
  }
  return (
    <Section title="Sales team access" label="Sales team access">
      <p className="fine">Sales representatives see only their own prospects. Onboarding can set up any business before its handoff. Removing access takes effect immediately.</p>
      {roles.length === 0 ? (
        <p className="fine">No one yet.</p>
      ) : (
        <ul className="rows" data-staff-roles>
          {roles.map((r) => (
            <li key={r.id} className="row" data-role-row={`${r.email}:${r.role}`}>
              <div className="row-main">
                <p className="row-title">{r.email}</p>
                <p className="row-sub">{r.role === 'sales_rep' ? 'Sales representative' : 'Onboarding'}</p>
              </div>
              <button type="button" className="btn btn-sm btn-quiet" onClick={() => send({ action: 'revoke', email: r.email, role: r.role })}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="field-row"
        onSubmit={(e) => {
          e.preventDefault()
          send({ action: 'grant', ...f })
        }}
      >
        <label className="field">
          <span>Email</span>
          <input type="email" required value={f.email} onChange={(e) => setF((x) => ({ ...x, email: e.target.value }))} />
        </label>
        <label className="field">
          <span>Role</span>
          <select value={f.role} onChange={(e) => setF((x) => ({ ...x, role: e.target.value }))}>
            <option value="sales_rep">Sales representative</option>
            <option value="onboarding">Onboarding</option>
          </select>
        </label>
        <button className="btn btn-primary">Give access</button>
      </form>
      {msg && (
        <p className="form-error" role="alert">
          {msg}
        </p>
      )}
    </Section>
  )
}

export default function Enrollments() {
  const [list, setList] = useState(undefined)
  const [selected, setSelected] = useState(idFromHash)
  const [creating, setCreating] = useState(false)
  const load = useCallback(() => api('/api/sales/enrollments').then(({ status, data }) => setList(status === 200 ? data : null)), [])
  useEffect(() => {
    load()
    const on = () => setSelected(idFromHash())
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [load])
  const choose = (id) => {
    window.history.replaceState(null, '', `${window.location.pathname}${id ? `#${id}` : ''}`)
    setCreating(false)
    setSelected(id)
  }
  if (list === undefined) return <Loading what="enrollments" />
  if (list === null) return <LoadError what="enrollments" onRetry={load} />
  const canCreate = list.roles.includes('platform_admin') || list.roles.includes('sales_rep')
  const admin = list.roles.includes('platform_admin')
  return (
    <div className="enter enrollments" data-enrollments>
      <div className="page-head">
        <h1 className="title title--page">Enrollments</h1>
        {canCreate && list.ready && (
          <button type="button" className="btn btn-primary" onClick={() => (setCreating(true), setSelected(null))} data-new-prospect>
            New prospect
          </button>
        )}
      </div>
      {!list.ready ? (
        <p className="fine">Enrollments aren’t available yet (database update pending).</p>
      ) : (
        <div className="enrollments-grid">
          <Section title="Prospects" label="Prospects">
            {list.enrollments.length === 0 ? (
              <EmptyState title="No prospects yet">Add the business you’re talking to, then create its workspace and payment link.</EmptyState>
            ) : (
              <ul className="rows" data-enrollment-list>
                {list.enrollments.map((x) => (
                  <li key={x.id} className={`row${x.id === selected ? ' is-current' : ''}`}>
                    <button type="button" className="row-main link-btn row-btn" onClick={() => choose(x.id)} data-pick={x.id}>
                      <span className="row-title">{x.businessName}</span>
                      <span className="row-sub">
                        {x.ownerEmail}
                        {admin && x.assignedRep ? ` · ${x.assignedRep}` : ''}
                      </span>
                    </button>
                    <StagePill stage={x.stage} stale={x.stale} />
                  </li>
                ))}
              </ul>
            )}
          </Section>
          <div>
            {creating ? (
              <Section title="New prospect">
                <ProspectForm
                  initial={{ ...EMPTY, planId: list.plans[0]?.id || '' }}
                  plans={list.plans}
                  reps={admin ? list.reps || [] : null}
                  locked={false}
                  saveLabel="Save prospect"
                  onSave={async (f) => {
                    const { status, data } = await post({ action: 'create', ...f })
                    if (status !== 200) return { error: say(status, data) }
                    await load()
                    choose(data.id)
                    return {}
                  }}
                />
              </Section>
            ) : selected ? (
              <Detail key={selected} id={selected} list={list} reload={load} />
            ) : (
              <p className="fine">Choose a prospect, or add a new one.</p>
            )}
          </div>
        </div>
      )}
      {admin && list.staffRoles && <StaffAccess roles={list.staffRoles} reload={load} />}
    </div>
  )
}
