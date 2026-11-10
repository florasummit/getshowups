// Website address: the GetShowUps address (default, nothing to do), your own domain (guided), or
// buying a new one (you own it; we point you to a registrar). Plain language; DNS details appear only
// for the one record the owner must add, with copy buttons.
import { useEffect, useState } from 'react'
import { api } from '../lib/api.js'

const STATUS = {
  pending: ['Waiting for your record', 'pending'],
  verifying: ['Verifying', 'pending'],
  securing: ['Securing your website', 'pending'],
  connected: ['Connected', 'ok'],
  needs_attention: ['Needs attention', 'bad'],
}
const ERRORS = {
  invalid_domain: 'That doesn’t look like a domain. Try something like www.yourbusiness.com.',
  reserved_domain: 'That address can’t be used.',
  domain_in_use: 'That domain is already connected to another website on GetShowUps. If it’s yours, contact us.',
  already_has_domain: 'Disconnect your current domain first.',
  rate_limited: 'Too many tries. Please wait a few minutes.',
}

function Copy({ value }) {
  const [done, setDone] = useState(false)
  return (
    <button
      type="button"
      className="link-btn"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value)
          setDone(true)
          setTimeout(() => setDone(false), 1500)
        } catch {
          window.prompt('Copy this', value)
        }
      }}
    >
      {done ? 'Copied' : 'Copy'}
    </button>
  )
}

function Record({ r }) {
  // Most DNS providers want only the part before your domain in the "Name" / "Host" field.
  return (
    <dl className="record">
      <div>
        <dt>Type</dt>
        <dd>{r.type}</dd>
      </div>
      <div>
        <dt>Name / Host</dt>
        <dd>
          <code>{r.name}</code> <Copy value={r.name} />
        </dd>
      </div>
      <div>
        <dt>Value / Points to</dt>
        <dd>
          <code>{r.value}</code> <Copy value={r.value} />
        </dd>
      </div>
    </dl>
  )
}

function Steps({ d }) {
  if (d.status === 'connected') {
    return (
      <p>
        Your website is live at{' '}
        <a href={d.url} target="_blank" rel="noreferrer">
          {d.hostname}
        </a>
        .
      </p>
    )
  }
  if (d.step === 'verify') {
    return (
      <>
        <p>
          <strong>Step 1 of 2: verify you own {d.hostname}.</strong> Sign in where you bought your domain (for example GoDaddy, Namecheap or Squarespace), open its DNS settings and add this record. It doesn’t change your current website or email.
        </p>
        {d.records.map((r) => (
          <Record key={r.type} r={r} />
        ))}
        <p className="fine">Changes can take a few minutes to an hour to show up. We check automatically.</p>
      </>
    )
  }
  if (d.step === 'activate') {
    return <p>Ownership verified. We’re preparing hosting for {d.hostname}. We’ll show the last step here as soon as it’s ready, usually within a day.</p>
  }
  return (
    <>
      <p>
        <strong>Step 2 of 2: point {d.hostname} to your new website.</strong> Add (or change) this record. Once it’s in place, {d.hostname} shows your GetShowUps website instead of anything that was there before.
      </p>
      {d.records.map((r) => (
        <Record key={r.type} r={r} />
      ))}
      <p className="fine">{d.status === 'securing' && d.detail === 'certificate_pending' ? 'Record found. We’re setting up a secure connection (https). This can take up to an hour.' : 'We check automatically and switch to “Connected” when it works.'}</p>
      {d.detail === 'dns_changed' && <p className="notice-soft">The record for {d.hostname} no longer points to your website. Add it back to reconnect.</p>}
    </>
  )
}

export default function DomainSettings({ siteUrl, compact = false, onChange }) {
  const [data, setData] = useState(null)
  const [mode, setMode] = useState(null)
  const [state, setState] = useState({})
  const [confirming, setConfirming] = useState(false)
  useEffect(() => {
    api('/api/dashboard/domain').then(({ status, data: d }) => setData(status === 200 ? d : { failed: true }))
  }, [])
  if (!data) return <div aria-busy="true" />
  if (data.failed) return <p className="form-error">Couldn’t load your domain settings.</p>

  const act = async (body) => {
    setState({ busy: true })
    const { status, data: d } = await api('/api/dashboard/domain', { method: 'POST', body })
    if (status === 200) {
      setData(d)
      setState({})
      setMode(null)
      setConfirming(false)
      onChange?.(d)
    } else setState({ error: ERRORS[d.error] || 'Something went wrong. Please try again.', suggestion: d.suggestion })
  }
  const d = data.domain
  const [label, tone] = d ? STATUS[d.status] || ['Checking', 'pending'] : []

  if (d) {
    return (
      <div className="form">
        <p className={`status status--${tone === 'ok' ? 'ok' : tone === 'bad' ? 'bad' : 'pending'}`}>
          <span className="status-dot" aria-hidden="true" />
          {d.hostname} · {label}
        </p>
        <Steps d={d} />
        {state.error && (
          <p className="form-error" role="alert">
            {state.error}
          </p>
        )}
        <div className="card-actions">
          {d.status !== 'connected' && (
            <button type="button" className="btn btn-primary" disabled={state.busy} onClick={() => act({ action: 'check' })}>
              {state.busy ? 'Checking…' : 'Check now'}
            </button>
          )}
          {!confirming ? (
            <button type="button" className="link-btn" onClick={() => setConfirming(true)}>
              Disconnect domain
            </button>
          ) : (
            <div className="confirm">
              <p className="fine">Your website stays live at {siteUrl.replace(/^https?:\/\//, '')}. {d.hostname} stays yours; remove the record at your domain provider when you’re ready.</p>
              <button type="button" className="btn btn-danger btn-sm" disabled={state.busy} onClick={() => act({ action: 'disconnect' })}>
                Disconnect {d.hostname}
              </button>
              <button type="button" className="link-btn" onClick={() => setConfirming(false)}>
                Keep it
              </button>
            </div>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="form">
      <div className="choice-list" role="radiogroup" aria-label="Website address">
        {[
          ['getshowups', 'Use your GetShowUps address', siteUrl.replace(/^https?:\/\//, '')],
          ['own', 'Use your own domain', 'You already own a domain, like yourbusiness.com'],
          ['buy', 'Get a new domain', 'Buy one in your name, then connect it'],
        ].map(([value, title, sub]) => (
          <label key={value} className="choice-card">
            <input type="radio" name="address" value={value} checked={(mode || 'getshowups') === value} onChange={() => setMode(value)} />
            <span>
              <strong>{title}</strong>
              <span className="fine">{sub}</span>
            </span>
          </label>
        ))}
      </div>
      {mode === 'own' && (
        <form
          className="form"
          onSubmit={(e) => {
            e.preventDefault()
            act({ action: 'connect', hostname: new FormData(e.currentTarget).get('hostname') })
          }}
        >
          <label className="field">
            <span>Enter your domain</span>
            <input name="hostname" placeholder="www.yourbusiness.com" autoCapitalize="none" autoCorrect="off" spellCheck="false" required inputMode="url" />
          </label>
          {state.error && (
            <p className="form-error" role="alert">
              {state.error}
              {state.suggestion && (
                <>
                  {' '}
                  Use <button type="button" className="link-btn" onClick={() => act({ action: 'connect', hostname: state.suggestion })}>{state.suggestion}</button> instead, and set your domain provider to forward the bare domain to it.
                </>
              )}
            </p>
          )}
          <button className="btn btn-primary" disabled={state.busy}>
            {state.busy ? 'Connecting…' : 'Connect'}
          </button>
        </form>
      )}
      {mode === 'buy' && (
        <div className="stack">
          <p>Buy your domain from any domain company (for example Namecheap, GoDaddy or Squarespace) in your own name, so it always belongs to you. Then choose “Use your own domain” and enter it here.</p>
          <p className="fine">Tip: choose www.yourname.com. It connects most easily.</p>
        </div>
      )}
      {!compact && <p className="fine">Your domain always stays yours. If you ever leave GetShowUps, you can point it anywhere else.</p>}
    </div>
  )
}
