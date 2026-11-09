// Settings card: GoHighLevel connection. GetShowUps stays the source of truth and copies contacts
// and pipeline stages to GHL. Texts come from exactly one system: GetShowUps or a GHL workflow.
import { useEffect, useState } from 'react'
import { api } from '../lib/api.js'

const STAGES = [
  ['new', 'New lead'],
  ['booked', 'Booked'],
  ['showed', 'Showed up'],
  ['noShow', 'No-show'],
  ['completed', 'Job completed'],
]
const ERRORS = {
  invalid_token: 'GoHighLevel rejected that token.',
  invalid_token_format: 'That doesn’t look like a Private Integration token.',
  invalid_location: 'Check the location (sub-account) id.',
  pipeline_not_found: 'That pipeline wasn’t found in this location.',
  invalid_stages: 'Enter a stage id for every stage.',
  workflow_required_for_sms: 'To send texts from GoHighLevel, enter the workflow id.',
}

export default function GhlSettings() {
  const [cfg, setCfg] = useState(null)
  const [state, setState] = useState({})
  useEffect(() => {
    api('/api/dashboard/ghl').then(({ status, data }) => setCfg(status === 200 ? data : { failed: true }))
  }, [])
  if (!cfg) return <div aria-busy="true" />
  if (cfg.failed) return <p className="form-error" role="alert">Couldn’t load the GoHighLevel connection.</p>

  const save = async (e) => {
    e.preventDefault()
    const f = new FormData(e.currentTarget)
    const body = {
      token: f.get('token'),
      locationId: f.get('locationId').trim(),
      pipelineId: f.get('pipelineId').trim(),
      stageIds: Object.fromEntries(STAGES.map(([k]) => [k, f.get(`stage_${k}`).trim()])),
      workflowId: f.get('workflowId').trim() || null,
      smsVia: f.get('smsVia'),
    }
    setState({ busy: true })
    const { status, data } = await api('/api/dashboard/ghl', { method: 'POST', body })
    if (status === 200) {
      setCfg(data)
      setState({ note: 'Connected.' })
    } else setState({ error: ERRORS[data.error] || 'Couldn’t connect. Please try again.' })
  }
  const disconnect = async () => {
    setState({ busy: true })
    const { status, data } = await api('/api/dashboard/ghl', { method: 'POST', body: { disconnect: true } })
    if (status === 200) {
      setCfg(data)
      setState({ note: 'Disconnected.' })
    } else setState({ error: 'Couldn’t disconnect. Please try again.' })
  }

  if (cfg.connected) {
    return (
      <div className="stack">
        <p>
          Connected to location <strong>{cfg.locationId}</strong>. Texts are sent by <strong>{cfg.smsVia === 'ghl' ? 'your GoHighLevel workflow' : 'GetShowUps'}</strong>.
        </p>
        {state.note && <p className="fine" role="status">{state.note}</p>}
        {state.error && <p className="form-error" role="alert">{state.error}</p>}
        <button type="button" className="btn btn-quiet" disabled={state.busy} onClick={disconnect}>
          Disconnect
        </button>
      </div>
    )
  }
  return (
    <form className="stack" onSubmit={save}>
      <p className="fine">Copies new leads and their status to your GoHighLevel pipeline. Your customers never see GoHighLevel.</p>
      <label className="field">
        <span>Private Integration token</span>
        <input name="token" type="password" autoComplete="off" required minLength={20} />
      </label>
      <div className="field-row">
        <label className="field">
          <span>Location id</span>
          <input name="locationId" required />
        </label>
        <label className="field">
          <span>Pipeline id</span>
          <input name="pipelineId" required />
        </label>
      </div>
      <fieldset className="field">
        <legend>Pipeline stage ids</legend>
        {STAGES.map(([k, label]) => (
          <label key={k} className="field">
            <span>{label}</span>
            <input name={`stage_${k}`} required />
          </label>
        ))}
      </fieldset>
      <label className="field">
        <span>Workflow id <em>(optional)</em></span>
        <input name="workflowId" />
      </label>
      <fieldset className="field">
        <legend>Who sends text messages?</legend>
        <label className="check">
          <input type="radio" name="smsVia" value="getshowups" defaultChecked />
          <span>GetShowUps (default)</span>
        </label>
        <label className="check">
          <input type="radio" name="smsVia" value="ghl" />
          <span>My GoHighLevel workflow (GetShowUps stops sending texts)</span>
        </label>
      </fieldset>
      {state.error && <p className="form-error" role="alert">{state.error}</p>}
      <button className="btn btn-primary" disabled={state.busy}>
        {state.busy ? 'Checking…' : 'Connect'}
      </button>
    </form>
  )
}
