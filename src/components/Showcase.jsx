// The product stage: Mode A (AI conversation, primary) and Mode B (booking page + owner dashboard, the existing Demo)
// on one charcoal surface that rises into the first viewport under the hero. #demo and #simulation both land here.
// The section itself is light (a sky-to-lavender wash cut at an angle), so the dark stage floats on colour instead
// of sitting in a black band; the header stays light over it.
import { useState } from 'react'
import Conversation from './Conversation.jsx'
import Demo from './Demo.jsx'
import { track } from '../lib/analytics.js'

export default function Showcase() {
  const [mode, setMode] = useState('conversation')
  const pick = (m) => {
    if (m !== mode) track('demo_mode', { mode: m })
    setMode(m)
  }
  return (
    <section id="demo" className="section showcase" aria-labelledby="demo-heading">
      <span id="simulation" className="anchor-alias" aria-hidden="true" />
      <div className="container">
        <h2 id="demo-heading" className="visually-hidden">
          See it work
        </h2>
        <div className="stage">
          <div className="stage-bar">
            <div className="mode" role="tablist" aria-label="Demonstration">
              <button type="button" role="tab" aria-selected={mode === 'conversation'} id="mode-conversation" aria-controls="mode-panel" onClick={() => pick('conversation')}>
                AI conversation
              </button>
              <button type="button" role="tab" aria-selected={mode === 'booking'} id="mode-booking" aria-controls="mode-panel" onClick={() => pick('booking')}>
                Booking page &amp; dashboard
              </button>
            </div>
            <p className="stage-sim" role="note">
              <span className="cv-sim-dot" aria-hidden="true" />
              Simulation · nothing is sent, booked or stored
            </p>
          </div>
          <div id="mode-panel" role="tabpanel" aria-labelledby={mode === 'conversation' ? 'mode-conversation' : 'mode-booking'}>
            {mode === 'conversation' ? <Conversation onSwitchMode={() => pick('booking')} /> : <Demo embedded />}
          </div>
        </div>
      </div>
    </section>
  )
}
