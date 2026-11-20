// Control Center building blocks: URL state (every screen is a link, so Back/Forward and deep links work), and the
// small presentational components every view shares. No data fetching here.
import { useEffect, useRef } from 'react'
import { hrefFor, takeFocus } from './lib.js'

// A real link (middle-click / open in new tab work) that navigates in place on a normal click.
export function Link({ to, go, children, className, ...rest }) {
  const href = typeof to === 'string' ? to : hrefFor(to)
  return (
    <a
      href={href}
      className={className}
      onClick={(e) => {
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
        e.preventDefault()
        go(href)
      }}
      {...rest}
    >
      {children}
    </a>
  )
}

export function Badge({ tone = 'neutral', plain = false, children, ...rest }) {
  return (
    <span className={`cc-badge cc-badge--${tone}${plain ? ' cc-badge--plain' : ''}`} {...rest}>
      {children}
    </span>
  )
}
const SEV = { critical: ['bad', 'Critical'], high: ['bad', 'High'], medium: ['warn', 'Medium'], low: ['info', 'Low'] }
export const Severity = ({ s }) => <Badge tone={SEV[s]?.[0] || 'neutral'}>{SEV[s]?.[1] || s}</Badge>
export const TestTag = () => (
  <Badge tone="neutral" plain>
    Test account
  </Badge>
)

export function PageHead({ crumbs = [], go, title, lede, children }) {
  const ref = useRef(null)
  useEffect(() => {
    if (takeFocus()) ref.current?.focus({ preventScroll: true })
  }, [])
  return (
    <header className="cc-head">
      {crumbs.length > 0 && (
        <nav className="cc-crumbs" aria-label="Breadcrumb">
          {crumbs.map(([label, to], k) => (
            <span key={k}>
              {k > 0 && <span aria-hidden="true">/ </span>}
              <Link to={to} go={go}>
                {label}
              </Link>
            </span>
          ))}
        </nav>
      )}
      <div className="cc-head-row">
        <h1 className="cc-title" tabIndex={-1} data-cc-heading ref={ref}>
          {title}
        </h1>
        {children}
      </div>
      {lede && <p className="cc-lede">{lede}</p>}
    </header>
  )
}

export function Section({ title, sub, action, children, id, ...rest }) {
  const hid = id ? `${id}-h` : undefined
  return (
    <section className="cc-section" aria-labelledby={hid} {...rest}>
      <div className="cc-section-head">
        <h2 id={hid}>{title}</h2>
        {action}
        {sub && <p>{sub}</p>}
      </div>
      {children}
    </section>
  )
}

export function Empty({ title, children, ...rest }) {
  return (
    <div className="cc-empty" {...rest}>
      <strong>{title}</strong>
      {children && <span>{children}</span>}
    </div>
  )
}

export function Facts({ items }) {
  return (
    <dl className="cc-facts">
      {items.filter(Boolean).map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  )
}

export function Loading({ label = 'Loading…' }) {
  return (
    <p className="cc-status-line" aria-busy="true">
      {label}
    </p>
  )
}
export function LoadError({ what, onRetry }) {
  return (
    <div className="cc-callout cc-callout--warn" role="alert">
      <strong>Couldn’t load {what}.</strong>
      <span>This is a read error, not a change to any account. Check your connection and try again.</span>
      {onRetry && (
        <div>
          <button type="button" className="btn btn-quiet btn-sm" onClick={onRetry}>
            Try again
          </button>
        </div>
      )}
    </div>
  )
}
