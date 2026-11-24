// Shared dashboard building blocks. One way to show status everywhere:
//   ok      green  confirmed working / done        warn  amber  needs review, pending, test mode
//   bad     red    failed / broken / urgent        info  blue   informational
//   neutral gray   off, not connected, completed, not available
// Status is always text + shape, never color alone.
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
