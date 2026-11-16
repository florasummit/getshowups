// Optional: the business's own Claude or OpenAI API key for the website writer. Without one, the included writer is used
// (within the daily allowance) or the professional templates. The key is checked with the provider, stored encrypted,
// and never shown again (only the last 4 characters).
import { useEffect, useState } from 'react'
import { api } from '../lib/api.js'

const ERRORS = {
  invalid_key_format: 'That doesn’t look like an API key. Copy it again from your provider’s API keys page.',
  invalid_model: 'That model isn’t available here. Choose one from the list.',
  invalid_budget: 'Enter a monthly limit between $1 and $1,000.',
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
        {key.modelUnavailable && (
          <p className="notice-bad" role="alert">
            {key.model} is no longer offered on your account. Choose another model (we never switch it for you).
          </p>
        )}
        <label className="field">
          <span>Model</span>
          <select value={key.model} disabled={state.busy} onChange={(e) => post({ action: 'model', model: e.target.value })}>
            <option value="auto">Auto · best tested model within your limit{key.model === 'auto' && key.autoModel ? ` (now ${key.autoModel})` : ''}</option>
            {key.modelUnavailable && <option value={key.model}>{key.model} (no longer available)</option>}
            {key.choices.map((c) => (
              <option key={c.id} value={c.id} disabled={!c.selectable}>
                {c.label}
                {c.selectable ? ` · $${c.inputPerM}/$${c.outputPerM} per 1M tokens${c.status === 'tested' ? ' · tested' : ''}` : ' · not yet supported'}
                {c.retiresAt ? ` · retires ${c.retiresAt}` : ''}
              </option>
            ))}
          </select>
        </label>
        <p className="fine">
          From your {key.label} account{key.catalogAt ? `, checked ${new Date(key.catalogAt).toLocaleDateString()}` : ''}.{' '}
          <button type="button" className="link-btn" disabled={state.busy} onClick={() => post({ action: 'refresh' })}>
            Check for new models
          </button>
        </p>
        <form
          className="budget-row"
          onSubmit={(e) => {
            e.preventDefault()
            post({ action: 'budget', cents: Math.round(Number(new FormData(e.currentTarget).get('budget')) * 100) })
          }}
        >
          <label className="field">
            <span>Monthly limit for AI design (USD)</span>
            <input name="budget" type="number" min="1" max="1000" step="1" defaultValue={key.budgetCents / 100} />
          </label>
          <button className="btn btn-quiet btn-sm" disabled={state.busy}>
            Save limit
          </button>
          <p className="fine">
            About ${key.spentUsd.toFixed(2)} used this month. This is our estimate from your provider’s published prices, not their bill: we don’t send a request whose largest possible cost would go over your limit, but your provider bills you directly. Set a spending limit in your {key.label} account too.
          </p>
        </form>
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
