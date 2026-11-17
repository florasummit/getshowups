// "Your website, step by step": import → review/edit/preview → publish → connect domain → check it's live, derived only
// from real state (src/dashboard/journey.js). One obvious next action; every step links to the section that does the
// work. Nothing here changes anything by itself.
import { useEffect, useState } from 'react'
import { api } from '../lib/api.js'
import { journeySteps } from './journey.js'
import { Pill } from './ui.jsx'

const go = (id) => {
  const el = document.getElementById(id)
  if (!el) return
  // Open any collapsed section it sits in.
  for (let p = el.closest('details'); p; p = p.parentElement?.closest('details')) p.open = true
  el.scrollIntoView({ behavior: 'smooth', block: 'start' })
  el.querySelector('input, textarea, button, summary, a')?.focus({ preventScroll: true })
}

export default function WebsiteJourney({ data, onPublish, canPublish = true }) {
  const [imp, setImp] = useState(null)
  // Re-read whenever the draft changes (e.g. right after an import is applied), so step 1 is never stale.
  const updatedAt = data.website?.updatedAt ?? null
  useEffect(() => {
    if (!data.studio) return
    api('/api/dashboard/website/import').then(({ status, data: d }) => status === 200 && setImp(d.import))
  }, [data.studio, updatedAt])
  const steps = journeySteps(data, imp, { canPublish })
  const current = steps.findIndex((s) => !s.done)
  const run = ([, target]) => (target === 'publish' ? onPublish() : /^https?:/.test(target) ? window.open(target, '_blank', 'noopener') : go(target))
  return (
    <section className="ui-section wj" aria-label="Your website, step by step">
      <div className="ui-section-head">
        <h2 className="ui-section-title">Your website, step by step</h2>
        <span className="fine">
          {steps.filter((s) => s.done).length} of {steps.length} done
        </span>
      </div>
      <ol className="wj-steps">
        {steps.map((s, i) => {
          const isCurrent = i === current
          return (
            <li key={s.id} className={`wj-step${s.done ? ' is-done' : ''}${isCurrent ? ' is-current' : ''}`} aria-current={isCurrent ? 'step' : undefined}>
              <span className="wj-mark" aria-hidden="true">
                {s.done ? '✓' : i + 1}
              </span>
              <div className="wj-body">
                <p className="wj-title">
                  {s.title} <Pill tone={s.pill[0]}>{s.pill[1]}</Pill>
                  {s.recommend && <Pill tone="warn">Recommended before switching</Pill>}
                </p>
                <p className="wj-detail">{s.detail}</p>
                {(s.action || s.preview) && (
                  <div className="wj-actions">
                    {s.action && (
                      <button type="button" className={`btn btn-sm ${isCurrent ? 'btn-primary' : 'btn-quiet'}`} onClick={() => run(s.action)}>
                        {s.action[0]}
                      </button>
                    )}
                    {s.preview && (
                      <a className="btn btn-sm btn-quiet" href="/api/dashboard/website/preview" target="_blank" rel="noreferrer">
                        Preview
                      </a>
                    )}
                  </div>
                )}
              </div>
            </li>
          )
        })}
      </ol>
    </section>
  )
}
