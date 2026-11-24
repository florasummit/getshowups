// Help next to a setting or number: <HelpTip id> opens ONE panel (side panel on wide screens, bottom sheet on phones)
// with curated text from content/help.js. No request is made. Keyboard: the panel takes focus, Escape closes it and focus
// returns to the button. Mounted once per dashboard (HelpPanel); never put a HelpTip inside a <label>.
import { useEffect, useRef, useState } from 'react'
import { HELP } from '../content/help.js'

const KIND = { measured: 'Measured from your records', estimated: 'Includes estimates' }

export function HelpTip({ id }) {
  const t = HELP[id]
  if (!t) return null
  return (
    <button type="button" className="help-tip" aria-label={`Help: ${t.title}`} aria-haspopup="dialog" data-help={id} onClick={(e) => window.dispatchEvent(new CustomEvent('gsu:help', { detail: { id, from: e.currentTarget } }))}>
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

export function HelpPanel() {
  const [open, setOpen] = useState(null) // { id, from }
  const panel = useRef(null)
  useEffect(() => {
    const on = (e) => setOpen(e.detail)
    window.addEventListener('gsu:help', on)
    return () => window.removeEventListener('gsu:help', on)
  }, [])
  useEffect(() => {
    if (!open) return
    panel.current?.focus()
    const key = (e) => {
      if (e.key !== 'Escape') return
      setOpen(null)
      open.from?.focus()
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [open])
  if (!open) return null
  const t = HELP[open.id]
  const close = () => {
    setOpen(null)
    open.from?.focus()
  }
  return (
    <aside className="help-panel" role="dialog" aria-labelledby="help-title" tabIndex={-1} ref={panel} data-help-panel={open.id}>
      <div className="help-head">
        <h2 id="help-title">{t.title}</h2>
        <button type="button" className="btn btn-sm btn-quiet" onClick={close}>
          Close
        </button>
      </div>
      {t.kind && <p className="help-kind">{KIND[t.kind]}</p>}
      <p>{t.what}</p>
      <dl className="help-parts">
        {[
          ['Why it matters', t.why],
          ['Example', t.example],
          ['Next step', t.next],
        ].map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
    </aside>
  )
}
