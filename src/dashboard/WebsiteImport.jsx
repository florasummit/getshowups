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
  client_rendered: () => 'This website builds its pages in the visitor’s browser, so we could only read its title and description. Add your services, prices and other details below.',
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
  ['redirects', 'Old page addresses'],
]

const PAGE_LABEL = { services: 'Services page', about: 'About page', contact: 'Contact page', privacy: 'Privacy policy page' }
// Where a new page's content comes from, in words (found / missing / needs review).
function pageNote(p, host) {
  if (p.exists) return 'Already on your website.'
  if (p.kind === 'services') return `Your ${p.count} service${p.count === 1 ? '' : 's'} with their prices, as found on ${host}.`
  if (p.kind === 'about') return `The About text found on ${host}.`
  if (p.kind === 'contact') return 'A message form, plus your phone number if it’s in your business details.'
  if (p.source === 'imported') return `Copied word for word from ${host}${p.path} (${p.words} words). Check it’s still accurate before you publish.`
  if (p.problem) return `We found ${p.path} but couldn’t copy it completely, so it isn’t imported. You can start from a draft policy instead and review it.`
  return 'No privacy policy found on your website. You can start from a draft that matches what this website does. It isn’t legal advice: review it before you publish.'
}

const destination = (a) =>
  a.kept ? 'kept as it is (same page on your new site)' : a.to === 'book' ? 'booking page' : a.to === '/' ? 'home page' : a.to.startsWith('/#') ? `${a.to.slice(2)} section` : `your ${a.to.slice(1).replace(/-/g, ' ')} page`

// Every old address, what it was, and where it will go. Anything sent to the home page says why.
function Addresses({ list }) {
  return (
    <ul className="import-addresses" aria-label="Old page addresses">
      {list.map((a) => (
        <li key={a.from} data-from={a.from}>
          <span className="import-address">
            <code>{a.from}</code> <span className="fine">{a.label}</span>
          </span>
          <span>
            → {destination(a)}
            {a.empty && <span className="fine"> · this page is empty on your old site</span>}
          </span>
          {a.add && <span className="fine">Add a “{a.add}” page in the editor to keep this address{a.to === '/' ? '' : ' (until then it goes to booking)'}.</span>}
          {a.nomatch && <span className="fine">Nothing similar on your new site yet, so visitors land on your home page.</span>}
        </li>
      ))}
      <li className="fine">Once your domain points here, these old links keep working.</li>
    </ul>
  )
}

function Preview({ field, value, addresses }) {
  if (field === 'redirects') return addresses?.length ? <Addresses list={addresses} /> : null
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

// hasContent: the business already has website text (a designed or published site). Then the import pre-selects only the
// old page addresses and no photos, so moving a domain never replaces current text unless the owner ticks it.
export default function WebsiteImport({ defaultUrl = '', onApplied, hasContent = false }) {
  const [imp, setImp] = useState(undefined)
  const [url, setUrl] = useState(defaultUrl)
  const [mine, setMine] = useState(false)
  const [state, setState] = useState({})
  const [fields, setFields] = useState([])
  const [photos, setPhotos] = useState([])
  const [fixes, setFixes] = useState([])
  const [pages, setPages] = useState([])
  // An import already put into the draft is summarised in one line; the owner can open it again to re-apply parts.
  const [review, setReview] = useState(false)
  const choose = (i) => {
    setImp(i)
    if (i?.status === 'done') {
      setFields(FIELDS.map(([f]) => f).filter((f) => i.suggestion.content[f] !== undefined && (!hasContent || f === 'redirects')))
      setPhotos(hasContent ? [] : i.suggestion.photos.slice(0, 6).map((p) => p.url))
      setFixes((i.suggestion.fixes || []).map((f) => f.id))
      // New pages only ADD to the website (never replace a page or its edits): pages built from the old site's own
      // content are pre-selected; a starter privacy draft is offered but not pre-selected (it must be reviewed).
      setPages((i.suggestion.pages || []).filter((p) => !p.exists && p.source !== 'starter').map((p) => p.kind))
    }
  }
  // Loads the latest import once on mount (choose only sets state from it).
  useEffect(() => {
    api('/api/dashboard/website/import').then(({ status, data }) => choose(status === 200 ? data.import : null))
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    const { status, data } = await api('/api/dashboard/website/import', { method: 'POST', body: { action: 'apply', importId: imp.id, fields, photos, fixes, pages } })
    if (status === 200) {
      const added = (data.pagesAdded || []).map((k) => PAGE_LABEL[k])
      const notes = [
        data.siteCreated ? 'We built your website pages from this.' : '',
        added.length ? `New page${added.length === 1 ? '' : 's'}: ${added.join(', ')}.` : '',
        data.servicesSection ? 'Your services now show on your website.' : '',
        data.pagesSkipped === 'single_page_site' ? 'New pages need the multi-page editor; your current one-page website kept its look.' : '',
        data.rejected.length ? `${data.rejected.length} item(s) were left out because they make promises we can’t verify or are too long.` : '',
        data.photosFailed.length ? `${data.photosFailed.length} photo(s) couldn’t be copied.` : '',
      ].filter(Boolean)
      setState({ done: `Added to your draft${data.photosAdded ? ` with ${data.photosAdded} photo${data.photosAdded === 1 ? '' : 's'}` : ''}. Your live website hasn’t changed.`, notes })
      setImp((i) => ({ ...i, appliedAt: Date.now() }))
      setReview(false)
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
  if (imp.appliedAt && !review) {
    return (
      <div className="import">
        {state.done ? (
          <p className="fine" role="status">
            {state.done} {state.notes?.join(' ')}
          </p>
        ) : (
          <p>
            Your draft has the text and photos you chose from <strong>{host}</strong>
            <span className="fine"> · {new Date(imp.appliedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span>
          </p>
        )}
        <div className="card-actions">
          <button type="button" className="btn btn-quiet btn-sm" onClick={() => setReview(true)}>
            Review what we found again
          </button>
        </div>
        <details>
          <summary className="fine">Import a different website</summary>
          {form}
        </details>
      </div>
    )
  }
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
      {s.fixes?.length > 0 && (
        <fieldset className="import-fields">
          <legend>Suggested fixes</legend>
          <p className="fine">We found these on your current website. Nothing is rewritten for you: tick what you want fixed.</p>
          {s.fixes.map((f) => (
            <label key={f.id} className="import-field">
              <input type="checkbox" checked={fixes.includes(f.id)} onChange={() => toggle(fixes, setFixes, f.id)} />
              <span>
                {f.kind === 'possible_typo' ? (
                  <>
                    Spelling: “{f.from}” → “{f.to}” <span className="fine">(as spelled elsewhere on your site)</span>
                  </>
                ) : (
                  <>
                    Leave out the description of “{f.service}”{' '}
                    <span className="fine">
                      {f.reason === 'indoor_cleaning' ? 'It reads like house-cleaning text' : 'It doesn’t describe this service'}: “{f.excerpt}…”
                    </span>
                  </>
                )}
              </span>
            </label>
          ))}
        </fieldset>
      )}
      <fieldset className="import-fields">
        <legend>Text</legend>
        {hasContent && <p className="fine">Your current website text stays as it is unless you tick it here. Old page addresses are ticked so links from Google keep working.</p>}
        {FIELDS.filter(([f]) => s.content[f] !== undefined).map(([f, label]) => (
          <label key={f} className="import-field">
            <input type="checkbox" checked={fields.includes(f)} onChange={() => toggle(fields, setFields, f)} />
            <span>
              <span className="import-label">{label}</span>
              <Preview field={f} value={s.content[f]} addresses={s.addresses} />
            </span>
          </label>
        ))}
        {!Object.keys(s.content).length && <p className="fine">We didn’t find text we could use.</p>}
      </fieldset>
      {(s.pages || []).length > 0 && (
        <fieldset className="import-fields" aria-label="Pages">
          <legend>Pages</legend>
          <p className="fine">New pages are added to your website; pages you already have are never replaced.</p>
          {s.pages.map((p) => (
            <label key={p.kind} className="import-field" data-page={p.kind}>
              <input type="checkbox" checked={!p.exists && pages.includes(p.kind)} disabled={p.exists} onChange={() => toggle(pages, setPages, p.kind)} />
              <span>
                <span className="import-label">{PAGE_LABEL[p.kind]}</span>
                <span className="fine">{pageNote(p, host)}</span>
              </span>
            </label>
          ))}
        </fieldset>
      )}
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
        <button type="button" className="btn btn-primary" disabled={state.applying || (!fields.length && !photos.length && !pages.length)} onClick={apply}>
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
