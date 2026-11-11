// Structured website editor (no page builder): a few clear fields, saved automatically, with a live
// preview that is rendered by the same engine as the public site. Used in onboarding and the Website tab.
import { useEffect, useRef, useState } from 'react'
import { problemText } from './website-data.js'
import { api } from '../lib/api.js'
import { uploadImage } from '../lib/images.js'

const STYLE_LABELS = { clean: 'Clean', bold: 'Bold', warm: 'Warm' }
// Saves `content` a moment after the last change. Returns the save status for a quiet indicator.
function useAutosave(content, onSaved) {
  const [status, setStatus] = useState('saved')
  const first = useRef(true)
  const saved = useRef(onSaved)
  useEffect(() => {
    saved.current = onSaved
  })
  useEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    setStatus('pending')
    const t = setTimeout(async () => {
      setStatus('saving')
      const { status: s, data } = await api('/api/dashboard/website', { method: 'POST', body: { action: 'save', content } })
      if (s === 200) {
        setStatus('saved')
        saved.current?.(data)
      } else setStatus({ error: data.fields ? problemText(data.fields) : 'Couldn’t save. Check your connection.' })
    }, 700)
    return () => clearTimeout(t)
  }, [content])
  return status
}

export function SaveStatus({ status }) {
  if (status?.error)
    return (
      <p className="form-error" role="alert">
        {status.error}
      </p>
    )
  return (
    <p className="fine save-status" role="status" aria-live="polite">
      {status === 'saved' ? 'All changes saved' : 'Saving…'}
    </p>
  )
}

// A page rendered at real desktop width (scaled to fit) or phone width. `query` selects what to render.
export function ScaledFrame({ src, title, width = 1280, height = 860 }) {
  const box = useRef(null)
  const [scale, setScale] = useState(0.5)
  useEffect(() => {
    const el = box.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setScale(Math.min(1, e.contentRect.width / width)))
    ro.observe(el)
    return () => ro.disconnect()
  }, [width])
  return (
    <div ref={box} className="scaled-frame" style={{ height: Math.round(height * scale) }}>
      <iframe title={title} src={src} sandbox="allow-same-origin" loading="lazy" style={{ width, height, transform: `scale(${scale})` }} />
    </div>
  )
}

export function WebsitePreview({ stamp, live = false, title = 'Website preview', query = '' }) {
  const [device, setDevice] = useState(() => (typeof window !== 'undefined' && window.innerWidth < 700 ? 'phone' : 'desktop'))
  const src = `/api/dashboard/website/preview?${live ? 'live=1&' : ''}${query}v=${stamp}`
  return (
    <figure className="site-preview">
      <div className="site-preview-bar">
        <figcaption className="fine">{live ? 'Your live website' : 'Preview · only you can see this'}</figcaption>
        <div className="segmented" role="group" aria-label="Preview size">
          {['desktop', 'phone'].map((d) => (
            <button key={d} type="button" aria-pressed={device === d} onClick={() => setDevice(d)}>
              {d === 'phone' ? 'Phone' : 'Computer'}
            </button>
          ))}
        </div>
      </div>
      {device === 'desktop' ? (
        <div className="site-preview-frame">
          <ScaledFrame title={title} src={src} />
        </div>
      ) : (
        <div className="site-preview-frame site-preview-frame--phone">
          <iframe title={title} src={src} sandbox="allow-same-origin" loading="lazy" />
        </div>
      )}
    </figure>
  )
}

function ImagePicker({ label, hint, value, kind, onPick, onRemove }) {
  const [state, setState] = useState({})
  const pick = async (e) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setState({ busy: true })
    const r = await uploadImage(file, kind)
    setState(r.error ? { error: r.error } : {})
    if (r.asset) onPick(r.asset.id)
  }
  return (
    <div className="image-pick">
      <div className={`image-pick-thumb image-pick-thumb--${kind}`}>{value ? <img src={`/site-assets/${value}`} alt="" /> : <span aria-hidden="true">+</span>}</div>
      <div>
        <p className="image-pick-label">{label}</p>
        {hint && <p className="fine">{hint}</p>}
        <div className="image-pick-actions">
          <label className="btn btn-quiet btn-sm">
            {state.busy ? 'Uploading…' : value ? 'Replace' : 'Upload'}
            <input type="file" accept="image/*" className="sr-only" onChange={pick} disabled={state.busy} />
          </label>
          {value && (
            <button type="button" className="link-btn" onClick={onRemove}>
              Remove
            </button>
          )}
        </div>
        {state.error && (
          <p className="form-error" role="alert">
            {state.error}
          </p>
        )}
      </div>
    </div>
  )
}

function Photos({ c, set }) {
  const [state, setState] = useState({})
  const add = async (e) => {
    const files = [...(e.target.files || [])].slice(0, 6 - c.photos.length)
    e.target.value = ''
    setState({ busy: true })
    const ids = []
    for (const f of files) {
      const r = await uploadImage(f, 'photo')
      if (r.error) {
        setState({ error: r.error })
        break
      }
      ids.push(r.asset.id)
    }
    if (ids.length) set({ photos: [...c.photos, ...ids] })
    setState((s) => ({ ...s, busy: false }))
  }
  return (
    <div className="field">
      <span>Gallery <em>(up to 6 photos of your work)</em></span>
      <div className="photo-grid">
        {c.photos.map((id) => (
          <div key={id} className="photo-cell">
            <img src={`/site-assets/${id}`} alt="" />
            <button type="button" className="photo-remove" aria-label="Remove photo" onClick={() => set({ photos: c.photos.filter((p) => p !== id) })}>
              ×
            </button>
          </div>
        ))}
        {c.photos.length < 6 && (
          <label className="photo-cell photo-add">
            {state.busy ? 'Uploading…' : '+ Add photos'}
            <input type="file" accept="image/*" multiple className="sr-only" onChange={add} disabled={state.busy} />
          </label>
        )}
      </div>
      {state.error && (
        <p className="form-error" role="alert">
          {state.error}
        </p>
      )}
    </div>
  )
}

// `initial`: website content; `colors`: { name: hex }; `onSaved(state)`: after each autosave.
export default function WebsiteEditor({ initial, colors, designOptions, onSaved, onEdit, compact = false }) {
  const [c, setC] = useState(initial)
  const status = useAutosave(c, onSaved)
  const edited = useRef(onEdit)
  useEffect(() => {
    edited.current = onEdit
  })
  useEffect(() => {
    edited.current?.(c)
  }, [c])
  const set = (patch) => setC((prev) => ({ ...prev, ...patch }))
  const text = (k) => (e) => set({ [k]: e.target.value })
  const setService = (i, k) => (e) => set({ services: c.services.map((s, j) => (j === i ? { ...s, [k]: e.target.value } : s)) })
  const lines = (t) => t.split('\n')

  return (
    <div className="editor">
      {c.design && designOptions?.palettes ? (
        <fieldset className="field">
          <legend>Look</legend>
          <div className="swatches" role="radiogroup" aria-label="Colours">
            {Object.entries(designOptions.palettes).map(([name, p]) => (
              <button key={name} type="button" role="radio" aria-checked={c.design.palette === name} aria-label={p.label} title={p.label} className="swatch swatch--duo" style={{ '--swatch': p.accent, '--swatch-bg': p.bg }} onClick={() => set({ design: { ...c.design, palette: name } })} />
            ))}
          </div>
          <div className="segmented segmented--wrap" role="radiogroup" aria-label="Lettering">
            {Object.entries(designOptions.fonts).map(([name, label]) => (
              <button key={name} type="button" role="radio" aria-checked={c.design.fonts === name} onClick={() => set({ design: { ...c.design, fonts: name } })}>
                {label}
              </button>
            ))}
          </div>
        </fieldset>
      ) : (
      <fieldset className="field">
        <legend>Look</legend>
        <div className="segmented segmented--wide" role="radiogroup" aria-label="Style">
          {Object.keys(STYLE_LABELS).map((t) => (
            <button key={t} type="button" role="radio" aria-checked={c.template === t} onClick={() => set({ template: t })}>
              {STYLE_LABELS[t]}
            </button>
          ))}
        </div>
        <div className="swatches" role="radiogroup" aria-label="Colour">
          {Object.entries(colors).map(([name, hex]) => (
            <button key={name} type="button" role="radio" aria-checked={c.color === name} aria-label={name} className="swatch" style={{ '--swatch': hex }} onClick={() => set({ color: name })} />
          ))}
        </div>
      </fieldset>
      )}

      <label className="field">
        <span>Headline</span>
        <input value={c.headline} onChange={text('headline')} maxLength={80} />
      </label>
      <label className="field">
        <span>Introduction</span>
        <textarea rows={3} value={c.intro} onChange={text('intro')} maxLength={400} />
      </label>

      <fieldset className="field">
        <legend>Services</legend>
        {c.services.map((s, i) => (
          <div key={i} className="service-edit">
            <div className="service-row">
              <input value={s.name} onChange={setService(i, 'name')} maxLength={60} aria-label={`Service ${i + 1}`} placeholder="Service" />
              <input value={s.price} onChange={setService(i, 'price')} maxLength={40} aria-label={`Price for service ${i + 1}`} placeholder="Price (optional)" />
              <button type="button" className="link-btn service-remove" aria-label={`Remove service ${i + 1}`} onClick={() => set({ services: c.services.filter((_, j) => j !== i) })}>
                Remove
              </button>
            </div>
            {!compact && <input value={s.description} onChange={setService(i, 'description')} maxLength={240} aria-label={`Description for service ${i + 1}`} placeholder="Short description (optional)" />}
          </div>
        ))}
        {c.services.length < 12 && (
          <button type="button" className="btn btn-quiet btn-sm" onClick={() => set({ services: [...c.services, { name: '', price: '', description: '' }] })}>
            Add a service
          </button>
        )}
      </fieldset>

      <details className="more">
        <summary>Logo and photos</summary>
        <ImagePicker label="Logo" hint="Shown at the top of your site." kind="logo" value={c.logo} onPick={(id) => set({ logo: id })} onRemove={() => set({ logo: null })} />
        <ImagePicker label="Main photo" hint="A clear photo of your work or team." kind="photo" value={c.hero} onPick={(id) => set({ hero: id })} onRemove={() => set({ hero: null })} />
        <Photos c={c} set={set} />
      </details>

      <details className="more">
        <summary>About and service area</summary>
        <label className="field">
          <span>About your business <em>(optional)</em></span>
          <textarea rows={4} value={c.about} onChange={text('about')} maxLength={1200} placeholder="Who you are and how you work." />
        </label>
        <label className="field">
          <span>Service area</span>
          <input value={c.area} onChange={text('area')} maxLength={200} />
        </label>
        <label className="field">
          <span>Facts about your business <em>(optional, one per line, only things that are true)</em></span>
          <textarea rows={3} value={c.highlights.join('\n')} onChange={(e) => set({ highlights: lines(e.target.value) })} placeholder="Family owned since 2015" />
        </label>
      </details>

      <details className="more">
        <summary>How you appear in Google</summary>
        <label className="field">
          <span>Page title</span>
          <input value={c.seoTitle} onChange={text('seoTitle')} maxLength={70} />
        </label>
        <label className="field">
          <span>Description</span>
          <textarea rows={2} value={c.seoDescription} onChange={text('seoDescription')} maxLength={160} />
        </label>
      </details>

      <SaveStatus status={status} />
    </div>
  )
}

