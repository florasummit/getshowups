import { useCallback, useEffect, useState } from 'react'
import { api, whenFull } from '../lib/api.js'
import { PageHeader, Pill, Section } from './ui.jsx'

// Teach Your AI: the owner decides how their AI receptionist works. The page opens with one strip that answers
// "what does it know → what does it do → test it → publish" at a glance (Flow), then the editor on the left (what it
// knows, how it works, teach a change) with the test conversation and publish panel beside it, always in reach.
// Edits change a DRAFT only; customers get a rule set only after an explicit publish (and only once GetShowUps has
// switched live use on for the business). Nothing here talks to customers, the calendar or the voice provider.

const SAMPLE = {
  pool: (town) => `My pool is green. I'm in ${town} and need someone Friday.`,
  hvac: (town) => `My AC stopped cooling and it's 95 degrees in here. I'm in ${town}.`,
  electrical: () => 'I smell something burning near my breaker panel.',
  general: (town) => `Hi, I need some help at my house in ${town}.`,
}
const CONFLICT = 'These rules were changed somewhere else (another tab or device). Nothing was saved. The latest version is shown now; make your change again.'
const ERRORS = { network_error: 'Couldn’t reach GetShowUps. Check your connection and try again.', storage_error: 'Something went wrong on our side. Try again in a moment.', rate_limited: 'Too many changes in a short time. Wait a few minutes.' }
const errText = (r) => (r.status === 429 ? ERRORS.rate_limited : ERRORS[r.data?.error] || 'That didn’t work. Try again.')

function Chips({ items, onRemove, label }) {
  if (!items.length) return <p className="fine">None yet.</p>
  return (
    <ul className="ta-chips" aria-label={label}>
      {items.map((x) => (
        <li key={x}>
          {x}
          {onRemove && (
            <button type="button" className="ta-chip-x" onClick={() => onRemove(x)} aria-label={`Remove ${x}`}>
              ×
            </button>
          )}
        </li>
      ))}
    </ul>
  )
}

function AddRow({ label, placeholder, onAdd, max = 60 }) {
  const [v, setV] = useState('')
  const add = () => {
    const t = v.trim()
    if (!t) return
    onAdd(t)
    setV('')
  }
  return (
    <div className="ta-add">
      <label className="field">
        <span>{label}</span>
        <input
          value={v}
          maxLength={max}
          placeholder={placeholder}
          onChange={(e) => setV(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              add()
            }
          }}
        />
      </label>
      <button type="button" className="btn btn-quiet btn-sm" onClick={add} disabled={!v.trim()}>
        Add
      </button>
    </div>
  )
}

const same = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase()

export default function TeachAI() {
  const [data, setData] = useState(null)
  const [draft, setDraft] = useState(null)
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState('')
  const [msg, setMsg] = useState(null) // { tone, text }
  const [problems, setProblems] = useState([])

  const take = useCallback((d) => {
    setData(d)
    setDraft(d.draft)
    setDirty(false)
    setProblems(d.errors || [])
  }, [])
  const show = useCallback((r) => (r.status === 200 ? take(r.data) : setData({ failed: r.status === 404 ? 'not_available' : 'error' })), [take])
  const load = useCallback(() => api('/api/dashboard/ai-rules').then(show), [show])
  useEffect(() => {
    let on = true
    api('/api/dashboard/ai-rules').then((r) => on && show(r))
    return () => {
      on = false
    }
  }, [show])
  // Unsaved rule edits are lost on leaving: warn first (like the website editor).
  useEffect(() => {
    if (!dirty) return
    const warn = (e) => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])

  const edit = (fn) => {
    setDraft((d) => {
      const next = structuredClone(d)
      fn(next)
      return next
    })
    setDirty(true)
    setMsg(null)
  }
  // Every write: one place for conflicts and errors.
  const post = async (body, okText) => {
    setBusy(body.action)
    setMsg(null)
    const r = await api('/api/dashboard/ai-rules', { method: 'POST', body })
    setBusy('')
    if (r.status === 409 && r.data?.error === 'conflict') {
      take(r.data)
      setMsg({ tone: 'warn', text: CONFLICT })
      return null
    }
    if (r.status === 422) {
      setProblems(r.data.errors || [])
      setMsg({ tone: 'bad', text: 'Some rules need fixing first (see below). Nothing was saved.' })
      return null
    }
    if (r.status !== 200) {
      setMsg({ tone: 'bad', text: errText(r) })
      return null
    }
    if (r.data.draft) take(r.data)
    if (okText) setMsg({ tone: 'ok', text: okText })
    return r.data
  }
  const save = () => post({ action: 'save', config: draft, baseUpdatedAt: data.draftUpdatedAt }, 'Draft saved. Customers still get your published rules until you publish.')

  if (!data) return <div aria-busy="true" className="ui-skeleton-page" />
  if (data.failed === 'not_available') return <p className="fine">Teach Your AI isn’t available for your account yet.</p>
  if (data.failed) {
    return (
      <p className="fine" role="alert">
        Couldn’t load your AI rules.{' '}
        <button type="button" className="link-btn" onClick={load}>
          Try again
        </button>
      </p>
    )
  }
  const rec = data.records
  const c = data.choices
  const status = data.status
  const liveLabel = data.liveVersion ? `Version ${data.liveVersion} published` : 'Not published yet'

  return (
    <div className="ui-page ta">
      <PageHeader
        title="Teach Your AI"
        status={<Pill tone={data.liveVersion ? (status.rulesLive ? 'ok' : 'info') : 'neutral'}>{data.liveVersion ? (status.rulesLive ? `Live: version ${data.liveVersion}` : liveLabel) : liveLabel}</Pill>}
      >
        What it knows, what it asks, what counts as urgent, when to hand off. Edits stay in your draft until you test and publish.
      </PageHeader>
      <Flow data={data} draft={draft} dirty={dirty} />
      {!status.receptionistOn && (
        <p className="fine" data-receptionist-state="off">
          Your receptionist is off, so customers don’t talk to it yet. You can prepare and test its rules here now; turn it on in the Receptionist tab when you’re ready.
        </p>
      )}
      {msg && (
        <p className={`ui-callout ui-callout--${msg.tone === 'ok' ? 'ok' : msg.tone === 'warn' ? 'warn' : 'bad'}`} role={msg.tone === 'ok' ? 'status' : 'alert'}>
          {msg.text}
        </p>
      )}
      <div className="ta-layout">
        <div className="ta-main">
          <About rec={rec} draft={draft} edit={edit} />
          <How draft={draft} rec={rec} c={c} edit={edit} platformRules={data.platformRules} />
          <SaveBar dirty={dirty} busy={busy} save={save} problems={problems} discard={() => take(data)} />
          <Teach data={data} dirty={dirty} post={post} />
        </div>
        <aside className="ta-side">
          <Test data={data} draft={draft} dirty={dirty} />
          <Publish data={data} dirty={dirty} busy={busy} post={post} />
        </aside>
      </div>
    </div>
  )
}

// The strip at the top: four cards that read as a sentence (knows → does → test → publish), each a link to its
// section. Derived from the same data the sections edit; nothing here is stored.
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`
function Flow({ data, draft, dirty }) {
  const rec = data.records
  const c = data.choices
  const asks = draft.intake.filter((i) => !(c.intake[i.id].visitOnly && !rec.visit) && (i.required || c.intake[i.id].platform)).length
  const live = data.liveVersion
  const state = !live ? ['neutral', 'Not published yet'] : dirty || data.hasDraftChanges ? ['info', `Draft differs from version ${live}`] : ['ok', `Version ${live} published`]
  const cards = [
    ['#ta-about', 'What it knows', `${plural(rec.services.length, 'service')} · ${plural(draft.coverage.cityWide.length, 'town')} fully served · ${rec.zipCount ? plural(rec.zipCount, 'ZIP code') : 'no ZIP limit'}`, draft.services.excluded.length ? `${draft.services.excluded.length} not offered` : 'From your records'],
    ['#ta-how', 'What it does', `Asks ${plural(asks, 'thing')} before booking · ${plural(draft.emergency.triggers.length, 'urgent situation')}`, `${plural(draft.escalation.length, 'hand-off')} · ${c.styles[draft.style] || draft.style}`],
    ['#ta-test', 'Test it', 'Type what a customer might say', 'Nothing is sent or booked'],
    ['#ta-publish', 'Publish', state[1], dirty ? 'Unsaved edits' : data.hasDraftChanges ? `${plural(data.changesSinceLive.length, 'change')} to publish` : 'Draft matches'],
  ]
  return (
    <nav className="ta-flow" aria-label="Teach Your AI steps">
      {cards.map(([href, title, line, sub], i) => (
        <a key={href} href={href} className={`ta-flow-card ta-flow-card--${i + 1}`} data-tone={i === 3 ? state[0] : undefined}>
          <span className="ta-flow-n" aria-hidden="true">
            {i + 1}
          </span>
          <span className="ta-flow-title">{title}</span>
          <span className="ta-flow-line">{line}</span>
          <span className="ta-flow-sub">{sub}</span>
        </a>
      ))}
    </nav>
  )
}

function SaveBar({ dirty, busy, save, problems, discard }) {
  return (
    <div className={`ta-savebar${dirty ? ' ta-savebar--dirty' : ''}`}>
      {problems.length > 0 && (
        <ul className="ta-problems" role="alert">
          {problems.map((p, i) => (
            <li key={i}>{p.message}</li>
          ))}
        </ul>
      )}
      <div className="ui-form-actions">
        <button type="button" className="btn btn-primary btn-sm" onClick={save} disabled={!dirty || Boolean(busy)}>
          {busy === 'save' ? 'Saving…' : 'Save draft'}
        </button>
        {dirty && (
          <button type="button" className="btn btn-quiet btn-sm" onClick={discard} disabled={Boolean(busy)}>
            Undo my edits
          </button>
        )}
        <span className="fine" role="status">
          {dirty ? 'Unsaved changes' : 'Draft saved'}
        </span>
      </div>
    </div>
  )
}

function About({ rec, draft, edit }) {
  const cityWide = draft.coverage.cityWide
  return (
    <Section id="ta-about" title="1. About your business" label="About your business" className="ta-section">
      <p className="ui-hint">
        From your records. Change services, prices, towns, ZIP codes or hours in <a href="/dashboard/settings">Settings</a>.
      </p>
      <dl className="ui-facts ta-facts">
        <div>
          <dt>Services</dt>
          <dd>{rec.services.length ? rec.services.map((s) => (s.price ? `${s.name} (${s.price})` : s.name)).join(' · ') : 'None listed yet'}</dd>
        </div>
        <div>
          <dt>Appointments</dt>
          <dd>{rec.visit ? 'You visit the customer (a service address is always collected)' : 'Customers come to you'}</dd>
        </div>
        <div>
          <dt>ZIP codes you serve</dt>
          <dd>{rec.zipCount ? `${rec.zipCount} ZIP code${rec.zipCount === 1 ? '' : 's'}${rec.zips.length ? `: ${rec.zips.slice(0, 12).join(', ')}${rec.zipCount > 12 ? '…' : ''}` : ''}` : 'Not limited (everywhere is served)'}</dd>
        </div>
        <div>
          <dt>Booking hours</dt>
          <dd>{rec.hoursConfirmed ? 'Confirmed in Settings' : 'Not confirmed yet'}</dd>
        </div>
      </dl>
      <fieldset className="ui-group">
        <legend>Towns you serve completely</legend>
        <p className="ui-hint">Naming one of these towns confirms the area; no ZIP code is asked. Bookings still record the ZIP code.</p>
        {rec.towns.length === 0 && <p className="fine">Add the towns you serve in Settings first.</p>}
        {rec.towns.map((t) => (
          <label key={t} className="check">
            <input
              type="checkbox"
              checked={cityWide.some((x) => same(x, t))}
              onChange={(e) =>
                edit((d) => {
                  d.coverage.cityWide = e.target.checked ? [...d.coverage.cityWide, t] : d.coverage.cityWide.filter((x) => !same(x, t))
                })
              }
            />
            <span>All of {t}</span>
          </label>
        ))}
      </fieldset>
      <fieldset className="ui-group">
        <legend>Services you don’t offer</legend>
        <p className="ui-hint">Declined politely, never booked.</p>
        <Chips items={draft.services.excluded} label="Services you don’t offer" onRemove={(x) => edit((d) => (d.services.excluded = d.services.excluded.filter((y) => y !== x)))} />
        <AddRow label="Add a service you don’t offer" placeholder="e.g. New installations" max={80} onAdd={(v) => edit((d) => !d.services.excluded.some((x) => same(x, v)) && d.services.excluded.push(v))} />
      </fieldset>
    </Section>
  )
}

function How({ draft, rec, c, edit, platformRules }) {
  const items = draft.intake.filter((i) => !(c.intake[i.id].visitOnly && !rec.visit))
  const move = (id, dir) =>
    edit((d) => {
      const a = d.intake.findIndex((i) => i.id === id)
      // Skip items hidden for this business (the address for businesses customers come to).
      let b = a + dir
      while (b >= 0 && b < d.intake.length && c.intake[d.intake[b].id].visitOnly && !rec.visit) b += dir
      if (b < 0 || b >= d.intake.length) return
      ;[d.intake[a], d.intake[b]] = [d.intake[b], d.intake[a]]
    })
  const set = (id, k, v) => edit((d) => (d.intake.find((i) => i.id === id)[k] = v))
  const [when, setWhen] = useState('person')
  const [phrase, setPhrase] = useState('')
  const [action, setAction] = useState('callback')
  return (
    <Section id="ta-how" title="2. How your AI works" label="How your AI works" className="ta-section">
      <fieldset className="ui-group">
        <legend>What it finds out, in this order</legend>
        <p className="ui-hint">Uses everything the customer already said; asks only for what’s missing, one question at a time.</p>
        <ol className="ta-intake">
          {items.map((i, n) => {
            const meta = c.intake[i.id]
            return (
              <li key={i.id} className="ta-intake-row">
                <span className="ta-intake-n" aria-hidden="true">
                  {n + 1}
                </span>
                <div className="ta-intake-main">
                  <strong>{meta.label}</strong>
                  <div className="ta-intake-opts">
                    {meta.platform ? (
                      <span className="fine">Always asked before a booking</span>
                    ) : (
                      <label className="check">
                        <input type="checkbox" checked={i.required} onChange={(e) => set(i.id, 'required', e.target.checked)} />
                        <span>Ask every customer</span>
                      </label>
                    )}
                    {i.id === 'location' ? (
                      <span className="fine">Always checked before offering times</span>
                    ) : (
                      !['contact', 'address'].includes(i.id) && (
                        <label className="check">
                          <input type="checkbox" checked={i.beforeTimes} disabled={!i.required} onChange={(e) => set(i.id, 'beforeTimes', e.target.checked)} />
                          <span>Needed before offering times</span>
                        </label>
                      )
                    )}
                  </div>
                </div>
                <div className="ta-move">
                  <button type="button" className="ui-icon-btn" onClick={() => move(i.id, -1)} disabled={n === 0} aria-label={`Move ${meta.label} up`}>
                    ↑
                  </button>
                  <button type="button" className="ui-icon-btn" onClick={() => move(i.id, 1)} disabled={n === items.length - 1} aria-label={`Move ${meta.label} down`}>
                    ↓
                  </button>
                </div>
              </li>
            )
          })}
        </ol>
      </fieldset>

      <fieldset className="ui-group">
        <legend>Urgent situations</legend>
        <p className="ui-hint">Danger (gas, fire, sparks, carbon monoxide) always comes first: get safe, call 911. Add your own urgent situations.</p>
        <Chips items={draft.emergency.triggers} label="Urgent situations" onRemove={(x) => edit((d) => (d.emergency.triggers = d.emergency.triggers.filter((y) => y !== x)))} />
        <AddRow label="Add an urgent situation" placeholder="e.g. no heat" onAdd={(v) => edit((d) => !d.emergency.triggers.some((x) => same(x, v)) && d.emergency.triggers.push(v))} />
        <label className="field">
          <span>When one comes up</span>
          <select value={draft.emergency.action} onChange={(e) => edit((d) => (d.emergency.action = e.target.value))}>
            {Object.entries(c.emergencyActions).map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </label>
      </fieldset>

      <fieldset className="ui-group">
        <legend>Hand-offs to your team</legend>
        <p className="ui-hint">No live transfer exists (no phone line is connected): a hand-off records a callback request or a message for you.</p>
        {draft.escalation.length === 0 && <p className="fine">None yet.</p>}
        <ul className="ta-list">
          {draft.escalation.map((e) => (
            <li key={`${e.when}:${e.phrase || ''}`}>
              <span>
                {e.when === 'phrase' ? `They mention “${e.phrase}”` : c.escalationWhen[e.when]} → {c.escalationActions[e.action].toLowerCase()}
              </span>
              <button type="button" className="link-btn" onClick={() => edit((d) => (d.escalation = d.escalation.filter((x) => !(x.when === e.when && (x.phrase || '') === (e.phrase || '')))))}>
                Remove
              </button>
            </li>
          ))}
        </ul>
        <div className="ta-add ta-add--wide">
          <label className="field">
            <span>When</span>
            <select value={when} onChange={(e) => setWhen(e.target.value)}>
              {Object.entries(c.escalationWhen).map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </label>
          {when === 'phrase' && (
            <label className="field">
              <span>Phrase</span>
              <input value={phrase} maxLength={60} onChange={(e) => setPhrase(e.target.value)} placeholder="e.g. property manager" />
            </label>
          )}
          <label className="field">
            <span>Then</span>
            <select value={action} onChange={(e) => setAction(e.target.value)}>
              {Object.entries(c.escalationActions).map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="btn btn-quiet btn-sm"
            disabled={when === 'phrase' && !phrase.trim()}
            onClick={() => {
              edit((d) => {
                d.escalation = d.escalation.filter((x) => !(x.when === when && (x.phrase || '') === (when === 'phrase' ? phrase.trim() : '')))
                d.escalation.push({ when, action, ...(when === 'phrase' ? { phrase: phrase.trim() } : {}) })
              })
              setPhrase('')
            }}
          >
            Add hand-off
          </button>
        </div>
      </fieldset>

      <fieldset className="ui-group ta-selects">
        <legend>Hours, prices and tone</legend>
        <label className="field">
          <span>After hours</span>
          <select value={draft.afterHours} onChange={(e) => edit((d) => (d.afterHours = e.target.value))}>
            {Object.entries(c.afterHours).map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Prices</span>
          <select value={draft.pricing} onChange={(e) => edit((d) => (d.pricing = e.target.value))}>
            {Object.entries(c.pricing).map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Tone</span>
          <select value={draft.style} onChange={(e) => edit((d) => (d.style = e.target.value))}>
            {Object.entries(c.styles).map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </label>
      </fieldset>

      <details className="ui-group ui-group--advanced">
        <summary>Rules GetShowUps always follows</summary>
        <p className="ui-hint">These protect you and your customers and can’t be changed.</p>
        <ul className="ta-locked">
          {platformRules.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      </details>
    </Section>
  )
}

function Teach({ data, dirty, post }) {
  const [text, setText] = useState('')
  const [proposal, setProposal] = useState(null)
  const ask = async (e) => {
    e?.preventDefault()
    const r = await post({ action: 'teach', text })
    if (r?.proposal) setProposal(r.proposal)
  }
  // "This answer is wrong" in Test your AI brings the correction here, to finish and review like any change.
  useEffect(() => {
    const on = (e) => {
      setText(e.detail)
      setProposal(null)
      document.getElementById('ta-teach')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
    window.addEventListener('gsu:correct', on)
    return () => window.removeEventListener('gsu:correct', on)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  const apply = async () => {
    const r = await post({ action: 'apply', ops: proposal.ops, baseUpdatedAt: data.draftUpdatedAt }, 'Change added to your draft. Test it, then publish when you’re ready.')
    if (r) {
      setProposal(null)
      setText('')
    }
  }
  return (
    <Section id="ta-teach" title="3. Teach a change" label="Teach a change" className="ta-section">
      <form className="ui-group" onSubmit={ask}>
        <label className="field">
          <span>Describe the change in your own words</span>
          <textarea rows={3} maxLength={1200} value={text} onChange={(e) => setText(e.target.value)} placeholder="e.g. Ask what the customer needs before asking where they live. We don’t do commercial pools." />
          <span className="ui-hint">Rules, facts, seasons, what a job is usually worth: say “remember that…” or describe it. You see exactly what would change before anything is saved.</span>
        </label>
        <div className="ui-form-actions">
          <button type="submit" className="btn btn-primary btn-sm" disabled={!text.trim() || dirty}>
            Suggest the change
          </button>
          {dirty && <span className="fine">Save your draft first, so the suggestion builds on your latest edits.</span>}
        </div>
      </form>
      {data.suggestions?.filter((s) => s.teach).length > 0 && (
        <div className="ta-suggest">
          <p className="ta-label">Suggestions from your recent conversations</p>
          <ul className="ta-list">
            {data.suggestions
              .filter((s) => s.teach)
              .map((s) => (
                <li key={s.id}>
                  <span>{s.text}</span>
                  <button type="button" className="link-btn" onClick={() => setText(s.teach)}>
                    Use this
                  </button>
                </li>
              ))}
          </ul>
        </div>
      )}
      {proposal && (
        <div className="ta-proposal" role="region" aria-label="Suggested change">
          <p className="ta-label">{proposal.changes.length ? 'This would change:' : 'Nothing would change.'}</p>
          {proposal.changes.length > 0 && (
            <ul className="ta-diff">
              {proposal.changes.map((x) => (
                <li key={x}>{x}</li>
              ))}
            </ul>
          )}
          {proposal.notes.map((n) => (
            <p key={n} className="ui-callout ui-callout--info">
              {n}
            </p>
          ))}
          {proposal.refused.map((r) => (
            <p key={r.text + r.reason} className="ui-callout ui-callout--warn">
              Not changed: {r.reason}
            </p>
          ))}
          {proposal.conflicts.map((x) => (
            <p key={x} className="ui-callout ui-callout--bad">
              {x}
            </p>
          ))}
          {proposal.warnings.map((x) => (
            <p key={x} className="ui-callout ui-callout--warn">
              {x}
            </p>
          ))}
          {proposal.notUnderstood.length > 0 && (
            <p className="ui-callout ui-callout--warn">
              Not understood: “{proposal.notUnderstood.join(' ')}”. Try saying it another way, or use the controls in “How your AI works”.
            </p>
          )}
          <div className="ui-form-actions">
            <button type="button" className="btn btn-primary btn-sm" onClick={apply} disabled={!proposal.approvable}>
              Add to my draft
            </button>
            <button type="button" className="btn btn-quiet btn-sm" onClick={() => setProposal(null)}>
              Discard
            </button>
          </div>
        </div>
      )}
    </Section>
  )
}

function Test({ data, draft, dirty }) {
  const town = data.records.towns[0] || 'town'
  const [lines, setLines] = useState([])
  const [text, setText] = useState('')
  const [use, setUse] = useState('draft')
  const [result, setResult] = useState(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const sample = (SAMPLE[draft.industry] || SAMPLE.general)(town)
  const run = async (all) => {
    setBusy(true)
    setErr('')
    const r = await api('/api/dashboard/ai-rules', { method: 'POST', body: { action: 'simulate', lines: all, use, ...(use === 'draft' && dirty ? { config: draft } : {}) } })
    setBusy(false)
    if (r.status === 200) setResult(r.data.simulation)
    else setErr(r.status === 422 ? 'Fix the problems in your draft first.' : r.data?.error === 'nothing_published' ? 'Nothing is published yet.' : errText(r))
  }
  const send = (e) => {
    e?.preventDefault()
    const t = text.trim()
    if (!t || lines.length >= data.limits.lines) return
    const all = [...lines, t]
    setLines(all)
    setText('')
    run(all)
  }
  const reset = () => {
    setLines([])
    setResult(null)
    setErr('')
  }
  // Re-run when switching between draft and live rules.
  useEffect(() => {
    if (lines.length) run(lines)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [use])
  return (
    <Section id="ta-test" title="4. Test your AI" label="Test your AI" className="ta-section">
      <p className="ui-hint">A preview of your rules: what your AI understands and does next. No AI call, no calendar lookup, nothing is sent or booked.</p>
      <div className="ta-test-head">
        <div className="ta-toggle" role="radiogroup" aria-label="Rules to test">
          <label className="check">
            <input type="radio" name="ta-use" checked={use === 'draft'} onChange={() => setUse('draft')} />
            <span>My draft{dirty ? ' (unsaved edits included)' : ''}</span>
          </label>
          <label className="check">
            <input type="radio" name="ta-use" checked={use === 'live'} disabled={!data.liveVersion} onChange={() => setUse('live')} />
            <span>Published rules{data.liveVersion ? '' : ' (none yet)'}</span>
          </label>
        </div>
        {lines.length > 0 && (
          <button type="button" className="btn btn-quiet btn-sm" onClick={reset}>
            Start over
          </button>
        )}
      </div>
      <div className="ta-chat" aria-live="polite">
        {lines.length === 0 && (
          <p className="fine">
            Try:{' '}
            <button type="button" className="link-btn" onClick={() => setText(sample)}>
              “{sample}”
            </button>
          </p>
        )}
        {lines.map((l, i) => {
          const t = result?.turns?.[i]
          return (
            <div key={i} className="ta-turn">
              <p className="rc-msg rc-msg--customer ta-msg">{l}</p>
              {t ? (
                <>
                  <p className="rc-msg rc-msg--receptionist ta-msg">
                    <span className="rc-tag">Example reply</span>
                    {t.reply}
                  </p>
                  <div className="ta-why">
                    {Object.keys(t.recognized).length > 0 && (
                      <p className="ta-understood">
                        <span className="ta-label">Understood:</span>{' '}
                        {Object.entries(t.recognized)
                          .filter(([k]) => !['correction', 'hesitant', 'conflicts'].includes(k))
                          .map(([k, v]) => (
                            <span key={k} className="ta-fact">
                              {LABEL[k] || k}: {String(v === true ? 'yes' : v === false ? 'no' : v)}
                            </span>
                          ))}
                      </p>
                    )}
                    <button type="button" className="link-btn" onClick={() => window.dispatchEvent(new CustomEvent('gsu:correct', { detail: `Correction. A customer asked: “${l}” The answer was: “${t.reply}” That’s wrong. What’s right: ` }))}>
                      This answer is wrong
                    </button>
                    <ul className="ta-explain">
                      {t.explanations.map((x) => (
                        <li key={x.code + x.text} className={`ta-explain--${x.code}`}>
                          {x.text}
                        </li>
                      ))}
                    </ul>
                  </div>
                </>
              ) : busy && i === lines.length - 1 ? (
                <div className="ui-skeleton-block" aria-busy="true" />
              ) : null}
            </div>
          )
        })}
      </div>
      {err && (
        <p className="rc-error" role="alert">
          {err}
        </p>
      )}
      <form className="ta-send" onSubmit={send}>
        <label className="field">
          <span className="sr-only">What the customer says</span>
          <input value={text} maxLength={data.limits.chars} onChange={(e) => setText(e.target.value)} placeholder={lines.length ? 'What the customer says next…' : 'What the customer says…'} disabled={lines.length >= data.limits.lines} />
        </label>
        <button type="submit" className="btn btn-primary btn-sm" disabled={busy || !text.trim() || lines.length >= data.limits.lines}>
          Send
        </button>
      </form>
      {lines.length >= data.limits.lines && <p className="fine">That’s the end of this test. Start over to try another.</p>}
    </Section>
  )
}
const LABEL = { need: 'Need', service: 'Service', excluded: 'Not offered', city: 'Town', zip: 'ZIP', street: 'Street', state: 'State', name: 'Name', phone: 'Phone', urgency: 'Urgent', safety: 'Safety', trigger: 'Urgent situation', equipment: 'Equipment', day: 'Day', part: 'Time of day', existing: 'Existing customer' }

function Publish({ data, dirty, busy, post }) {
  const [ok, setOk] = useState(false)
  const [back, setBack] = useState(null)
  const canPublish = !dirty && data.saved && data.hasDraftChanges && !(data.errors || []).length
  const notes = data.status.provider.notes
  return (
    <Section id="ta-publish" title="5. Publish" label="Publish" className="ta-section">
      <details className="ta-compare-wrap">
        <summary>What your draft says, next to what’s published</summary>
        <div className="ta-compare">
          <div>
            <p className="ta-label">Your draft</p>
            <ul className="ta-describe">
              {data.describe.draft.map((l) => (
                <li key={l}>{l}</li>
              ))}
            </ul>
          </div>
          <div>
            <p className="ta-label">{data.liveVersion ? `Published (version ${data.liveVersion})` : 'Published'}</p>
            {data.describe.live ? (
              <ul className="ta-describe">
                {data.describe.live.map((l) => (
                  <li key={l}>{l}</li>
                ))}
              </ul>
            ) : (
              <p className="fine">Nothing published yet. Your receptionist works as it does today.</p>
            )}
          </div>
        </div>
      </details>
      {data.changesSinceLive.length > 0 && (
        <>
          <p className="ta-label">Changes that publishing would make</p>
          <ul className="ta-diff">
            {data.changesSinceLive.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
        </>
      )}
      <ul className="ta-notes">
        {notes.map((n) => (
          <li key={n}>{n}</li>
        ))}
      </ul>
      {dirty && <p className="ui-callout ui-callout--warn">Save your draft before publishing.</p>}
      {!dirty && data.saved && !data.hasDraftChanges && <p className="fine">Your draft matches what’s published.</p>}
      <label className="check">
        <input type="checkbox" checked={ok} onChange={(e) => setOk(e.target.checked)} disabled={!canPublish} />
        <span>I’ve tested these rules and want customers to get them.</span>
      </label>
      <div className="ui-form-actions">
        <button
          type="button"
          className="btn btn-primary btn-sm"
          disabled={!canPublish || !ok || Boolean(busy)}
          onClick={async () => {
            const live = data.status.rulesLive
            const r = await post({ action: 'publish', baseUpdatedAt: data.draftUpdatedAt, confirm: true }, live ? 'Published. Your receptionist uses these rules from the next conversation.' : 'Published. Customers aren’t affected yet: GetShowUps switches on live use for your business when your pilot starts.')
            if (r) setOk(false)
          }}
        >
          {busy === 'publish' ? 'Publishing…' : 'Publish'}
        </button>
        {data.liveVersion && data.hasDraftChanges && !dirty && (
          <button type="button" className="btn btn-quiet btn-sm" disabled={Boolean(busy)} onClick={() => post({ action: 'reset', baseUpdatedAt: data.draftUpdatedAt }, 'Your draft now matches the published rules.')}>
            Discard draft changes
          </button>
        )}
      </div>
      {data.versions.length > 0 && (
        <div className="ta-history">
          <p className="ta-label">History</p>
          <ol className="ta-versions">
            {data.versions.map((v) => (
              <li key={v.version}>
                <div>
                  <strong>Version {v.version}</strong> {v.version === data.liveVersion && <Pill tone="ok">Published</Pill>} <span className="fine">{whenFull(v.createdAt)}</span>
                  <p className="fine">{v.note}</p>
                </div>
                {v.version !== data.liveVersion &&
                  (back === v.version ? (
                    <div className="ta-confirm">
                      <span className="fine">Customers get version {v.version} again (saved as a new version). Your draft isn’t changed.</span>
                      <button type="button" className="btn btn-primary btn-sm" disabled={Boolean(busy)} onClick={async () => (await post({ action: 'rollback', version: v.version, liveVersion: data.liveVersion, confirm: true }, `Version ${v.version} is published again.`)) && setBack(null)}>
                        Go back
                      </button>
                      <button type="button" className="btn btn-quiet btn-sm" onClick={() => setBack(null)}>
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button type="button" className="link-btn" onClick={() => setBack(v.version)}>
                      Go back to this version
                    </button>
                  ))}
              </li>
            ))}
          </ol>
        </div>
      )}
    </Section>
  )
}
