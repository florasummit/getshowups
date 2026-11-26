// The Website tab before a business has a website: ONE decision with two answers (finding WEB-05). "Create my website"
// writes it from what GetShowUps already knows and offers three designs; "I have a website" brings the current one over.
// Both end in the same editor (finding WEB-01): the chosen design is saved as the multi-page website the editor,
// History and publishing use. Nothing else is asked here (no address, hosting or AI-account choices before a draft
// exists) and nothing goes live from here.
import { useState } from 'react'
import { api } from '../lib/api.js'
import WebsiteGenerator from './WebsiteGenerator.jsx'

export default function WebsiteStart({ data, onImport, onCreated, onUsage }) {
  const [state, setState] = useState({})
  const [trigger, setTrigger] = useState(0)
  const [designing, setDesigning] = useState(false)
  // The website built from the records alone (no AI): offered when designs can't be made right now.
  const fresh = async () => {
    setState({ busy: true })
    const { status, data: d } = await api('/api/dashboard/website', { method: 'POST', body: { action: 'starter' } })
    if (status === 200) {
      setState({})
      onCreated(d)
    } else setState({ error: d?.error === 'designed_site' ? 'You already have a website draft. Reload the page to edit it.' : 'Couldn’t create your website. Please try again.' })
  }
  const busy = designing || state.busy
  return (
    <section className="ui-section ws-start" aria-label="How would you like to start?">
      <h2 className="ui-section-title">How would you like to start?</h2>
      <div className="ws-start-grid">
        <button type="button" className="ws-start-card" onClick={() => setTrigger((n) => n + 1)} disabled={busy} aria-busy={busy || undefined}>
          <strong>{busy ? 'Creating your website…' : 'Create my website'}</strong>
          <span>We write it from your business details (services, prices, area and contact) and show you three looks to choose from. Then you edit anything you like.</span>
        </button>
        <button type="button" className="ws-start-card" onClick={onImport} disabled={busy}>
          <strong>I have a website</strong>
          <span>Enter its address. We read its pages, services, photos and policies, and you choose what to bring over. Old page addresses keep working.</span>
        </button>
      </div>
      <WebsiteGenerator bare studio trigger={trigger} onBusy={setDesigning} storeKey={data.url} usage={data.aiUsage} onUsage={onUsage} ownKey={data.aiKey?.status === 'ok' ? data.aiKey.provider : null} onApplied={onCreated} onFallback={fresh} />
      {state.error && (
        <p className="form-error" role="alert">
          {state.error}
        </p>
      )}
      <p className="fine">Either way it stays a private draft until you publish.</p>
    </section>
  )
}
