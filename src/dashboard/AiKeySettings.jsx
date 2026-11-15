// Optional: the business's own Claude or OpenAI API key for the website writer. Without one, the included writer is used
// (within the daily allowance) or the professional templates. The key is checked with the provider, stored encrypted,
// and never shown again (only the last 4 characters).
import { useEffect, useState } from 'react'
import { api } from '../lib/api.js'

const ERRORS = {
  invalid_key_format: 'That doesn’t look like an API key. Copy it again from your provider’s API keys page.',
  invalid_key: 'The provider didn’t accept that key. Check it and try again.',
  provider_rate_limited: 'The provider is busy. Please try again in a minute.',
  provider_unavailable: 'We couldn’t reach the provider. Please try again in a minute.',
  rate_limited: 'Too many tries. Please wait a while and try again.',
}
const WHERE = { anthropic: 'console.anthropic.com → API keys', openai: 'platform.openai.com → API keys' }

export default function AiKeySettings({ onChange }) {
  const [key, setKey] = useState(undefined)
  const [provider, setProvider] = useState('anthropic')
  const [value, setValue] = useState('')
  const [state, setState] = useState({})
  useEffect(() => {
    api('/api/dashboard/ai-key').then(({ status, data }) => setKey(status === 200 ? data.key : null))
  }, [])
  if (key === undefined) return <div aria-busy="true" />
  const post = async (body) => {
    setState({ busy: true })
    const { status, data } = await api('/api/dashboard/ai-key', { method: 'POST', body })
    if (status === 200) {
      setKey(data.key)
      setValue('')
      setState({ saved: body.action === 'save' })
      onChange?.(data.key)
    } else setState({ error: ERRORS[data.error] || 'Something went wrong. Please try again.' })
  }
  if (key) {
    return (
      <div className="form">
        <p className={`status status--${key.status === 'ok' ? 'ok' : 'bad'}`}>
          <span className="status-dot" aria-hidden="true" />
          {key.label} key ending {key.hint} · {key.status === 'ok' ? 'in use for your website' : 'not working, replace it'}
        </p>
        {state.saved && (
          <p className="fine" role="status">
            Connected. New designs and changes now use your own API account.
          </p>
        )}
        {state.error && (
          <p className="form-error" role="alert">
            {state.error}
          </p>
        )}
        <button type="button" className="link-btn" disabled={state.busy} onClick={() => post({ action: 'remove' })}>
          Remove key
        </button>
      </div>
    )
  }
  return (
    <form
      className="form"
      onSubmit={(e) => {
        e.preventDefault()
        post({ action: 'save', provider, key: value })
      }}
    >
      <p className="fine">Optional. Use your own API account for AI designs and changes. Usage is billed by your provider. A Claude Pro or ChatGPT Plus subscription doesn’t include API access.</p>
      <div className="choice" role="radiogroup" aria-label="Provider">
        {[
          ['anthropic', 'Claude'],
          ['openai', 'OpenAI'],
        ].map(([v, label]) => (
          <label key={v} className="choice-option">
            <input type="radio" name="ai-provider" value={v} checked={provider === v} onChange={() => setProvider(v)} />
            {label}
          </label>
        ))}
      </div>
      <label className="field">
        <span>API key</span>
        <input type="password" value={value} onChange={(e) => setValue(e.target.value)} autoComplete="off" spellCheck={false} placeholder={provider === 'anthropic' ? 'sk-ant-…' : 'sk-…'} required />
      </label>
      <p className="fine">Find it at {WHERE[provider]}. We check it, store it encrypted, and never show it again.</p>
      {state.error && (
        <p className="form-error" role="alert">
          {state.error}
        </p>
      )}
      <button className="btn btn-quiet" disabled={state.busy || !value.trim()}>
        {state.busy ? 'Checking…' : 'Connect key'}
      </button>
    </form>
  )
}
