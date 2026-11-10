// "Create my website": one request writes the copy from the business details; the owner picks one of
// three designs (previews render the stored result, no further AI calls) and it becomes the private
// draft. The live website changes only when the owner publishes.
import { useState } from 'react'
import { api } from '../lib/api.js'
import { ScaledFrame } from './WebsiteEditor.jsx'

const DESIGNS = [
  ['clean', 'Clean', 'Light and simple'],
  ['bold', 'Bold', 'Strong colour header'],
  ['warm', 'Warm', 'Soft and classic'],
]

export default function WebsiteGenerator({ hasDraft, onApplied, intro }) {
  const [gen, setGen] = useState(null)
  const [state, setState] = useState({})
  const generate = async () => {
    setState({ busy: 'writing' })
    const { status, data } = await api('/api/dashboard/website', { method: 'POST', body: { action: 'generate' } })
    if (status === 200) {
      setGen(data.generation)
      setState({})
    } else setState({ error: status === 429 ? 'You’ve created several versions today. Please try again tomorrow, or edit the text below.' : 'We couldn’t create it just now. Please try again.' })
  }
  const choose = async (template) => {
    setState({ busy: template })
    const { status, data } = await api('/api/dashboard/website', { method: 'POST', body: { action: 'apply', generationId: gen.id, template } })
    if (status === 200) {
      setGen(null)
      setState({})
      onApplied(data)
    } else setState({ error: 'Couldn’t use that design. Please try again.' })
  }

  if (!gen) {
    return (
      <div className="generator">
        {intro && <p className="lede">{intro}</p>}
        {hasDraft && <p className="fine">This replaces your draft’s text. Your photos stay, and your live website doesn’t change until you publish.</p>}
        <button type="button" className="btn btn-primary btn-lg" disabled={Boolean(state.busy)} onClick={generate}>
          {state.busy ? 'Writing your website…' : hasDraft ? 'Write it again' : 'Create my website'}
        </button>
        {state.busy && <p className="fine" role="status">This takes about 10 seconds.</p>}
        {state.error && (
          <p className="form-error" role="alert">
            {state.error}
          </p>
        )}
      </div>
    )
  }
  return (
    <div className="generator">
      <p className="lede">Choose a design. You can change it any time.</p>
      {gen.source === 'template' && <p className="fine">Written from your details using our standard template.</p>}
      <div className="design-grid">
        {DESIGNS.map(([id, name, sub]) => (
          <div key={id} className="design-card">
            <ScaledFrame title={`${name} design`} src={`/api/dashboard/website/preview?generation=${gen.id}&template=${id}`} height={900} />
            <div className="design-card-foot">
              <span>
                <strong>{name}</strong>
                <span className="fine"> · {sub}</span>
              </span>
              <button type="button" className="btn btn-primary btn-sm" disabled={Boolean(state.busy)} onClick={() => choose(id)}>
                {state.busy === id ? 'Applying…' : `Use ${name}`}
              </button>
            </div>
          </div>
        ))}
      </div>
      <button type="button" className="link-btn" disabled={Boolean(state.busy)} onClick={() => setGen(null)}>
        Cancel
      </button>
      {state.error && (
        <p className="form-error" role="alert">
          {state.error}
        </p>
      )}
    </div>
  )
}
