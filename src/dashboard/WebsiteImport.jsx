// Bring your current website: read the business's existing public site, show what was found, and put the chosen
// text and photos into the private draft. The live website never changes here.
import { useEffect, useState } from 'react'
import { api } from '../lib/api.js'

const ERRORS = {
  invalid_url: 'Enter your website address, like www.yourbusiness.com.',
  unsafe_url: 'Enter your website address, like www.yourbusiness.com.',
  unsupported_protocol: 'Enter your website address, like www.yourbusiness.com.',
  unreachable: 'We couldn’t reach that website. Check the address and try again.',
  robots_disallowed: 'That website asks automated tools not to read it, so we can’t import it. You can still build your site below.',
  confirmation_required: 'Please confirm this is your business’s website.',
  rate_limited: 'Too many imports for now. Please try again in an hour.',
}
const SKIP = { robots: 'not allowed by the site', page_limit: 'over the page limit', duplicate: 'same as another page', too_large: 'too large', not_a_page: 'not a web page', unreachable: 'couldn’t load' }
const FLAG = {
  empty_page: (f) => `${f.path} has no text we could read (it may be a form or app).`,
  placeholder_title: (f) => `${f.path} has a placeholder title (“${f.title}”).`,
  price_conflict: (f) => `Different prices appear for “${f.name}”: ${f.prices.join(', ')}.`,
}
const FIELDS = [
  ['headline', 'Headline'],
  ['intro', 'Introduction'],
  ['about', 'About'],
  ['services', 'Services and prices'],
  ['area', 'Service area'],
  ['seoTitle', 'Search title'],
  ['seoDescription', 'Search description'],
]

function Preview({ field, value }) {
  if (field === 'services')
    return (
      <ul className="import-services">
        {value.map((s) => (
          <li key={s.name}>
            <strong>{s.name}</strong>
            {s.price && <span> · {s.price}</span>}
            {s.description && <p className="fine">{s.description}</p>}
          </li>
        ))}
      </ul>
    )
  return <p className="import-text">{value}</p>
}

export default function WebsiteImport({ defaultUrl = '', onApplied }) {
  const [imp, setImp] = useState(undefined)
  const [url, setUrl] = useState(defaultUrl)
  const [mine, setMine] = useState(false)
  const [state, setState] = useState({})
  const [fields, setFields] = useState([])
  const [photos, setPhotos] = useState([])
  const choose = (i) => {
    setImp(i)
    if (i?.status === 'done') {
      setFields(FIELDS.map(([f]) => f).filter((f) => i.suggestion.content[f] !== undefined))
      setPhotos(i.suggestion.photos.slice(0, 6).map((p) => p.url))
    }
  }
  useEffect(() => {
    api('/api/dashboard/website/import').then(({ status, data }) => choose(status === 200 ? data.import : null))
  }, [])
  if (imp === undefined) return <div aria-busy="true" />

  const start = async (e) => {
    e.preventDefault()
    setState({ busy: true })
    const { status, data } = await api('/api/dashboard/website/import', { method: 'POST', body: { action: 'start', url, confirm: mine } })
    if (status === 200) {
      choose(data.import)
      setState({})
    } else setState({ error: ERRORS[data.error] || 'Something went wrong. Please try again.' })
  }
  const apply = async () => {
    setState({ applying: true })
    const { status, data } = await api('/api/dashboard/website/import', { method: 'POST', body: { action: 'apply', importId: imp.id, fields, photos } })
    if (status === 200) {
      const notes = [data.rejected.length ? `${data.rejected.length} item(s) were left out because they make promises we can’t verify or are too long.` : '', data.photosFailed.length ? `${data.photosFailed.length} photo(s) couldn’t be copied.` : ''].filter(Boolean)
      setState({ done: `Added to your draft${data.photosAdded ? ` with ${data.photosAdded} photo${data.photosAdded === 1 ? '' : 's'}` : ''}. Your live website hasn’t changed.`, notes })
      onApplied?.()
    } else setState({ error: 'Couldn’t add this to your draft. Please try again.' })
  }
  const toggle = (list, set, v) => set(list.includes(v) ? list.filter((x) => x !== v) : [...list, v])

  const form = (
    <form className="form" onSubmit={start}>
      <label className="field">
        <span>Your current website</span>
        <input value={url} onChange={(e) => setUrl(e.target.value)} inputMode="url" autoComplete="url" placeholder="www.yourbusiness.com" required />
      </label>
      <label className="check">
        <input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} /> This is my business’s website and I can use its content.
      </label>
      {state.error && (
        <p className="form-error" role="alert">
          {state.error}
        </p>
      )}
      <button className="btn btn-primary" disabled={state.busy || !mine || !url.trim()}>
        {state.busy ? 'Reading your website… (up to a minute)' : imp?.status === 'done' ? 'Import again' : 'Import my website'}
      </button>
    </form>
  )
  if (!imp || imp.status !== 'done') {
    return (
      <>
        <p className="fine">We’ll read the public pages of your current website (text, prices, photos) so you don’t have to retype anything. Nothing goes live until you publish.</p>
        {form}
      </>
    )
  }

  const s = imp.suggestion
  const host = imp.sourceUrl.replace(/^https?:\/\//, '')
  return (
    <div className="import">
      <p>
        <strong>
          Found {imp.pages.length} page{imp.pages.length === 1 ? '' : 's'} on {host}.
        </strong>{' '}
        Choose what to bring into your draft.
      </p>
      <details className="import-pages">
        <summary>Pages we read{imp.skipped.length ? ` and ${imp.skipped.length} we skipped` : ''}</summary>
        <ul>
          {imp.pages.map((p) => (
            <li key={p.path}>
              {p.path} <span className="fine">· {p.title}</span>
            </li>
          ))}
          {imp.skipped.map((p) => (
            <li key={p.url} className="fine">
              {new URL(p.url).pathname} · skipped ({SKIP[p.reason] || 'couldn’t load'})
            </li>
          ))}
        </ul>
      </details>
      {imp.flags.length > 0 && (
        <div className="notice-bad" role="note">
          <strong>Worth a look:</strong>
          <ul>
            {imp.flags.map((f, i) => (
              <li key={i}>{FLAG[f.kind]?.(f)}</li>
            ))}
          </ul>
        </div>
      )}
      <fieldset className="import-fields">
        <legend>Text</legend>
        {FIELDS.filter(([f]) => s.content[f] !== undefined).map(([f, label]) => (
          <label key={f} className="import-field">
            <input type="checkbox" checked={fields.includes(f)} onChange={() => toggle(fields, setFields, f)} />
            <span>
              <span className="import-label">{label}</span>
              <Preview field={f} value={s.content[f]} />
            </span>
          </label>
        ))}
        {!Object.keys(s.content).length && <p className="fine">We didn’t find text we could use.</p>}
      </fieldset>
      {s.photos.length > 0 && (
        <fieldset className="import-photos">
          <legend>Photos ({photos.length} selected, up to 6)</legend>
          <div className="import-photo-grid">
            {s.photos.map((p) => (
              <label key={p.url} className={`import-photo${photos.includes(p.url) ? ' is-on' : ''}`}>
                <input type="checkbox" checked={photos.includes(p.url)} disabled={!photos.includes(p.url) && photos.length >= 6} onChange={() => toggle(photos, setPhotos, p.url)} aria-label={p.alt || 'Photo from your website'} />
                <img src={p.url} alt="" loading="lazy" referrerPolicy="no-referrer" />
              </label>
            ))}
          </div>
        </fieldset>
      )}
      {state.done && (
        <p className="fine" role="status">
          {state.done} {state.notes?.join(' ')}
        </p>
      )}
      {state.error && (
        <p className="form-error" role="alert">
          {state.error}
        </p>
      )}
      <div className="card-actions">
        <button type="button" className="btn btn-primary" disabled={state.applying || (!fields.length && !photos.length)} onClick={apply}>
          {state.applying ? 'Adding to your draft…' : 'Use this in my draft'}
        </button>
      </div>
      <details>
        <summary className="fine">Import a different website</summary>
        {form}
      </details>
    </div>
  )
}
