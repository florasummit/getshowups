// The interactive product demonstration: Mode A (AI conversation, primary) and Mode B (booking page + owner
// dashboard, the existing Demo). One section, one switch; #demo and #simulation both land here.
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
    <section id="demo" className="section section--dark showcase" aria-labelledby="demo-heading">
      <span id="simulation" className="anchor-alias" aria-hidden="true" />
      <div className="container">
        <header className="section-heading section-heading--left">
          <p className="eyebrow">See it work</p>
          <h2 id="demo-heading">Watch a message become a booked job</h2>
          <p className="section-intro">Play the customer. The AI understands what they wrote, checks it against the business’s rules and area, asks only for what’s missing, and books a real open time — nothing more, nothing invented.</p>
        </header>
        <div className="mode" role="tablist" aria-label="Demonstration">
          <button type="button" role="tab" aria-selected={mode === 'conversation'} id="mode-conversation" aria-controls="mode-panel" onClick={() => pick('conversation')}>
            AI conversation
          </button>
          <button type="button" role="tab" aria-selected={mode === 'booking'} id="mode-booking" aria-controls="mode-panel" onClick={() => pick('booking')}>
            Booking page &amp; dashboard
          </button>
        </div>
        <div id="mode-panel" role="tabpanel" aria-labelledby={mode === 'conversation' ? 'mode-conversation' : 'mode-booking'}>
          {mode === 'conversation' ? <Conversation onSwitchMode={() => pick('booking')} /> : <Demo embedded />}
        </div>
      </div>
    </section>
  )
}
