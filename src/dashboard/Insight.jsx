// One quiet suggestion per page (server/insights.js: deterministic, no model). Loaded when the dashboard opens and, when a
// page is opened more than five minutes later, again; never on a timer. Overview shows the most important one; a page shows
// its own. One that was already shown on another page isn't repeated. Nothing to say → nothing shown.
import { useEffect, useState } from 'react'
import { api } from '../lib/api.js'
import { openAssistant } from './assistant-store.js'

const shownOn = new Map()
// `covered`: what the page already says in its own words.
export default function Insight({ view, list, drop, go, covered = [] }) {
  const [busy, setBusy] = useState(false)
  const it = list.find((x) => (view === 'overview' || x.home === view) && !covered.includes(x.id) && (!shownOn.has(x.id) || shownOn.get(x.id) === view))
  const id = it?.id
  useEffect(() => {
    if (id) shownOn.set(id, view)
  }, [id, view])
  if (!it) return null
  const hide = async (kind) => {
    setBusy(true)
    const { status } = await api('/api/dashboard/insights', { method: 'POST', body: { id: it.id, kind } })
    setBusy(false)
    if (status === 200 || status === 400) drop(it.id)
  }
  const [label, where] = it.action || []
  const ask = () => openAssistant({ topic: it.topic || undefined, ask: it.ask })
  return (
    <section className="insight" aria-label="Suggestion" data-insight={it.id}>
      <div className="insight-main">
        <p className="insight-title">{it.title}</p>
        <details className="insight-why">
          <summary>Why am I seeing this?</summary>
          <ul className="ask-list">
            {it.evidence.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
        </details>
      </div>
      <div className="insight-actions">
        {label && (where === 'assist' || where !== view) && (
          <button type="button" className="btn btn-sm btn-quiet" onClick={() => (where === 'assist' ? ask() : go(where))}>
            {label}
          </button>
        )}
        {where !== 'assist' && (
          <button type="button" className="link-btn" onClick={ask}>
            Ask about this
          </button>
        )}
        <button type="button" className="link-btn" disabled={busy} onClick={() => hide('snooze')}>
          Not now
        </button>
        <button type="button" className="link-btn" disabled={busy} onClick={() => hide('dismiss')}>
          Dismiss
        </button>
      </div>
    </section>
  )
}
