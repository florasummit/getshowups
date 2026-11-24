// The assistant and the explanations beside numbers and settings. ONE panel (docked beside the page on wide screens, bottom sheet
// below that): a metric is its own button (useMetric: the whole card or row is highlighted while it is explained), a
// setting has a small HelpTip. Text is curated (content/help.js); opening makes no request (AskAbout.jsx: only when the
// owner asks). Keyboard: the panel takes focus, Escape or Close closes it and focus returns to what opened it.
// Mounted once per dashboard (HelpPanel); never put a HelpTip inside a <label>.
import { useEffect, useId, useRef } from 'react'
import Assistant from './AskAbout.jsx'
import Icon from '../components/Icon.jsx'
import { HELP } from '../content/help.js'
import { close, getOpen, openAssistant, set, talking, useOpen, useView } from './assistant-store.js'

const KIND = { measured: 'Measured from your records', reported: 'Reported by Google', recorded: 'Recorded by you', estimated: 'Includes estimates' }
const PANEL_ID = 'help-panel'

// Shared by tips and metrics: toggles the panel, keeps the shown value current, closes when its owner leaves the page.
function useTopic(info) {
  const key = useId()
  const ref = useRef(null)
  const selected = useOpen()?.key === key
  const json = JSON.stringify(info)
  useEffect(() => {
    if (getOpen()?.key === key) set({ key, from: getOpen().from, ...JSON.parse(json) })
  }, [key, json])
  useEffect(
    () => () => {
      // Its page went away: a conversation stays open without the selection, otherwise the panel closes.
      if (getOpen()?.key === key) set(talking() ? { key: 'global', quiet: true, from: null } : null)
    },
    [key],
  )
  const toggle = () => (selected ? close() : set({ key, from: ref.current, ...info }))
  return { selected, toggle, button: { ref, type: 'button', 'aria-expanded': selected, 'aria-controls': selected ? PANEL_ID : undefined, 'data-help': info.topic, onClick: toggle } }
}

export function AssistantButton() {
  const on = useOpen()?.key === 'global'
  return (
    <button type="button" className="assist-btn" aria-expanded={on} aria-controls={on ? PANEL_ID : undefined} aria-label="Assistant" onClick={() => (on ? close() : openAssistant())} data-assistant>
      <Icon name="sparkles" size={17} />
      <span>Assistant</span>
    </button>
  )
}

export function HelpTip({ id }) {
  const { button } = useTopic({ topic: id })
  return (
    <button className="help-tip" aria-label={`Help: ${HELP[id].title}`} {...button}>
      ?
    </button>
  )
}

// A card heading with its help beside it (beside, not inside: the heading's name stays the heading).
export function TitleHelp({ help, children, ...h }) {
  return (
    <div className="title-help">
      <h2 className="card-title" {...h}>
        {children}
      </h2>
      <HelpTip id={help} />
    </div>
  )
}

export const MetricHint = () => <p className="fine metric-hint">Select a number to see what it means.</p>

const Sub = ({ children }) => (children ? <span className="metric-sub">{children}</span> : null)

// A figure card that is one button. `hint` = a few plain words under the label.
export function MetricCard({ topic, label, value, hint, kind, missing, note, className = 'stat', days, loading, valueClass = 'stat-value', labelClass = 'stat-label' }) {
  const { selected, button } = useTopic({ topic, label, value: String(value), kind, missing: value === '—' ? missing || 'Not available yet.' : undefined, note, days, loading })
  return (
    <button {...button} className={`${className} metric${selected ? ' is-selected' : ''}`} data-metric={topic}>
      <span className={valueClass}>{value}</span>
      <span className={labelClass}>
        <span>{label}</span>
        <Sub>{hint}</Sub>
      </span>
    </button>
  )
}

// A table row that is selected as a whole: its label is the button (keyboard, screen readers), a press anywhere on the
// row does the same (text being selected for copying is left alone).
export function MetricRow({ topic, label, cells, ...info }) {
  const { selected, toggle, button } = useTopic({ topic, label, ...info })
  const press = (e) => {
    if (e.target.closest('button') || String(window.getSelection())) return
    toggle()
  }
  return (
    <tr className={`metric-row${selected ? ' is-selected' : ''}`} onClick={press} data-metric={topic}>
      <th scope="row">
        <button {...button} className="metric-row-btn">
          {label}
        </button>
      </th>
      {cells}
    </tr>
  )
}

// Keeps the selected metric in view: clear of the sheet on small screens, and level with the panel's marker when docked.
function usePlacement(cur) {
  useEffect(() => {
    const root = document.documentElement
    root.classList.toggle('help-open', !!cur)
    if (!cur) return
    const target = cur.key === 'global' ? null : cur.from?.closest('.metric, .metric-row, .title-help') || cur.from
    const el = document.getElementById(PANEL_ID)
    const place = () => {
      const vv = window.visualViewport
      el.style.setProperty('--kb', `${vv ? Math.max(0, window.innerHeight - vv.height - vv.offsetTop) : 0}px`)
      root.style.setProperty('--help-h', `${el.offsetHeight}px`)
      const r = target?.getBoundingClientRect()
      const y = r ? r.top + r.height / 2 : -1
      el.style.setProperty('--link-y', `${y}px`)
      el.dataset.linked = String(!!cur.label && y > 24 && y < window.innerHeight - 24)
    }
    const reveal = () => {
      place()
      const r = target?.getBoundingClientRect()
      const sheet = getComputedStyle(el).getPropertyValue('--sheet').trim() === '1'
      const bottom = sheet ? window.innerHeight - el.offsetHeight - 16 : window.innerHeight - 16
      // Lowest first: the metric's bottom edge clears the sheet unless that would push its top off the screen.
      const by = !r ? 0 : r.bottom > bottom ? Math.min(r.bottom - bottom, r.top - 16) : r.top < 16 ? r.top - 16 : 0
      if (by) window.scrollBy({ top: by, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
    }
    reveal()
    window.addEventListener('scroll', place, { passive: true })
    window.addEventListener('resize', place)
    window.visualViewport?.addEventListener('resize', place)
    const watch = new ResizeObserver(place)
    watch.observe(document.body)
    const grown = new ResizeObserver(reveal) // an answer makes the sheet taller
    grown.observe(el)
    return () => {
      window.removeEventListener('scroll', place)
      window.removeEventListener('resize', place)
      window.visualViewport?.removeEventListener('resize', place)
      watch.disconnect()
      grown.disconnect()
      root.classList.remove('help-open')
    }
  }, [cur?.key, cur?.from, cur?.label, cur?.days, cur?.loading]) // eslint-disable-line react-hooks/exhaustive-deps
}

export function HelpPanel() {
  const cur = useOpen()
  const panel = useRef(null)
  const key = cur?.key
  usePlacement(cur)
  useEffect(() => {
    if (!key) return
    if (!getOpen()?.quiet) panel.current?.focus({ preventScroll: true })
    const onKey = (e) => e.key === 'Escape' && !e.defaultPrevented && close()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [key])
  const at = useView()
  if (!cur) return null
  const t = cur.topic ? HELP[cur.topic] : null
  const kind = cur.kind || t?.kind
  return (
    <aside className="help-panel" id={PANEL_ID} role="dialog" aria-labelledby="help-title" tabIndex={-1} ref={panel} data-help-panel={cur.topic || 'assistant'}>
      <div className="help-scroll">
        <div className="help-head">
          <h2 id="help-title">{cur.label || t?.title || 'Assistant'}</h2>
          <button type="button" className="help-close" aria-label="Close" onClick={close}>
            <Icon name="close" size={18} />
          </button>
        </div>
        {t && (
          <div className="help-topic" key={key}>
            {cur.value !== undefined ? (
              <div className="help-fact" data-missing={cur.missing ? '' : undefined}>
                <p className="help-value">
                  <strong>{cur.missing ? 'Not available yet' : cur.value}</strong>
                  {cur.sub && !cur.missing && <span>{cur.sub}</span>}
                </p>
                <p className="help-kind">{cur.loading ? 'Updating…' : [cur.missing || KIND[kind], cur.days && `Last ${cur.days} days`].filter(Boolean).join(' · ')}</p>
                {cur.note && <p className="help-kind">{cur.note}</p>}
              </div>
            ) : (
              kind && <p className="help-kind">{KIND[kind]}</p>
            )}
            <p className="help-what">{t.what}</p>
            <dl className="help-parts">
              <div>
                <dt>Why it matters</dt>
                <dd>{t.why}</dd>
              </div>
              <div className="help-next">
                <dt>Next step</dt>
                <dd>{t.next}</dd>
              </div>
            </dl>
            <details className="help-example">
              <summary>See an example</summary>
              <p>
                <span className="help-tag">Example, not your numbers</span> {t.example}
              </p>
            </details>
          </div>
        )}
        <Assistant topic={cur.topic} title={cur.label || t?.title} missing={!!cur.missing} days={cur.days} loading={!!cur.loading} view={at} first={cur.ask} onSent={cur.ask ? () => set({ ...getOpen(), ask: undefined }) : undefined} />
      </div>
    </aside>
  )
}
