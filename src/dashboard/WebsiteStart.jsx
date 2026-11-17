// Website Studio's two front doors, shown only before a business has a website: bring the one it has, or start
// fresh from what GetShowUps already knows (no retyping). Nothing goes live from here.
import { useState } from 'react'
import { api } from '../lib/api.js'

export default function WebsiteStart({ onImport, onCreated }) {
  const [state, setState] = useState({})
  const fresh = async () => {
    setState({ busy: true })
    const { status, data } = await api('/api/dashboard/website', { method: 'POST', body: { action: 'starter' } })
    if (status === 200) {
      setState({})
      onCreated(data)
    } else setState({ error: data?.error === 'designed_site' ? 'You already have a website draft. Edit it below.' : 'Couldn’t create your website. Please try again.' })
  }
  return (
    <section className="ui-section ws-start" aria-label="How would you like to start?">
      <h2 className="ui-section-title">How would you like to start?</h2>
      <div className="ws-start-grid">
        <button type="button" className="ws-start-card" onClick={onImport}>
          <strong>I have a website</strong>
          <span>Enter its address. We read its pages, services, photos and policies, and you choose what to bring over. Old page addresses keep working.</span>
        </button>
        <button type="button" className="ws-start-card" onClick={fresh} disabled={state.busy} aria-busy={state.busy || undefined}>
          <strong>{state.busy ? 'Creating your website…' : 'I’m starting fresh'}</strong>
          <span>We build your pages from your business details: services, prices, area and contact. Then you edit anything you like.</span>
        </button>
      </div>
      {state.error && (
        <p className="form-error" role="alert">
          {state.error}
        </p>
      )}
      <p className="fine">Either way it stays a private draft until you publish.</p>
    </section>
  )
}
