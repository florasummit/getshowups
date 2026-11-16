// Website Studio editor for an AI-designed site (content.site): edit without AI. Click anything in the live preview to
// edit that section; manage sections and pages; change the look. Every change re-renders the preview from the server
// (POST /api/dashboard/website/preview: validated like a save, nothing stored) and autosaves (debounced) with optimistic
// concurrency (baseUpdatedAt → 409 conflict, never a silent overwrite). Undo/redo for the session; unsaved changes are
// kept in this browser until the server confirms them. The server validates every save (it is the trust boundary).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../lib/api.js'
import { makePhoneCopy, uploadPhotoWithCopy } from '../lib/images.js'
import { ADDABLE, BACKGROUNDS, BUTTONS, FONT_PAIRS, LAYOUTS, PAGE_TYPES, SECTION_LABEL, colorsFor, newId, pageTemplate, sectionTemplate, takenIds, toneOf } from './site-templates.js'

const clone = (v) => JSON.parse(JSON.stringify(v))
const BACKUP = 'gsu-studio-unsaved'
const readBackup = () => {
  try {
    return JSON.parse(localStorage.getItem(BACKUP) || 'null')
  } catch {
    return null
  }
}
const writeBackup = (v) => {
  try {
    if (v) localStorage.setItem(BACKUP, JSON.stringify(v))
    else localStorage.removeItem(BACKUP)
  } catch {
    /* private mode: the server copy is still the source of truth */
  }
}
const REMOVED = { claim: 'a claim we can’t verify (for example a rating or guarantee) was left out', too_long: 'a text was shortened to fit', link: 'a link outside your website was changed to “Book”', image: 'a photo that isn’t yours was removed', invented_number: 'a number that isn’t in your details was left out' }

export default function SiteStudio({ website, assets: initialAssets, brand, visit, checkpoints = [], onSaved }) {
  const [content, setContent] = useState(() => clone(website.draft))
  const [base, setBase] = useState(website.updatedAt ?? null)
  const [past, setPast] = useState([])
  const [future, setFuture] = useState([])
  const [slug, setSlug] = useState('')
  const [selected, setSelected] = useState(null) // section id | 'nav' | 'footer'
  const [focus, setFocus] = useState(null)
  const [tab, setTab] = useState('section')
  const [device, setDevice] = useState(() => (typeof window !== 'undefined' && window.innerWidth < 700 ? 'phone' : 'desktop'))
  const [save, setSave] = useState({ state: 'saved' })
  const [html, setHtml] = useState('')
  const [removed, setRemoved] = useState([])
  const [assets, setAssets] = useState(initialAssets || [])
  const [restore, setRestore] = useState(() => {
    const b = readBackup()
    return b && b.base === (website.updatedAt ?? null) && JSON.stringify(b.content) !== JSON.stringify(website.draft) ? b : null
  })
  const frame = useRef(null)
  const dirty = useRef(false)

  const site = content.site
  const pageIndex = Math.max(0, site.pages.findIndex((p) => p.slug === slug))
  const page = site.pages[pageIndex]
  const sectionIndex = page.sections.findIndex((s) => s.id === selected)
  const section = sectionIndex >= 0 ? page.sections[sectionIndex] : null
  // Photos to choose from: the owner's photos, not their phone-sized copies (content.variants values).
  const photoAssets = useMemo(() => {
    const copies = new Set(Object.values(content.variants || {}))
    return assets.filter((a) => !copies.has(a.id))
  }, [assets, content.variants])
  const biz = useMemo(
    () => ({ name: brand || 'Our business', services: content.services || [], area: content.area || '', about: content.about || '', photos: photoAssets.map((a) => a.id), visit: Boolean(visit) }),
    [brand, visit, content.services, content.area, content.about, photoAssets],
  )

  // One edit = one undo step (up to 50). `fn` changes a deep copy of the current content.
  const change = (fn) => {
    const next = clone(content)
    fn(next)
    setPast((p) => [...p.slice(-49), content])
    setFuture([])
    dirty.current = true
    setContent(next)
  }
  const undo = () => {
    if (!past.length) return
    setFuture((f) => [content, ...f])
    setContent(past.at(-1))
    setPast((p) => p.slice(0, -1))
    dirty.current = true
  }
  const redo = () => {
    if (!future.length) return
    setPast((p) => [...p, content])
    setContent(future[0])
    setFuture((f) => f.slice(1))
    dirty.current = true
  }
  const editPage = (fn) => change((c) => fn(c.site.pages[pageIndex], c))
  const editSection = (fn) => change((c) => fn(c.site.pages[pageIndex].sections[sectionIndex], c))

  // Live preview of the unsaved content (validated and rendered by the server; nothing stored).
  useEffect(() => {
    const t = setTimeout(async () => {
      const { status, data } = await api('/api/dashboard/website/preview', { method: 'POST', body: { content, page: page.slug } })
      if (status === 200) {
        setHtml(data.html)
        setRemoved(data.removed || [])
      }
    }, 250)
    return () => clearTimeout(t)
  }, [content, page.slug])

  // Autosave: server-confirmed only; conflicts and failures are shown, never hidden; retried with backoff.
  const attempt = useRef(0)
  const latest = useRef(content)
  useEffect(() => {
    latest.current = content
  }, [content])
  const saveNow = useCallback(
    async ({ force = false } = {}) => {
      setSave({ state: 'saving' })
      const sent = content
      const { status, data } = await api('/api/dashboard/website', { method: 'POST', body: { action: 'save', content: sent, baseUpdatedAt: base, force } })
      if (status === 200) {
        attempt.current = 0
        setBase(data.website.updatedAt ?? null)
        // Nothing changed while saving: take the server's copy (it carries ids it assigned, e.g. a new service's).
        if (latest.current === sent) {
          dirty.current = false
          writeBackup(null)
          setContent(clone(data.website.draft))
        }
        setSave({ state: 'saved' })
        onSaved?.(data)
      } else if (status === 409 && data?.error === 'conflict') setSave({ state: 'conflict', latest: data.website })
      else if (status === 400) setSave({ state: 'invalid', fields: data?.fields || [] })
      else {
        attempt.current += 1
        setSave({ state: 'failed', retrying: attempt.current <= 3 })
      }
    },
    [content, base, onSaved],
  )
  useEffect(() => {
    if (!dirty.current) return
    writeBackup({ base, content })
    setSave({ state: 'pending' })
    const t = setTimeout(() => saveNow(), 800)
    return () => clearTimeout(t)
  }, [content, base, saveNow])
  useEffect(() => {
    if (save.state !== 'failed' || !save.retrying) return
    const t = setTimeout(() => saveNow(), [2000, 5000, 10000][attempt.current - 1] || 10000)
    return () => clearTimeout(t)
  }, [save, saveNow])
  // The dashboard got a newer draft from this same tab (publish, restore): with no unsaved edits, follow it, so the next
  // save doesn't report a conflict with ourselves. With unsaved edits, the save's conflict check decides.
  useEffect(() => {
    if (dirty.current || website.updatedAt == null || website.updatedAt === base) return
    setBase(website.updatedAt)
    setContent(clone(website.draft))
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when the dashboard's copy changes
  }, [website.updatedAt])
  // Leaving with unsaved changes: the browser asks first (and the local copy is offered next time).
  useEffect(() => {
    const warn = (e) => {
      if (dirty.current) e.preventDefault()
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [])

  // Click-to-edit inside the preview (same-origin frame; the website itself runs no script).
  const onFrameLoad = () => {
    const doc = frame.current?.contentDocument
    if (!doc) return
    const style = doc.createElement('style')
    style.textContent = 'section[id],header.nav,footer.foot{cursor:pointer}section[id]:hover,header.nav:hover,footer.foot:hover{outline:2px dashed #2563eb;outline-offset:-2px}.ge-selected{outline:3px solid #2563eb!important;outline-offset:-3px}'
    doc.head.appendChild(style)
    if (selected) doc.getElementById(selected)?.classList.add('ge-selected')
    doc.addEventListener('click', (e) => {
      const a = e.target.closest('a')
      const pageLink = a?.getAttribute('href')?.match(/^#page=([a-z0-9-]*)$/)
      e.preventDefault()
      if (pageLink && a.closest('header.nav')) {
        setSlug(pageLink[1])
        setSelected(null)
        return
      }
      const host = e.target.closest('section[id]')
      const id = e.target.closest('header.nav') ? 'nav' : e.target.closest('footer.foot') ? 'footer' : host?.id
      if (!id) return
      const t = e.target
      setFocus(t.closest('.btn') ? 'button' : t.closest('img') ? 'image' : t.closest('h1,h2,h3') ? 'heading' : t.closest('.eyebrow') ? 'eyebrow' : 'text')
      setSelected(id)
      setTab(id === 'nav' ? 'page' : id === 'footer' ? 'site' : 'section')
    })
    doc.addEventListener('submit', (e) => e.preventDefault())
  }

  // Bring back an earlier server copy of the draft (the current draft is kept as a copy first, so this can be undone).
  const restoreVersion = async (id) => {
    if (!window.confirm('Bring back this earlier version of your draft? Your current draft is kept in History, so you can switch back. Your live website doesn’t change.')) return
    const { status, data } = await api('/api/dashboard/website', { method: 'POST', body: { action: 'restoreCheckpoint', id } })
    if (status !== 200) return setSave({ state: 'failed', retrying: false })
    dirty.current = false
    writeBackup(null)
    setPast([])
    setFuture([])
    setContent(clone(data.website.draft))
    setBase(data.website.updatedAt ?? null)
    setSave({ state: 'saved' })
    onSaved?.(data)
  }
  const conflictKeepMine = () => saveNow({ force: true })
  const conflictLoadLatest = () => {
    setContent(clone(save.latest.draft))
    setBase(save.latest.updatedAt ?? null)
    setPast([])
    setFuture([])
    dirty.current = false
    writeBackup(null)
    setSave({ state: 'saved' })
  }

  return (
    <section className="card studio" aria-label="Website Studio editor">
      <div className="studio-bar">
        <label className="studio-page">
          <span className="sr-only">Page</span>
          <select value={page.slug} onChange={(e) => (setSlug(e.target.value), setSelected(null))}>
            {site.pages.map((p) => (
              <option key={p.slug} value={p.slug}>
                {p.navLabel}
              </option>
            ))}
          </select>
        </label>
        <div className="segmented" role="group" aria-label="Preview size">
          {['desktop', 'phone'].map((d) => (
            <button key={d} type="button" aria-pressed={device === d} onClick={() => setDevice(d)}>
              {d === 'phone' ? 'Phone' : 'Computer'}
            </button>
          ))}
        </div>
        <div className="studio-history">
          <button type="button" className="btn btn-quiet btn-sm" onClick={undo} disabled={!past.length}>
            Undo
          </button>
          <button type="button" className="btn btn-quiet btn-sm" onClick={redo} disabled={!future.length}>
            Redo
          </button>
        </div>
        <SaveState save={save} onRetry={() => saveNow()} />
      </div>
      {restore && (
        <div className="notice" role="alert">
          <p>You have changes from your last visit that weren’t saved.</p>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => {
              change((c) => Object.assign(c, clone(restore.content)))
              setRestore(null)
            }}
          >
            Restore them
          </button>{' '}
          <button
            type="button"
            className="link-btn"
            onClick={() => {
              writeBackup(null)
              setRestore(null)
            }}
          >
            Discard
          </button>
        </div>
      )}
      {save.state === 'conflict' && (
        <div className="notice" role="alert">
          <p>This website was changed somewhere else (another window or the AI designer) after you started editing.</p>
          <button type="button" className="btn btn-sm" onClick={conflictLoadLatest}>
            Load the latest version
          </button>{' '}
          <button type="button" className="link-btn" onClick={conflictKeepMine}>
            Keep my version
          </button>
        </div>
      )}
      {removed.length > 0 && (
        <p className="fine studio-removed" role="status">
          Our checks adjusted this page: {[...new Set(removed.map((r) => REMOVED[r.reason]).filter(Boolean))].join('; ')}.
        </p>
      )}
      <div className="studio-grid">
        <div className={`studio-preview studio-preview--${device}`}>
          {html ? <iframe ref={frame} title="Editable website preview" srcDoc={html} sandbox="allow-same-origin" onLoad={onFrameLoad} /> : <p className="fine">Loading preview…</p>}
          <p className="fine">Click anything on the page to edit it. Hidden sections are shown faded here and left out of your website.</p>
        </div>
        <div className="studio-panel">
          <div className="segmented segmented--wide" role="tablist" aria-label="Edit">
            {[
              ['section', 'Section'],
              ['page', 'Page'],
              ['site', 'Look'],
              ['photos', 'Photos'],
              ['history', 'History'],
            ].map(([k, label]) => (
              <button key={k} type="button" role="tab" aria-selected={tab === k} aria-pressed={tab === k} onClick={() => setTab(k)}>
                {label}
              </button>
            ))}
          </div>
          {tab === 'section' &&
            (section ? (
              <SectionEditor key={section.id + focus} section={section} site={site} page={page} services={content.services} assets={photoAssets} focus={focus} onChange={editSection} onServices={(fn) => change((c) => fn(c.services))} />
            ) : (
              <p className="fine">Click a section in the preview, or choose one under Page.</p>
            ))}
          {tab === 'page' && <PageEditor site={site} page={page} pageIndex={pageIndex} selected={selected} biz={biz} onSelect={(id) => (setSelected(id), setTab('section'))} onPage={editPage} onSite={(fn) => change((c) => fn(c.site, c))} onGo={(s) => (setSlug(s), setSelected(null))} />}
          {tab === 'site' && <LookEditor site={site} onSite={(fn) => change((c) => fn(c.site, c))} services={content.services} onServices={(fn) => change((c) => fn(c.services))} />}
          {tab === 'photos' && (
            <PhotosPanel
              assets={assets}
              variants={content.variants}
              onAdded={(list) => {
                setAssets((l) => [...list.filter((x) => !x.existing).map((x) => x.asset), ...l, ...list.filter((x) => x.small).map((x) => x.small)])
                const pairs = list.filter((x) => x.small).map((x) => [x.asset.id, x.small.id])
                if (pairs.length) change((c) => (c.variants = { ...(c.variants || {}), ...Object.fromEntries(pairs) }))
              }}
              onRemoved={(id) => setAssets((l) => l.filter((x) => x.id !== id))}
              onReload={async () => {
                const { status, data } = await api('/api/dashboard/website/assets')
                if (status === 200) setAssets(data.assets)
              }}
            />
          )}
          {tab === 'history' && <HistoryPanel checkpoints={checkpoints} busy={save.state !== 'saved'} onRestore={restoreVersion} />}
        </div>
      </div>
    </section>
  )
}

function SaveState({ save, onRetry }) {
  const text = { saved: 'All changes saved', pending: 'Unsaved changes…', saving: 'Saving…', conflict: 'Not saved: changed elsewhere', invalid: 'Not saved: check the highlighted text', failed: save.retrying ? 'Not saved yet. Retrying…' : 'Couldn’t save.' }[save.state]
  return (
    <p className={`fine save-status${['conflict', 'invalid', 'failed'].includes(save.state) ? ' save-status--bad' : ''}`} role="status" aria-live="polite" data-save={save.state}>
      {text}
      {save.state === 'failed' && !save.retrying && (
        <button type="button" className="link-btn" onClick={onRetry}>
          Try again
        </button>
      )}
    </p>
  )
}

// ---------- fields ----------
function Text({ label, value, onChange, max, area = false, autoFocus = false, hint }) {
  const v = value ?? ''
  return (
    <label className="field">
      <span>
        {label}
        {max ? <span className="fine counter"> {v.length}/{max}</span> : null}
      </span>
      {area ? <textarea rows={4} value={v} maxLength={max} autoFocus={autoFocus} onChange={(e) => onChange(e.target.value)} /> : <input value={v} maxLength={max} autoFocus={autoFocus} onChange={(e) => onChange(e.target.value)} />}
      {hint && <span className="fine">{hint}</span>}
    </label>
  )
}
function Choice({ label, value, options, onChange }) {
  return (
    <label className="field">
      <span>{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </label>
  )
}
// Where a button goes: booking, a page, or a section on this page.
function Target({ label, value, site, page, onChange }) {
  const options = [['book', 'Booking page'], ...site.pages.map((p) => [`page:${p.slug}`, `Page: ${p.navLabel}`]), ...page.sections.map((s) => [`section:${s.id}`, `Section: ${s.heading || SECTION_LABEL[s.type]}`])]
  return <Choice label={label} value={value || 'book'} options={options} onChange={onChange} />
}
function ButtonFields({ title, cta, site, page, onChange, autoFocus, removable = false }) {
  if (!cta)
    return (
      <button type="button" className="link-btn" onClick={() => onChange({ label: 'Book now', target: 'book' })}>
        Add {title.toLowerCase()}
      </button>
    )
  return (
    <fieldset className="field studio-group">
      <legend>{title}</legend>
      <Text label="Text" value={cta.label} max={32} autoFocus={autoFocus} onChange={(v) => onChange({ ...cta, label: v })} />
      <Target label="Goes to" value={cta.target} site={site} page={page} onChange={(v) => onChange({ ...cta, target: v })} />
      {removable && (
        <button type="button" className="link-btn" onClick={() => onChange(null)}>
          Remove this button
        </button>
      )}
    </fieldset>
  )
}
// Framing: click the photo to choose the point that must stay in view; choose the shape it's cropped to. Simple
// percentages and a short list of shapes (the server only accepts these).
const ASPECT_CHOICES = [['auto', 'As designed'], ['1x1', 'Square'], ['4x5', 'Portrait 4:5'], ['4x3', 'Landscape 4:3'], ['3x2', 'Landscape 3:2'], ['16x9', 'Wide 16:9']]
function Framing({ src, focus, aspect, onFocus, onAspect }) {
  const f = Array.isArray(focus) ? focus : [50, 50]
  const pick = (e) => {
    const r = e.currentTarget.getBoundingClientRect()
    onFocus([Math.round(((e.clientX - r.left) / r.width) * 100), Math.round(((e.clientY - r.top) / r.height) * 100)])
  }
  const key = (e) => {
    const step = { ArrowLeft: [-5, 0], ArrowRight: [5, 0], ArrowUp: [0, -5], ArrowDown: [0, 5] }[e.key]
    if (!step) return
    e.preventDefault()
    onFocus([Math.min(100, Math.max(0, f[0] + step[0])), Math.min(100, Math.max(0, f[1] + step[1]))])
  }
  return (
    <div className="studio-framing">
      {src && (
        <button type="button" className="studio-focus" onClick={pick} onKeyDown={key} aria-label={`Point to keep in view: ${f[0]}% across, ${f[1]}% down. Click the photo or use the arrow keys.`}>
          <img src={src} alt="" />
          <span className="studio-focus-dot" style={{ left: `${f[0]}%`, top: `${f[1]}%` }} aria-hidden="true" />
        </button>
      )}
      <Choice label="Shape" value={aspect || 'auto'} options={ASPECT_CHOICES} onChange={onAspect} />
      {Array.isArray(focus) && (focus[0] !== 50 || focus[1] !== 50) && (
        <button type="button" className="link-btn" onClick={() => onFocus([50, 50])}>
          Centre the photo again
        </button>
      )}
    </div>
  )
}

function ImageField({ label, value, alt, assets, onChange, onAlt, focus, aspect, onFocus, onAspect }) {
  const id = value?.startsWith('asset:') ? value.slice(6) : null
  return (
    <fieldset className="field studio-group">
      <legend>{label}</legend>
      {value && onFocus && <Framing src={id ? `/site-assets/${id}` : null} focus={focus} aspect={aspect} onFocus={onFocus} onAspect={onAspect} />}
      <div className="studio-thumbs">
        {assets.map((a) => (
          <button key={a.id} type="button" className="studio-thumb" aria-pressed={a.id === id} onClick={() => onChange(`asset:${a.id}`)} aria-label="Use this photo">
            <img src={a.url} alt="" />
          </button>
        ))}
        {value && (
          <button type="button" className="link-btn" onClick={() => onChange(null)}>
            No photo
          </button>
        )}
      </div>
      {!assets.length && <p className="fine">Add photos under Photos first.</p>}
      {onAlt && <Text label="Describe the photo (for screen readers and Google)" value={alt} max={140} onChange={onAlt} />}
    </fieldset>
  )
}
function Items({ label, items, fields, max = 10, onChange, blank }) {
  return (
    <fieldset className="field studio-group">
      <legend>{label}</legend>
      {items.map((it, i) => (
        <div key={i} className="studio-item">
          {fields.map(([k, l, m, area]) => (
            <Text key={k} label={l} value={it[k]} max={m} area={area} onChange={(v) => onChange(items.map((x, j) => (j === i ? { ...x, [k]: v } : x)))} />
          ))}
          <div className="studio-item-actions">
            <button type="button" className="link-btn" disabled={i === 0} onClick={() => onChange(items.map((x, j, a) => (j === i - 1 ? a[i] : j === i ? a[i - 1] : x)))}>
              Move up
            </button>
            <button type="button" className="link-btn" onClick={() => onChange(items.filter((_, j) => j !== i))}>
              Remove
            </button>
          </div>
        </div>
      ))}
      {items.length < max && (
        <button type="button" className="btn btn-quiet btn-sm" onClick={() => onChange([...items, blank])}>
          Add
        </button>
      )}
    </fieldset>
  )
}

// ---------- section ----------
function SectionEditor({ section: s, site, page, services, assets, focus, onChange, onServices }) {
  const set = (k) => (v) => onChange((x) => (v === null ? delete x[k] : (x[k] = v)))
  const head = (
    <>
      {'eyebrow' in s && <Text label="Small heading" value={s.eyebrow} max={60} autoFocus={focus === 'eyebrow'} onChange={set('eyebrow')} />}
      <Text label="Heading" value={s.heading} max={120} autoFocus={focus === 'heading'} onChange={set('heading')} />
      {s.type !== 'text' && s.type !== 'imageText' && <Text label="Text" value={s.text} max={900} area autoFocus={focus === 'text'} onChange={set('text')} />}
    </>
  )
  return (
    <div className="studio-section">
      <h3>{SECTION_LABEL[s.type]}</h3>
      {s.type === 'composition' ? <p className="fine">This opening was arranged by the AI designer. Edit its words, buttons and photos here; ask the designer to change the arrangement.</p> : head}
      {s.type === 'composition' &&
        s.blocks.map((b, i) =>
          b.kind === 'heading' || b.kind === 'text' ? (
            <Text key={i} label={b.kind === 'heading' ? 'Heading' : 'Text'} value={b.text} max={b.kind === 'heading' ? 120 : 400} area={b.kind === 'text'} autoFocus={focus === (b.kind === 'heading' ? 'heading' : 'text') && i === s.blocks.findIndex((x) => x.kind === b.kind)} onChange={(v) => onChange((x) => (x.blocks[i].text = v))} />
          ) : b.kind === 'button' ? (
            <ButtonFields key={i} title="Button" cta={{ label: b.label, target: b.target }} site={site} page={page} autoFocus={focus === 'button'} onChange={(c) => onChange((x) => Object.assign(x.blocks[i], c))} />
          ) : b.kind === 'media' ? (
            <ImageField key={i} label="Photo" value={b.image} alt={b.alt} assets={assets} onChange={(v) => v && onChange((x) => (x.blocks[i].image = v))} onAlt={(v) => onChange((x) => (x.blocks[i].alt = v))} focus={b.focus} aspect={b.aspect} onFocus={(v) => onChange((x) => (x.blocks[i].focus = v))} onAspect={(v) => onChange((x) => (x.blocks[i].aspect = v))} />
          ) : null,
        )}
      {s.type === 'hero' && (
        <>
          <ButtonFields title="Main button" cta={s.primaryCta} site={site} page={page} autoFocus={focus === 'button'} onChange={set('primaryCta')} />
          <ButtonFields title="Second button" cta={s.secondaryCta} site={site} page={page} removable onChange={set('secondaryCta')} />
          <ImageField label="Photo" value={s.image} alt={s.imageAlt} assets={assets} onChange={set('image')} onAlt={set('imageAlt')} focus={s.imageFocus} aspect={s.imageAspect} onFocus={set('imageFocus')} onAspect={set('imageAspect')} />
        </>
      )}
      {(s.type === 'text' || s.type === 'imageText') && <Text label="Text" value={s.body} max={2400} area autoFocus={focus === 'text'} onChange={set('body')} />}
      {s.type === 'imageText' && (
        <>
          <ImageField label="Photo" value={s.image} alt={s.imageAlt} assets={assets} onChange={set('image')} onAlt={set('imageAlt')} focus={s.imageFocus} aspect={s.imageAspect} onFocus={set('imageFocus')} onAspect={set('imageAspect')} />
          <Choice label="Photo side" value={s.imageSide} options={[['left', 'Left'], ['right', 'Right']]} onChange={set('imageSide')} />
          <ButtonFields title="Button" cta={s.cta} site={site} page={page} removable onChange={set('cta')} />
        </>
      )}
      {s.type === 'services' && (
        <fieldset className="field studio-group">
          <legend>Services</legend>
          <p className="fine">Names and prices are shared by your whole website and booking page.</p>
          {s.items.map((it, i) => {
            const k = (services || []).findIndex((v) => v.id === it.serviceId)
            const svc = services?.[k]
            if (!svc) return null
            return (
              <div key={it.serviceId} className="studio-item">
                <Text label="Service" value={svc.name} max={60} onChange={(v) => onServices((l) => (l[k].name = v))} />
                <Text label="Price (optional)" value={svc.price} max={40} onChange={(v) => onServices((l) => (l[k].price = v))} />
                <Text label="Description on this page" value={it.text} max={400} area onChange={(v) => onChange((x) => (x.items[i].text = v))} />
              </div>
            )
          })}
          <label className="check">
            <input type="checkbox" checked={s.showPrices !== false} onChange={(e) => onChange((x) => (x.showPrices = e.target.checked))} /> Show prices
          </label>
        </fieldset>
      )}
      {s.type === 'features' && <Items label="Highlights" items={s.items} fields={[['title', 'Title', 80], ['text', 'Text', 400, true]]} onChange={set('items')} blank={{ icon: 'check', title: 'New highlight', text: '' }} />}
      {s.type === 'steps' && <Items label="Steps" items={s.items} fields={[['title', 'Step', 80], ['text', 'Text', 400, true]]} onChange={set('items')} blank={{ title: 'New step', text: '' }} />}
      {s.type === 'faq' && <Items label="Questions" items={s.items} fields={[['question', 'Question', 80], ['answer', 'Answer', 400, true]]} onChange={set('items')} blank={{ question: 'New question?', answer: 'Answer.' }} />}
      {s.type === 'gallery' && (
        <fieldset className="field studio-group">
          <legend>Photos in the gallery</legend>
          <div className="studio-thumbs">
            {assets.map((a) => {
              const ref = `asset:${a.id}`
              const on = s.images.includes(ref)
              return (
                <button key={a.id} type="button" className="studio-thumb" aria-pressed={on} aria-label={on ? 'Remove from gallery' : 'Add to gallery'} onClick={() => onChange((x) => (x.images = on ? x.images.filter((v) => v !== ref) : [...x.images, ref].slice(0, 12)))}>
                  <img src={a.url} alt="" />
                </button>
              )
            })}
          </div>
        </fieldset>
      )}
      {s.type === 'cta' && <ButtonFields title="Button" cta={s.cta} site={site} page={page} autoFocus={focus === 'button'} onChange={set('cta')} />}
      {s.type === 'cta' && s.layout === 'split' && <ImageField label="Photo" value={s.image} assets={assets} onChange={set('image')} focus={s.imageFocus} aspect={s.imageAspect} onFocus={set('imageFocus')} onAspect={set('imageAspect')} />}
      {s.type === 'contact' && (
        <>
          <Choice label="Form" value={s.form || 'none'} options={[['none', 'No form (booking button only)'], ['contact', 'Contact form'], ['quote', 'Quote-request form']]} onChange={set('form')} />
          <label className="check">
            <input type="checkbox" checked={Boolean(s.showPhone)} onChange={(e) => onChange((x) => (x.showPhone = e.target.checked))} /> Show your phone number
          </label>
          <p className="fine">Messages arrive with your other leads. Your phone number and service area come from Business details.</p>
        </>
      )}
      {s.type === 'area' && <p className="fine">The towns listed come from Business details.</p>}
      {LAYOUTS[s.type] && <Choice label="Layout" value={s.layout} options={LAYOUTS[s.type]} onChange={set('layout')} />}
      {s.type !== 'composition' && <Choice label="Background" value={s.background === 'image' ? 'ink' : s.background} options={BACKGROUNDS} onChange={set('background')} />}
    </div>
  )
}

// ---------- page ----------
function PageEditor({ site, page, pageIndex, selected, biz, onSelect, onPage, onSite, onGo }) {
  const [adding, setAdding] = useState('')
  const [newPage, setNewPage] = useState('')
  const [service, setService] = useState('')
  const move = (i, d) => onPage((p) => p.sections.splice(i + d, 0, p.sections.splice(i, 1)[0]))
  return (
    <div className="studio-page-panel">
      <h3>Sections on {page.navLabel}</h3>
      <ol className="studio-sections">
        {page.sections.map((s, i) => (
          <li key={s.id} className={s.id === selected ? 'is-selected' : ''}>
            <button type="button" className="studio-section-name" onClick={() => onSelect(s.id)}>
              {SECTION_LABEL[s.type]}
              {s.heading ? `: ${s.heading.slice(0, 40)}` : ''}
              {s.hidden ? ' (hidden)' : ''}
            </button>
            <span className="studio-section-actions">
              <button type="button" className="link-btn" disabled={i === 0 || (pageIndex === 0 && i === 1)} onClick={() => move(i, -1)} aria-label={`Move ${SECTION_LABEL[s.type]} up`}>
                Up
              </button>
              <button type="button" className="link-btn" disabled={i === page.sections.length - 1 || (pageIndex === 0 && i === 0)} onClick={() => move(i, 1)} aria-label={`Move ${SECTION_LABEL[s.type]} down`}>
                Down
              </button>
              {!(pageIndex === 0 && i === 0) && (
                <button type="button" className="link-btn" onClick={() => onPage((p) => (p.sections[i].hidden ? delete p.sections[i].hidden : (p.sections[i].hidden = true)))}>
                  {s.hidden ? 'Show' : 'Hide'}
                </button>
              )}
              <button
                type="button"
                className="link-btn"
                onClick={() =>
                  onSite((st) => {
                    const copy = clone(st.pages[pageIndex].sections[i])
                    copy.id = newId(copy.type, takenIds(st))
                    st.pages[pageIndex].sections.splice(i + 1, 0, copy)
                  })
                }
              >
                Duplicate
              </button>
              {!(pageIndex === 0 && i === 0) && (
                <button type="button" className="link-btn" onClick={() => window.confirm('Remove this section? You can undo this.') && onPage((p) => p.sections.splice(i, 1))}>
                  Remove
                </button>
              )}
            </span>
          </li>
        ))}
      </ol>
      <div className="studio-add">
        <Choice label="Add a section" value={adding} options={[['', 'Choose…'], ...ADDABLE.map((t) => [t, SECTION_LABEL[t]])]} onChange={setAdding} />
        <button
          type="button"
          className="btn btn-sm"
          disabled={!adding}
          onClick={() => {
            onSite((st) => {
              const s = sectionTemplate(adding, biz, newId(adding, takenIds(st)))
              const at = selected ? st.pages[pageIndex].sections.findIndex((x) => x.id === selected) + 1 : st.pages[pageIndex].sections.length
              st.pages[pageIndex].sections.splice(at || st.pages[pageIndex].sections.length, 0, s)
            })
            setAdding('')
          }}
        >
          Add section
        </button>
      </div>

      <h3>Page settings</h3>
      <Text label="Name in the menu" value={page.navLabel} max={24} onChange={(v) => onPage((p) => (p.navLabel = v))} />
      <p className="fine">Address: {page.slug ? `/${page.slug}` : '/ (home page)'}</p>
      <Text label="Title in Google" value={page.seoTitle} max={70} onChange={(v) => onPage((p) => (p.seoTitle = v))} hint="Shown as the link in search results and browser tabs." />
      <Text label="Description in Google" value={page.seoDescription} max={160} area onChange={(v) => onPage((p) => (p.seoDescription = v))} />

      <h3>Pages</h3>
      <ol className="studio-sections">
        {site.pages.map((p, i) => (
          <li key={p.slug} className={i === pageIndex ? 'is-selected' : ''}>
            <button type="button" className="studio-section-name" onClick={() => onGo(p.slug)}>
              {p.navLabel}
            </button>
            {i > 0 && (
              <span className="studio-section-actions">
                <button type="button" className="link-btn" disabled={i === 1} onClick={() => onSite((st) => st.pages.splice(i - 1, 0, st.pages.splice(i, 1)[0]))} aria-label={`Move ${p.navLabel} earlier in the menu`}>
                  Up
                </button>
                <button type="button" className="link-btn" disabled={i === site.pages.length - 1} onClick={() => onSite((st) => st.pages.splice(i + 1, 0, st.pages.splice(i, 1)[0]))} aria-label={`Move ${p.navLabel} later in the menu`}>
                  Down
                </button>
                <button
                  type="button"
                  className="link-btn"
                  onClick={() => {
                    if (!window.confirm(`Delete the ${p.navLabel} page? Buttons that pointed to it will go to your booking page instead. You can undo this.`)) return
                    onSite((st) => st.pages.splice(i, 1))
                    onGo('')
                  }}
                >
                  Delete
                </button>
              </span>
            )}
          </li>
        ))}
      </ol>
      {site.pages.length < 10 && (
        <div className="studio-add">
          <Choice label="Add a page" value={newPage} options={[['', 'Choose…'], ...PAGE_TYPES]} onChange={setNewPage} />
          {newPage === 'service' && <Choice label="Which service" value={service} options={[['', 'Choose…'], ...biz.services.map((s) => [s.id, s.name])]} onChange={setService} />}
          <button
            type="button"
            className="btn btn-sm"
            disabled={!newPage || (newPage === 'service' && !service)}
            onClick={() => {
              const made = pageTemplate(newPage, biz, site, { service: biz.services.find((s) => s.id === service) })
              setNewPage('')
              setService('')
              if (!made) return
              onSite((st) => st.pages.push(clone(made)))
              onGo(made.slug)
            }}
          >
            Add page
          </button>
        </div>
      )}
    </div>
  )
}

// ---------- look ----------
function LookEditor({ site, onSite, services, onServices }) {
  const t = site.theme
  const tone = toneOf(t.colors) || 'custom'
  const pair = FONT_PAIRS.find(([h, b]) => h === t.headingFont && b === t.bodyFont)
  return (
    <div className="studio-look">
      <h3>Colours</h3>
      <Choice label="Background" value={tone} options={[...(tone === 'custom' ? [['custom', 'Current (from your design)']] : []), ['light', 'Light'], ['warm', 'Warm'], ['cool', 'Cool'], ['dark', 'Dark']]} onChange={(v) => v !== 'custom' && onSite((st) => (st.theme.colors = colorsFor(v, st.theme.colors.accent)))} />
      <label className="field">
        <span>Brand colour</span>
        <input type="color" value={t.colors.accent} onChange={(e) => onSite((st) => (st.theme.colors = { ...st.theme.colors, accent: e.target.value, accentText: e.target.value, onAccent: colorsFor('light', e.target.value).onAccent }))} />
        <span className="fine">Text colours are adjusted automatically so everything stays readable.</span>
      </label>
      <h3>Type and buttons</h3>
      <Choice label="Fonts" value={pair ? `${pair[0]}|${pair[1]}` : 'current'} options={[...(pair ? [] : [['current', 'Current (from your design)']]), ...FONT_PAIRS.map(([h, b, l]) => [`${h}|${b}`, l])]} onChange={(v) => v !== 'current' && onSite((st) => ([st.theme.headingFont, st.theme.bodyFont] = v.split('|')))} />
      <Choice label="Buttons" value={t.buttons} options={BUTTONS} onChange={(v) => onSite((st) => (st.theme.buttons = v))} />
      <Choice label="Corners" value={String(t.radius <= 2 ? 0 : t.radius <= 10 ? 8 : t.radius <= 18 ? 14 : 24)} options={[['0', 'Square'], ['8', 'Slightly rounded'], ['14', 'Rounded'], ['24', 'Very rounded']]} onChange={(v) => onSite((st) => (st.theme.radius = Number(v)))} />
      <h3>Footer</h3>
      <Text label="Footer line" value={site.footer.text} max={200} onChange={(v) => onSite((st) => (st.footer.text = v))} />
      <h3>Services and prices</h3>
      <p className="fine">Shared by your website and booking page.</p>
      {(services || []).map((s, i) => (
        <div key={s.id || i} className="studio-item">
          <Text label="Service" value={s.name} max={60} onChange={(v) => onServices((l) => (l[i].name = v))} />
          <Text label="Price (optional)" value={s.price} max={40} onChange={(v) => onServices((l) => (l[i].price = v))} />
          <button type="button" className="link-btn" onClick={() => window.confirm(`Remove ${s.name}?`) && onServices((l) => l.splice(i, 1))}>
            Remove service
          </button>
        </div>
      ))}
      {(services || []).length < 12 && (
        <button type="button" className="btn btn-quiet btn-sm" onClick={() => onServices((l) => l.push({ name: 'New service', price: '', description: '' }))}>
          Add a service
        </button>
      )}
    </div>
  )
}

// ---------- photos ----------
function PhotosPanel({ assets, variants, onAdded, onRemoved, onReload }) {
  const [state, setState] = useState({})
  const used = assets.reduce((n, a) => n + (a.size || 0), 0)
  const copies = new Set(Object.values(variants || {}))
  const photos = assets.filter((a) => !copies.has(a.id))
  const missing = photos.filter((a) => !variants?.[a.id])
  const pick = async (e) => {
    const files = [...(e.target.files || [])]
    e.target.value = ''
    // One edit for the whole batch (each photo's phone copy recorded together; never one overwriting another).
    const added = []
    let error = null
    for (const file of files) {
      if (file.size > 10 * 1024 * 1024) {
        error = `${file.name} is larger than 10 MB. Choose a smaller photo.`
        continue
      }
      setState({ busy: 'Uploading…' })
      const r = await uploadPhotoWithCopy(file)
      if (r.asset) added.push({ asset: { ...r.asset, createdAt: Date.now() }, small: r.small })
      if (r.error) error = r.error
    }
    if (added.length) onAdded(added)
    setState(error ? { error } : {})
  }
  const remove = async (id) => {
    const { status, data } = await api('/api/dashboard/website/assets', { method: 'POST', body: { action: 'delete', id } })
    if (status === 200) onRemoved(id)
    else setState({ error: data?.error === 'in_use' ? 'That photo is used on your website (draft, live version, a saved version or an earlier draft). Replace it there first.' : 'Couldn’t remove that photo.' })
  }
  // Phone-sized copies for photos uploaded before copies existed (made in this browser from our own copy).
  const makeCopies = async () => {
    const made = []
    let failed = 0
    for (const [i, a] of missing.entries()) {
      setState({ busy: `Making phone versions… ${i + 1} of ${missing.length}` })
      const r = await makePhoneCopy(a.id)
      if (r.small) made.push({ asset: a, small: r.small, existing: true })
      else failed++
    }
    if (made.length) onAdded(made)
    setState(failed ? { error: `Phone versions made for ${made.length} photos; ${failed} couldn’t be made (try again later).` } : { note: `Phone versions made for ${made.length} photo${made.length === 1 ? '' : 's'}.` })
  }
  const cleanup = async () => {
    if (!window.confirm('Remove every photo that isn’t used anywhere (your draft, your live website, saved versions or earlier drafts)? Photos in use are kept.')) return
    setState({ busy: 'Removing unused photos…' })
    const { status, data } = await api('/api/dashboard/website/assets', { method: 'POST', body: { action: 'cleanup' } })
    if (status !== 200) return setState({ error: 'Couldn’t remove unused photos. Please try again.' })
    await onReload()
    setState({ note: data.removed ? `Removed ${data.removed} unused file${data.removed === 1 ? '' : 's'} (${(data.bytesFreed / 1048576).toFixed(1)} MB freed). Photos in use were kept.` : 'Every photo is in use; nothing was removed.' })
  }
  return (
    <div className="studio-photos">
      <p className="fine">
        {photos.length} photos · {(used / 1048576).toFixed(1)} of 50 MB used. Photos are resized before they’re stored, with a smaller copy for phones. Videos aren’t hosted.
      </p>
      <div className="studio-photo-actions">
        <label className="btn btn-sm">
          {state.busy && state.busy.startsWith('Uploading') ? state.busy : 'Upload photos'}
          <input type="file" accept="image/*" multiple className="sr-only" onChange={pick} disabled={Boolean(state.busy)} />
        </label>
        {missing.length > 0 && (
          <button type="button" className="btn btn-quiet btn-sm" onClick={makeCopies} disabled={Boolean(state.busy)}>
            Make phone versions ({missing.length})
          </button>
        )}
        <button type="button" className="link-btn" onClick={cleanup} disabled={Boolean(state.busy)}>
          Remove unused photos
        </button>
      </div>
      {state.busy && !state.busy.startsWith('Uploading') && (
        <p className="fine" role="status">
          {state.busy}
        </p>
      )}
      {state.note && (
        <p className="fine" role="status">
          {state.note}
        </p>
      )}
      {state.error && (
        <p className="form-error" role="alert">
          {state.error}
        </p>
      )}
      <ul className="studio-thumbs studio-thumbs--list">
        {photos.map((a) => (
          <li key={a.id}>
            <img src={a.url} alt="" />
            <span className="fine">{variants?.[a.id] ? 'Phone version ready' : 'No phone version'}</span>
            <button type="button" className="link-btn" onClick={() => remove(a.id)}>
              Remove
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

// ---------- history ----------
const REASON = { autosave: 'Saved while editing', published: 'Published', before_restore: 'Before a restore' }
function HistoryPanel({ checkpoints, busy, onRestore }) {
  const when = (t) => new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
  return (
    <div className="studio-history-panel">
      <p className="fine">Earlier versions of your draft, saved automatically (the newest 20 are kept). Restoring one changes only your draft.</p>
      {busy && <p className="fine">Waiting for your latest changes to save…</p>}
      {!checkpoints.length && <p className="fine">No earlier versions yet. One is saved every 10 minutes while you edit, and when you publish.</p>}
      <ol className="studio-sections">
        {checkpoints.map((c) => (
          <li key={c.id}>
            <span>
              <strong>{when(c.createdAt)}</strong>
              <span className="fine"> · {REASON[c.reason] || 'Saved'} · {c.pages} page{c.pages === 1 ? '' : 's'}</span>
            </span>
            <button type="button" className="link-btn" disabled={busy} onClick={() => onRestore(c.id)}>
              Restore
            </button>
          </li>
        ))}
      </ol>
    </div>
  )
}
