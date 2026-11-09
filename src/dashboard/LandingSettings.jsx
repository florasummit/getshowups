// Settings card: the business landing page. A draft is generated from the business details; the owner
// edits it and publishes. Unpublishing takes the page down immediately.
import { useEffect, useState } from 'react'
import { api } from '../lib/api.js'

const lines = (t) => String(t || '').split('\n').map((s) => s.trim()).filter(Boolean)
const FIELD = { headline: 'Headline', intro: 'Introduction', services: 'Services', area: 'Service area', highlights: 'Facts about your business' }
const describe = (fields) =>
  fields.map((f) => (f.endsWith(':unapproved_claim') ? `${FIELD[f.split(':')[0]]}: remove reviews, guarantees, discounts, credentials or speed promises you haven’t confirmed` : `${FIELD[f]}: check length`))

export default function LandingSettings() {
  const [data, setData] = useState(null)
  const [state, setState] = useState({})
  useEffect(() => {
    api('/api/dashboard/landing').then(({ status, data: d }) => setData(status === 200 ? d : { failed: true }))
  }, [])
  if (!data) return <div aria-busy="true" />
  if (data.failed) return <p className="form-error" role="alert">Couldn’t load your page.</p>
  const p = data.page

  const submit = async (publish, e) => {
    e?.preventDefault()
    const f = new FormData(document.getElementById('landing-form'))
    const body = { headline: f.get('headline'), intro: f.get('intro'), services: lines(f.get('services')), area: f.get('area'), highlights: lines(f.get('highlights')), publish }
    setState({ busy: true })
    const { status, data: d } = await api('/api/dashboard/landing', { method: 'POST', body })
    if (status === 200) {
      setData({ ...data, page: d.page })
      setState({ note: publish ? 'Published.' : 'Saved. Your page is not public.' })
    } else setState({ problems: d.fields ? describe(d.fields) : ['Couldn’t save. Please try again.'] })
  }

  return (
    <form id="landing-form" className="stack" onSubmit={(e) => submit(p.published, e)}>
      <p>
        {p.published ? (
          <>
            Live at{' '}
            <a href={data.url} target="_blank" rel="noreferrer">
              {data.url.replace(/^https?:\/\//, '')}
            </a>
          </>
        ) : p.generated ? (
          'We drafted a page from your business details. Review it, then publish.'
        ) : (
          'Not published.'
        )}
      </p>
      <label className="field">
        <span>Headline</span>
        <input name="headline" defaultValue={p.headline} maxLength={80} required />
      </label>
      <label className="field">
        <span>Introduction</span>
        <textarea name="intro" rows={3} defaultValue={p.intro} maxLength={400} required />
      </label>
      <label className="field">
        <span>Services <em>(one per line)</em></span>
        <textarea name="services" rows={3} defaultValue={p.services.join('\n')} />
      </label>
      <label className="field">
        <span>Service area</span>
        <input name="area" defaultValue={p.area} maxLength={200} />
      </label>
      <label className="field">
        <span>Facts about your business <em>(optional, one per line; only things that are true, e.g. “Family owned since 2015”)</em></span>
        <textarea name="highlights" rows={2} defaultValue={p.highlights.join('\n')} />
      </label>
      {state.problems && (
        <ul className="problems" role="alert">
          {state.problems.map((x) => (
            <li key={x}>{x}</li>
          ))}
        </ul>
      )}
      {state.note && <p className="fine" role="status">{state.note}</p>}
      <div className="card-actions">
        {p.published ? (
          <>
            <button className="btn btn-primary" disabled={state.busy}>
              Save changes
            </button>
            <button type="button" className="btn btn-quiet" disabled={state.busy} onClick={() => submit(false)}>
              Unpublish
            </button>
          </>
        ) : (
          <>
            <button type="button" className="btn btn-primary" disabled={state.busy} onClick={() => submit(true)}>
              Publish page
            </button>
            <button className="btn btn-quiet" disabled={state.busy}>
              Save draft
            </button>
          </>
        )}
      </div>
    </form>
  )
}
