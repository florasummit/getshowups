import { useState } from 'react'
import { integrations } from '../content/site.js'

// "Works with": a quiet moving strip of plain-text names (never logos), only what customers can use in production today
// (content/site.js). The second copy exists only for the seamless loop and is hidden from assistive technology. It can
// be paused, stops on hover, and is a still list when reduced motion is asked for.
export default function WorksWith() {
  const [paused, setPaused] = useState(false)
  const names = integrations.names.map((n) => <li key={n}>{n}</li>)
  return (
    <section className="ww" aria-labelledby="ww-title" data-works-with={paused ? 'paused' : 'moving'}>
      <div className="container">
        <div className="ww-head">
          <h2 id="ww-title" className="ww-title">
            {integrations.title}
          </h2>
          <button type="button" className="ww-pause" aria-pressed={paused} onClick={() => setPaused(!paused)}>
            {paused ? 'Play' : 'Pause'}
            <span className="ww-sr"> moving list</span>
          </button>
        </div>
        <div className="ww-window">
          <div className="ww-track">
            <ul className="ww-group">{names}</ul>
            <ul className="ww-group ww-copy" aria-hidden="true">
              {names}
            </ul>
          </div>
        </div>
        <p className="ww-note">{integrations.note}</p>
      </div>
    </section>
  )
}
