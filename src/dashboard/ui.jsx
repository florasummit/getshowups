// Shared UI kit for the signed-in product (dashboard AND admin). The standard is docs/DESIGN_SYSTEM.md; hooks are in
// ./ui-hooks.js (useSaveState, usePageTitle) and text helpers in ../lib/format.js (plural, humanDate, money).
//   Pill          status, the ONE component for it (tones below)       PageHeader / Section   page and card structure
//   TabBar        the top-level navigation row (dashboard, admin)      LoadError              load failed + Retry
//   SaveBar       a form's save button + its confirmation / error      Loading / EmptyState   the two waiting states
//   SaveButton / SaveStatus   the same, placed separately (and for controls that save on change)
//   ConfirmInline a destructive action's question, in the page (never window.confirm)
// One way to show status everywhere:
//   ok      green  confirmed working / done        warn  amber  needs review, pending, test mode
//   bad     red    failed / broken / urgent        info  blue   informational
//   neutral gray   off, not connected, completed, not available
// Status is always text + shape, never color alone.
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { timeAgo, whenFull } from '../lib/api.js'

export function Pill({ tone = 'neutral', children, dot = true }) {
  return (
    <span className={`ui-pill ui-pill--${tone}`}>
      {dot && <span className="ui-pill-dot" aria-hidden="true" />}
      {children}
    </span>
  )
}

export function PageHeader({ title, status, actions, children }) {
  return (
    <header className="ui-page-head">
      <div className="ui-page-head-main">
        <h1 className="ui-page-title">{title}</h1>
        {status}
      </div>
      {actions && <div className="ui-page-head-actions">{actions}</div>}
      {children && <p className="ui-page-sub">{children}</p>}
    </header>
  )
}

export function Section({ title, label, action, children, className = '', id }) {
  return (
    <section id={id} className={`ui-section ${className}`} aria-label={label || title}>
      {(title || action) && (
        <div className="ui-section-head">
          {title && <h2 className="ui-section-title">{title}</h2>}
          {action}
        </div>
      )}
      {children}
    </section>
  )
}

// Something couldn't be loaded: say what, offer the retry. Never an empty form (saving one would replace what's stored).
export function LoadError({ what, onRetry }) {
  return (
    <p className="form-error" role="alert" data-load-error>
      Couldn’t load {what}.{' '}
      <button type="button" className="link-btn" onClick={onRetry}>
        Retry
      </button>
    </p>
  )
}

export function Ago({ t }) {
  return (
    <time dateTime={new Date(t).toISOString()} title={whenFull(t)}>
      {timeAgo(t)}
    </time>
  )
}

// ---------- navigation ----------
// The top-level tab row. tabs = [[id, label, href]]. Same markup as before (nav.tabs > a[aria-current=page]); on a
// narrow screen the row scrolls sideways inside itself: the current tab is brought into view, the cut-off edge fades
// and shows an arrow that scrolls the row (pointer convenience only; keyboard and screen readers use the links).
export function TabBar({ label, tabs, current, onGo }) {
  const nav = useRef(null)
  const [more, setMore] = useState({ start: false, end: false })
  useLayoutEffect(() => {
    const el = nav.current
    if (!el) return undefined
    const measure = () => {
      const start = el.scrollLeft > 4
      const end = el.scrollLeft + el.clientWidth < el.scrollWidth - 4
      setMore((m) => (m.start === start && m.end === end ? m : { start, end }))
    }
    measure()
    el.addEventListener('scroll', measure, { passive: true })
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null
    ro?.observe(el)
    return () => {
      el.removeEventListener('scroll', measure)
      ro?.disconnect()
    }
  }, [tabs.length])
  // Keep the current tab inside the row (centred when the row scrolls). Only the row moves, never the page.
  useLayoutEffect(() => {
    const el = nav.current
    const link = el?.querySelector('[aria-current="page"]')
    if (!link || el.scrollWidth <= el.clientWidth) return
    const row = el.getBoundingClientRect()
    const box = link.getBoundingClientRect()
    el.scrollLeft += box.left - row.left - (row.width - box.width) / 2
  }, [current, tabs.length])
  const nudge = (dir) => {
    const calm = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    nav.current?.scrollBy({ left: dir * nav.current.clientWidth * 0.6, behavior: calm ? 'auto' : 'smooth' })
  }
  return (
    <div className="tabs-wrap" data-more-start={more.start || undefined} data-more-end={more.end || undefined}>
      <nav className="tabs" aria-label={label} ref={nav}>
        {tabs.map(([id, text, href]) => (
          <a
            key={id}
            href={href}
            aria-current={current === id ? 'page' : undefined}
            onClick={(e) => {
              if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button) return // new tab / window: the browser's job
              e.preventDefault()
              onGo(id, href)
            }}
          >
            {text}
          </a>
        ))}
      </nav>
      <button type="button" className="tabs-more tabs-more--start" tabIndex={-1} aria-hidden="true" onClick={() => nudge(-1)}>
        ‹
      </button>
      <button type="button" className="tabs-more tabs-more--end" tabIndex={-1} aria-hidden="true" onClick={() => nudge(1)}>
        ›
      </button>
    </div>
  )
}

// ---------- saving ----------
// `save` is a useSaveState() value (./ui-hooks.js). The button reads "Saving…" while the request is out and is always
// enabled again when it settles. Default type is submit (inside a <form onSubmit>); pass type="button" + onClick otherwise.
export function SaveButton({ save, children = 'Save', className = 'btn btn-primary', type = 'submit', disabled = false, ...rest }) {
  return (
    <button type={type} className={className} disabled={save.pending || disabled} data-save={save.status} {...rest}>
      {save.pending ? 'Saving…' : children}
    </button>
  )
}

// What the last save did: "Saved." (role=status, goes away by itself) or the error (role=alert, stays until the next
// try). Put it right next to the control that saved, so the confirmation is where the person is looking.
export function SaveStatus({ save }) {
  if (save.status === 'saved') {
    return (
      <p className="ui-save-status" role="status">
        {save.message}
      </p>
    )
  }
  if (save.status === 'error') {
    return (
      <p className="form-error ui-save-error" role="alert">
        {save.message}
      </p>
    )
  }
  return null
}

// A form's last row: the error (if any) above, then the save button with its confirmation beside it.
// `block` = the full-width large button of a single-purpose step (onboarding); `extra` = secondary actions (Cancel…).
export function SaveBar({ save, children = 'Save', block = false, disabled = false, extra = null }) {
  return (
    <div className={`ui-save${block ? ' ui-save--block' : ''}`}>
      <SaveButton save={save} className={block ? 'btn btn-primary btn-lg btn-block' : 'btn btn-primary'} disabled={disabled}>
        {children}
      </SaveButton>
      {extra}
      <SaveStatus save={save} />
    </div>
  )
}

// ---------- confirming ----------
// A destructive or hard-to-undo action asks here, in the page, in place of the button that started it (never
// window.confirm). Say what happens in `question` ("Remove this photo?"), name the action on the button ("Remove"),
// add `detail` for the consequence. Focus goes to Cancel (the safe choice); Escape cancels.
export function ConfirmInline({ question, detail, confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = true, busy = false, onConfirm, onCancel }) {
  const cancel = useRef(null)
  useEffect(() => cancel.current?.focus(), [])
  return (
    <div
      className="ui-confirm"
      role="group"
      aria-label={question}
      data-confirm
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !busy) {
          e.stopPropagation()
          onCancel()
        }
      }}
    >
      <p className="ui-confirm-q">{question}</p>
      {detail && <p className="ui-hint">{detail}</p>}
      <div className="ui-confirm-actions">
        <button type="button" className={`btn btn-sm ${danger ? 'btn-danger' : 'btn-primary'}`} disabled={busy} onClick={onConfirm}>
          {busy ? 'Working…' : confirmLabel}
        </button>
        <button type="button" className="btn btn-sm btn-quiet" disabled={busy} onClick={onCancel} ref={cancel}>
          {cancelLabel}
        </button>
      </div>
    </div>
  )
}

// ---------- waiting states ----------
// Loading: a quiet placeholder, announced to screen readers; `what` completes "Loading …" ("your services").
export function Loading({ what = '' }) {
  return (
    <div className="ui-loading" aria-busy="true">
      <span className="sr-only">Loading{what ? ` ${what}` : ''}…</span>
      <span className="ui-skeleton-block" aria-hidden="true" />
    </div>
  )
}

// Empty: say what will appear here and, when there is one, offer the action that fills it (`action` = a button/link).
export function EmptyState({ title, children, action = null }) {
  return (
    <div className="ui-empty-state" data-empty>
      {title && <p className="ui-empty-title">{title}</p>}
      {children && <p className="ui-hint">{children}</p>}
      {action}
    </div>
  )
}
