// Website Studio editor for an AI-designed site (content.site): edit without AI. Click anything in the live preview to
// edit that section; manage sections and pages; change the look. Every change re-renders the preview from the server
// (POST /api/dashboard/website/preview: validated like a save, nothing stored) and autosaves (debounced) with optimistic
// concurrency (baseUpdatedAt → 409 conflict, never a silent overwrite). Undo/redo for the session; unsaved changes are
// kept in this browser until the server confirms them. The server validates every save (it is the trust boundary).
import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState } from 'react'
import { api } from '../lib/api.js'
import { makePhoneCopy, uploadImage, uploadPhotoWithCopy } from '../lib/images.js'
import { ADDABLE, BACKGROUNDS, BUTTONS, FONT_PAIRS, LAYOUTS, PAGE_TYPES, SECTION_LABEL, colorsFor, newId, pageTemplate, sectionTemplate, takenIds, toneOf } from './site-templates.js'
import { draftPlaces, replacePhoto, usageText } from './photo-refs.js'

const clone = (v) => JSON.parse(JSON.stringify(v))
// Per-viewer conveniences, per business (storeKey). Every read and write is wrapped: private mode or blocked storage
// just means nothing is remembered; the server copy stays the source of truth.
const LEGACY_BACKUP = 'gsu-studio-unsaved' // before 2026-11-19: one key for every business
const store = (kind) => ({
  read(key) {
    try {
      return JSON.parse(kind().getItem(key) || 'null')
    } catch {
      return null
    }
  },
  write(key, v) {
    try {
      if (v) kind().setItem(key, JSON.stringify(v))
      else kind().removeItem(key)
    } catch {
      /* storage unavailable or full: nothing is remembered */
    }
  },
})
const local = store(() => window.localStorage)
const session = store(() => window.sessionStorage)

// Browser history for Studio's layers (full screen, the photo/button panel, a section menu): each open layer is one
// history entry, so Back closes the top layer before leaving Studio; closing a layer from the page removes its entry,
// and Forward into an entry whose layer was closed never re-opens it. Layers are numbered by depth (history.state).
const Layers = createContext(null)
function useHistoryLayers() {
  const open = useRef([]) // [{ id, depth, close }]
  const skip = useRef(0)
  useEffect(() => {
    const onPop = (e) => {
      if (skip.current > 0) return void (skip.current -= 1)
      const depth = e.state?.gsuStudio || 0
      while (open.current.length && open.current.at(-1).depth > depth) open.current.pop().close()
      if (depth > open.current.length) {
        // Forward into an entry whose layer was closed: step straight back (nothing re-opens, and no duplicate entries
        // pile up that would make Back need extra presses to leave Studio).
        skip.current += 1
        window.history.go(-(depth - open.current.length))
      }
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])
  return useMemo(
    () => ({
      push(id, close, url) {
        if (open.current.some((l) => l.id === id)) return
        const depth = open.current.length + 1
        const st = window.history.state || {}
        open.current.push({ id, depth, close })
        // A reload keeps history.state: the entry for this layer is already there, so it's adopted, not pushed again.
        if (st.gsuStudio === depth && st.gsuLayer === id) return
        try {
          window.history.pushState({ ...st, gsuStudio: depth, gsuLayer: id }, '', url ?? window.location.href)
        } catch {
          // history unavailable: the layer still opens and closes from the page
        }
      },
      pop(id) {
        const i = open.current.findIndex((l) => l.id === id)
        if (i < 0) return
        const [first] = open.current.splice(i)
        // Only step back over our own entries (after a dashboard tab change the current entry isn't ours).
        const here = window.history.state?.gsuStudio || 0
        const n = here - (first.depth - 1)
        if (n > 0 && here >= first.depth) {
          skip.current += 1
          window.history.go(-n)
        }
      },
    }),
    [],
  )
}
function useBackLayer(id, isOpen, close, url) {
  const layers = useContext(Layers)
  const closeRef = useRef(close)
  useEffect(() => {
    closeRef.current = close
  })
  useEffect(() => {
    if (!isOpen || !layers) return undefined
    layers.push(id, () => closeRef.current(), url)
    return () => layers.pop(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one entry per opening
  }, [isOpen, id, layers])
}
const urlWithFull = (on) => {
  try {
    const u = new URL(window.location.href)
    if (on) u.searchParams.set('full', '1')
    else u.searchParams.delete('full')
    return u.toString()
  } catch {
    return undefined
  }
}
const REMOVED = { claim: 'a claim we can’t verify (for example a rating or guarantee) was left out', too_long: 'a text was shortened to fit', link: 'a link outside your website was changed to “Book”', image: 'a photo that isn’t yours was removed', invented_number: 'a number that isn’t in your details was left out' }

export default function SiteStudio(props) {
  const layers = useHistoryLayers()
  return (
    <Layers.Provider value={layers}>
      <StudioEditor {...props} />
    </Layers.Provider>
  )
}

// What this browser remembers for this business: unsaved edits (localStorage, until the server confirms them) and where
// the owner was (sessionStorage, this browser tab only): page, section, panel tab, mode, preview size, preview scroll.
function startState(website, storeKey) {
  const backupKey = `gsu-studio-unsaved:${storeKey || 'site'}`
  const uiKey = `gsu-studio-ui:${storeKey || 'site'}`
  const serverBase = website.updatedAt ?? null
  let backup = local.read(backupKey)
  if (!backup) {
    // One-time move from the old shared key: only when it was made from this very server copy.
    const old = local.read(LEGACY_BACKUP)
    if (old && old.base === serverBase) backup = old
    local.write(LEGACY_BACKUP, null)
  }
  const differs = backup?.content && JSON.stringify(backup.content) !== JSON.stringify(website.draft)
  // Same server copy as when the edits were made: bring them back at once (they autosave as usual). The server copy
  // changed since (another tab, the designer, a restore): ask, and keeping them goes through the conflict check.
  const resumed = differs && backup.base === serverBase && backup.content?.site ? backup : null
  const ask = differs && !resumed && backup.content?.site ? backup : null
  if (!differs) local.write(backupKey, null)
  const ui = session.read(uiKey) || {}
  const draft = resumed ? resumed.content : website.draft
  const pages = draft.site?.pages || []
  const slug = pages.some((p) => p.slug === ui.slug) ? ui.slug : ''
  const pg = pages.find((p) => p.slug === slug)
  return {
    backupKey,
    uiKey,
    content: clone(draft),
    resumed: Boolean(resumed),
    ask,
    ui: {
      slug,
      selected: pg?.sections?.some((s) => s.id === ui.selected) ? ui.selected : null,
      tab: ['section', 'page', 'site', 'photos', 'history'].includes(ui.tab) ? ui.tab : 'section',
      mode: ui.mode === 'preview' ? 'preview' : 'edit',
      device: ['desktop', 'tablet', 'phone'].includes(ui.device) ? ui.device : null,
      scroll: ui.scroll && typeof ui.scroll === 'object' ? ui.scroll : {},
    },
  }
}

function StudioEditor({ website, assets: initialAssets, brand, visit, checkpoints = [], storeKey, onSaved, onUnsaved }) {
  const start = useMemo(() => startState(website, storeKey), []) // eslint-disable-line react-hooks/exhaustive-deps -- once per editor
  const writeBackup = useCallback((v) => local.write(start.backupKey, v), [start])
  const [content, setContent] = useState(start.content)
  const [base, setBase] = useState(website.updatedAt ?? null)
  const [past, setPast] = useState([])
  const [future, setFuture] = useState([])
  const [slug, setSlug] = useState(start.ui.slug)
  const [selected, setSelected] = useState(start.ui.selected) // section id | 'nav' | 'footer'
  const [focus, setFocus] = useState(null)
  const [tab, setTab] = useState(start.ui.tab)
  const [device, setDevice] = useState(() => start.ui.device || (typeof window !== 'undefined' && window.innerWidth < 700 ? 'phone' : 'desktop'))
  const [save, setSave] = useState({ state: start.resumed ? 'pending' : 'saved' })
  const [html, setHtml] = useState('')
  const [removed, setRemoved] = useState([])
  const [assets, setAssets] = useState(initialAssets || [])
  const [restore, setRestore] = useState(start.ask)
  const [resumed, setResumed] = useState(start.resumed)
  const frame = useRef(null)
  const dirty = useRef(start.resumed)

  const site = content.site
  const pageIndex = Math.max(0, site.pages.findIndex((p) => p.slug === slug))
  const page = site.pages[pageIndex]
  const sectionIndex = page.sections.findIndex((s) => s.id === selected)
  const section = sectionIndex >= 0 ? page.sections[sectionIndex] : null
  // Photos to choose from: the owner's photos, not their phone-sized copies (content.variants values) and never a logo
  // (current or earlier: the server marks them), which belongs in the header, not in a photo slot.
  const photoAssets = useMemo(() => {
    const copies = new Set(Object.values(content.variants || {}))
    return assets.filter((a) => !copies.has(a.id) && !a.logo && a.id !== content.logo)
  }, [assets, content.variants, content.logo])
  const biz = useMemo(
    () => ({ name: brand || 'Our business', services: content.services || [], area: content.area || '', about: content.about || '', photos: photoAssets.map((a) => a.id), visit: Boolean(visit) }),
    [brand, visit, content.services, content.area, content.about, photoAssets],
  )

  // One edit = one undo step (up to 50). `fn` changes a deep copy of the current content. `merge`: typing in the same
  // place within a couple of seconds stays one step (a word typed is undone at once, not letter by letter).
  const lastMerge = useRef({ key: null, at: 0 })
  const change = (fn, { merge = null } = {}) => {
    const next = clone(content)
    fn(next)
    const now = Date.now()
    const same = merge && lastMerge.current.key === merge && now - lastMerge.current.at < 2000
    lastMerge.current = { key: merge, at: now }
    if (!same) setPast((p) => [...p.slice(-49), content])
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

  // Live preview of the unsaved content (validated and rendered by the server; nothing stored). While the owner types
  // directly in the page the preview isn't replaced (it would lose their cursor); it refreshes when they finish.
  const typing = useRef(null)
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (typing.current) return
    const t = setTimeout(async () => {
      const { status, data } = await api('/api/dashboard/website/preview', { method: 'POST', body: { content, page: page.slug } })
      if (status === 200) {
        setHtml(data.html)
        setRemoved(data.removed || [])
      }
    }, 250)
    return () => clearTimeout(t)
  }, [content, page.slug, tick])

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
    [content, base, onSaved, writeBackup],
  )
  useEffect(() => {
    if (!dirty.current) return
    writeBackup({ base, content })
    setSave({ state: 'pending' })
    const t = setTimeout(() => saveNow(), 800)
    return () => clearTimeout(t)
  }, [content, base, saveNow, writeBackup])
  useEffect(() => {
    if (save.state !== 'failed' || !save.retrying) return
    const t = setTimeout(() => saveNow(), [2000, 5000, 10000][attempt.current - 1] || 10000)
    return () => clearTimeout(t)
  }, [save, saveNow])
  // The browser tab is hidden (another tab, the phone's home screen) with edits waiting: save them now, not after the
  // debounce (a hidden tab's timers may be slowed or the page discarded). Unsaved edits are in local storage anyway.
  useEffect(() => {
    const onHide = () => document.visibilityState === 'hidden' && dirty.current && save.state === 'pending' && saveNow()
    document.addEventListener('visibilitychange', onHide)
    return () => document.removeEventListener('visibilitychange', onHide)
  }, [save.state, saveNow])
  // Tell the dashboard while edits aren't server-confirmed yet (it holds Publish until they are).
  useEffect(() => {
    onUnsaved?.(save.state !== 'saved')
  }, [save.state, onUnsaved])
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

  // ---- Editing in the page itself ----
  // The preview is a same-origin frame of the real website (which runs no script). This page makes its marked elements
  // editable from outside: text in place (data-edit), buttons and photos with a small panel (data-btn / data-img), and
  // sections with compact controls. "Preview" mode turns all of that off.
  const [mode, setMode] = useState(start.ui.mode)
  // Full screen: the same editor filling the browser window (also reachable as its own tab: /dashboard/website?full=1).
  // It is one browser-history entry: Back (or Escape, or the Exit button) leaves full screen before leaving Studio.
  const [full, setFull] = useState(() => {
    if (typeof window === 'undefined' || new URLSearchParams(window.location.search).get('full') !== '1') return false
    // Opened as /dashboard/website?full=1 without its history entry (a link, a new tab): the entry underneath becomes
    // the plain editor, so Back leaves full screen first instead of leaving the dashboard.
    const st = window.history.state || {}
    if (!(st.gsuStudio === 1 && st.gsuLayer === 'full')) {
      try {
        window.history.replaceState({ ...st, gsuStudio: 0, gsuLayer: null }, '', urlWithFull(false))
      } catch {
        // history unavailable: full screen still works from the page
      }
    }
    return true
  })
  const fullButton = useRef(null)
  const toggleFull = (on) => {
    setFull(on)
    // Leaving full screen puts focus back on the control that opened it (never lost behind the closed layer).
    if (!on) setTimeout(() => fullButton.current?.focus(), 0)
  }
  useBackLayer('full', full, () => toggleFull(false), urlWithFull(true))
  useEffect(() => {
    if (!full) return undefined
    // Escape leaves full screen unless a field is being edited or a panel/menu is open (Escape closes that first).
    const onKey = (e) => e.key === 'Escape' && !e.target.closest?.('[contenteditable],input,textarea,select') && !document.querySelector('.studio-pop, .studio-menu') && toggleFull(false)
    document.addEventListener('keydown', onKey)
    document.body.classList.add('studio-full-open')
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.classList.remove('studio-full-open')
    }
  }, [full])
  const [hover, setHover] = useState(null) // { id, rect }
  const [selRect, setSelRect] = useState(null)
  const [pop, setPop] = useState(null) // { kind: 'btn'|'img', sid, path, rect }
  useBackLayer('pop', Boolean(pop), () => setPop(null))
  // Escape pressed while focus is inside the preview frame (its key events don't reach this page): the same order as
  // on the page — the open panel first, then full screen.
  const escapeRef = useRef(null)
  useEffect(() => {
    escapeRef.current = () => (pop ? setPop(null) : full ? toggleFull(false) : null)
  })
  const modeRef = useRef(mode)
  const selectedRef = useRef(selected)
  useEffect(() => {
    modeRef.current = mode
    selectedRef.current = selected
  }, [mode, selected])
  // Where the owner is, remembered for this browser tab (a tab switch, Back/Forward or a reload comes back to it).
  const scrollRef = useRef(start.ui.scroll)
  const slugRef = useRef(page.slug)
  const remember = useCallback(() => session.write(start.uiKey, { slug: slugRef.current, selected: selectedRef.current, tab: tabRef.current, mode: modeRef.current, device: deviceRef.current, scroll: scrollRef.current }), [start])
  const tabRef = useRef(tab)
  const deviceRef = useRef(device)
  useEffect(() => {
    slugRef.current = page.slug
    tabRef.current = tab
    deviceRef.current = device
    remember()
  }, [page.slug, selected, tab, mode, device, remember])
  useEffect(() => {
    const t = setInterval(remember, 1000) // scroll position (cheap; only this tab's sessionStorage)
    window.addEventListener('pagehide', remember)
    return () => {
      clearInterval(t)
      window.removeEventListener('pagehide', remember)
      remember()
    }
  }, [remember])
  const stage = useRef(null)
  const rectOf = (el) => {
    const f = frame.current
    if (!el || !f) return null
    const r = el.getBoundingClientRect()
    return { top: r.top + f.offsetTop, left: r.left + f.offsetLeft, width: r.width, height: r.height }
  }
  // Writes one edited value back into the draft: a section field (sid | dotted path) or a shared service (svc | id.field).
  const write = (sid, path, value, merge) =>
    change(
      (c) => {
        if (sid === 'svc') {
          const [id, field] = path.split('.')
          const svc = c.services.find((x) => x.id === id)
          if (svc) svc[field] = value
          return
        }
        const sec = c.site.pages[pageIndex].sections.find((x) => x.id === sid)
        if (!sec) return
        const keys = path.split('.')
        let o = sec
        for (const k of keys.slice(0, -1)) o = o?.[/^\d+$/.test(k) ? Number(k) : k]
        if (o) o[keys.at(-1)] = value
      },
      { merge },
    )
  const readAt = (sid, path) => {
    const sec = page.sections.find((x) => x.id === sid)
    return path.split('.').reduce((o, k) => o?.[/^\d+$/.test(k) ? Number(k) : k], sec)
  }
  const onFrameLoad = () => {
    const doc = frame.current?.contentDocument
    if (!doc) return
    const style = doc.createElement('style')
    style.id = 'ge-style'
    style.textContent = `[data-edit]{cursor:text;border-radius:3px;transition:box-shadow .12s}[data-edit]:hover{box-shadow:0 0 0 2px rgba(99,102,241,.45)}[data-edit][contenteditable]{outline:none;box-shadow:0 0 0 2px rgba(99,102,241,.9);background:rgba(99,102,241,.04)}[data-btn],[data-img]{cursor:pointer}[data-img]:hover{outline:2px solid rgba(99,102,241,.6);outline-offset:-2px}[data-btn]:hover{box-shadow:0 0 0 3px rgba(99,102,241,.45)}section[id]{scroll-margin-top:80px}`
    if (modeRef.current === 'edit') doc.head.appendChild(style)
    const sectionOf = (t) => t.closest?.('section[id]')
    doc.addEventListener('mousemove', (e) => {
      if (modeRef.current !== 'edit') return
      const sec = sectionOf(e.target)
      setHover(sec ? { id: sec.id, rect: rectOf(sec) } : null)
    })
    doc.addEventListener('mouseleave', () => setHover(null))
    // Text: editable in place on the first press, so the cursor lands where the owner clicked.
    doc.addEventListener('mousedown', (e) => {
      if (modeRef.current !== 'edit') return
      const el = e.target.closest('[data-edit]')
      if (el && !el.isContentEditable) {
        el.contentEditable = 'plaintext-only'
        if (el.contentEditable !== 'plaintext-only') el.contentEditable = 'true'
        el.spellcheck = true
      }
    })
    doc.addEventListener('click', (e) => {
      const a = e.target.closest('a')
      const pageLink = a?.getAttribute('href')?.match(/^#page=([a-z0-9-]*)$/)
      if (modeRef.current !== 'edit' || !e.target.closest('[data-edit]')) e.preventDefault()
      if (pageLink && a.closest('header.nav')) {
        setSlug(pageLink[1])
        setSelected(null)
        setPop(null)
        return
      }
      if (modeRef.current !== 'edit') return
      const sec = sectionOf(e.target)
      const btn = e.target.closest('[data-btn]')
      const img = e.target.closest('[data-img]')
      if (btn || img) {
        const [sid, path] = (btn || img).getAttribute(btn ? 'data-btn' : 'data-img').split('|')
        setPop({ kind: btn ? 'btn' : 'img', sid, path, rect: rectOf(btn || img) })
      } else if (!e.target.closest('[data-edit]')) setPop(null)
      if (e.target.closest('footer.foot')) {
        setSelected(null)
        setTab('site')
        return
      }
      if (sec) {
        setSelected(sec.id)
        setSelRect(rectOf(sec))
        if (!e.target.closest('[data-edit],[data-btn],[data-img]')) {
          setFocus(null)
          setTab('section')
        }
      }
    })
    doc.addEventListener('input', (e) => {
      const el = e.target.closest?.('[data-edit]')
      if (!el) return
      typing.current = el
      const [sid, path] = el.getAttribute('data-edit').split('|')
      const multi = /(^|\.)(body|text|answer)$/.test(path) && sid !== 'svc'
      const value = multi ? el.innerText.replace(/\n{3,}/g, '\n\n').trim() : el.innerText.replace(/\s+/g, ' ').trim()
      write(sid, path, value, `${sid}|${path}`)
    })
    doc.addEventListener('keydown', (e) => {
      const el = e.target.closest?.('[data-edit]')
      if (!el) {
        if (e.key === 'Escape') escapeRef.current?.()
        return
      }
      const multi = /(^|\.)(body|text|answer)$/.test(el.getAttribute('data-edit')) && !el.getAttribute('data-edit').startsWith('svc|')
      if (e.key === 'Escape' || (e.key === 'Enter' && !multi)) {
        e.preventDefault()
        el.blur()
      }
    })
    doc.addEventListener('focusout', (e) => {
      const el = e.target.closest?.('[data-edit]')
      if (!el) return
      el.removeAttribute('contenteditable')
      typing.current = null
      setTick((n) => n + 1)
    })
    doc.addEventListener('submit', (e) => e.preventDefault())
    // The preview re-renders after every edit (a new document): it keeps the owner's place on the page instead of
    // jumping back to the top, and the place is remembered per page for this browser tab.
    const win = frame.current.contentWindow
    const y = scrollRef.current[slugRef.current] || 0
    // Our own restoring scroll (and the browser's scroll anchoring while photos settle) isn't the owner scrolling: an
    // open panel stays open just after a re-render (they may be typing in it).
    const settled = Date.now() + 600
    if (y) win.scrollTo(0, y)
    const follow = () => {
      if (Date.now() >= settled) {
        setHover(null)
        setPop(null)
      }
      scrollRef.current = { ...scrollRef.current, [slugRef.current]: Math.round(win.scrollY) }
      const sel = selectedRef.current && doc.getElementById(selectedRef.current)
      setSelRect(sel ? rectOf(sel) : null)
    }
    win.addEventListener('scroll', follow, { passive: true })
    const sel = selected && doc.getElementById(selected)
    setSelRect(sel ? rectOf(sel) : null)
  }
  // Leaving edit mode, changing page or device: nothing stays selected on screen.
  useEffect(() => {
    setHover(null)
    setPop(null)
    if (mode !== 'edit') setSelRect(null)
  }, [mode, page.slug, device])

  const sectionAt = (id) => page.sections.findIndex((x) => x.id === id)
  const moveSection = (id, d) => editPage((p) => {
    const i = p.sections.findIndex((x) => x.id === id)
    const j = i + d
    if (i < 0 || j < 0 || j >= p.sections.length || (pageIndex === 0 && (i === 0 || j === 0))) return
    p.sections.splice(j, 0, p.sections.splice(i, 1)[0])
  })
  const toggleSection = (id) => editPage((p) => {
    const x = p.sections.find((y) => y.id === id)
    if (x.hidden) delete x.hidden
    else x.hidden = true
  })
  const duplicateSection = (id) => change((c) => {
    const p = c.site.pages[pageIndex]
    const i = p.sections.findIndex((x) => x.id === id)
    const copy = clone(p.sections[i])
    copy.id = newId(copy.type, takenIds(c.site))
    delete copy.hidden
    p.sections.splice(i + 1, 0, copy)
  })
  const removeSection = (id) => {
    if (!window.confirm('Remove this section? You can undo this.')) return
    editPage((p) => p.sections.splice(p.sections.findIndex((x) => x.id === id), 1))
    setSelected(null)
    setSelRect(null)
  }
  const addSectionAfter = (id, type) => {
    change((c) => {
      const p = c.site.pages[pageIndex]
      const s2 = sectionTemplate(type, biz, newId(type, takenIds(c.site)))
      const at = id ? p.sections.findIndex((x) => x.id === id) + 1 : p.sections.length
      p.sections.splice(at || p.sections.length, 0, s2)
    })
  }
  const actionsFor = (id) => {
    const i = sectionAt(id)
    const s2 = page.sections[i]
    if (!s2) return null
    const opener = pageIndex === 0 && i === 0
    return {
      label: SECTION_LABEL[s2.type],
      hidden: Boolean(s2.hidden),
      canUp: !opener && i > (pageIndex === 0 ? 1 : 0),
      canDown: !opener && i < page.sections.length - 1,
      canHide: !opener,
      canDuplicate: !['hero', 'composition'].includes(s2.type),
      canRemove: !opener,
      onUp: () => moveSection(id, -1),
      onDown: () => moveSection(id, 1),
      onToggle: () => toggleSection(id),
      onDuplicate: () => duplicateSection(id),
      onRemove: () => removeSection(id),
      onSettings: () => (setSelected(id), setTab('section')),
      onAdd: (type) => addSectionAfter(id, type),
    }
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

  const hoverActions = mode === 'edit' && hover && hover.id !== selected ? actionsFor(hover.id) : null
  const selActions = mode === 'edit' && selected && selRect ? actionsFor(selected) : null
  const popValue = pop ? readAt(pop.sid, pop.path) : null

  return (
    <section className={`studio${full ? ' studio--full' : ''}`} aria-label="Website Studio editor">
      <div className="studio-bar">
        <label className="studio-page">
          <span className="sr-only">Page</span>
          <select
            value={page.slug}
            onChange={(e) => {
              if (e.target.value === '__add') {
                setMode('edit')
                setTab('page')
                setTimeout(() => document.getElementById('studio-add-page')?.focus(), 50)
                return
              }
              setSlug(e.target.value)
              setSelected(null)
            }}
          >
            {site.pages.map((p) => (
              <option key={p.slug} value={p.slug}>
                {p.navLabel}
                {p.legal ? ' (legal page)' : ''}
              </option>
            ))}
            {site.pages.length < 10 && <option value="__add">+ Add a page…</option>}
          </select>
        </label>
        <div className="segmented segmented--sm" role="group" aria-label="Mode">
          <button type="button" aria-pressed={mode === 'edit'} onClick={() => setMode('edit')}>
            Edit
          </button>
          <button type="button" aria-pressed={mode === 'preview'} onClick={() => setMode('preview')}>
            Preview
          </button>
        </div>
        <div className="segmented segmented--sm" role="group" aria-label="Preview size">
          {['desktop', 'tablet', 'phone'].map((d) => (
            <button key={d} type="button" aria-pressed={device === d} onClick={() => setDevice(d)}>
              {{ desktop: 'Desktop', tablet: 'Tablet', phone: 'Phone' }[d]}
            </button>
          ))}
        </div>
        <button ref={fullButton} type="button" className={`studio-icon-btn${full ? ' studio-exit-full' : ''}`} aria-pressed={full} onClick={() => toggleFull(!full)} title={full ? 'Exit full screen (Esc)' : 'Edit in full screen'}>
          {full ? 'Exit full screen' : 'Full screen'}
        </button>
        <div className="studio-history">
          <button type="button" className="studio-icon-btn" onClick={undo} disabled={!past.length} title="Undo" aria-label="Undo">
            <Ico d="M9 14 4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11" /> Undo
          </button>
          <button type="button" className="studio-icon-btn" onClick={redo} disabled={!future.length} title="Redo" aria-label="Redo">
            <Ico d="m15 14 5-5-5-5M20 9H9.5a5.5 5.5 0 0 0 0 11H13" /> Redo
          </button>
        </div>
        <SaveState save={save} onRetry={() => saveNow()} />
      </div>
      {resumed && (
        <div className="studio-notice" role="status">
          <span>We brought back the changes you hadn’t saved yet.</span>
          <button
            type="button"
            className="link-btn"
            onClick={() => {
              setResumed(false)
              dirty.current = false
              writeBackup(null)
              setPast([])
              setFuture([])
              setContent(clone(website.draft))
              setBase(website.updatedAt ?? null)
              setSave({ state: 'saved' })
            }}
          >
            Discard them
          </button>
          <button type="button" className="link-btn" onClick={() => setResumed(false)}>
            OK
          </button>
        </div>
      )}
      {restore && (
        <div className="studio-notice" role="alert">
          <span>You have unsaved changes from an earlier visit, but your website was saved somewhere else since.</span>
          <button
            type="button"
            className="link-btn"
            onClick={() => {
              // Kept against the copy they were made from: the save then reports the conflict, and the owner chooses
              // (load the latest, or keep these). Never a silent overwrite of the newer copy.
              setPast((p) => [...p.slice(-49), content])
              setFuture([])
              dirty.current = true
              setBase(restore.base ?? null)
              setContent(clone(restore.content))
              setRestore(null)
            }}
          >
            Restore them
          </button>
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
        <div className="studio-notice studio-notice--warn" role="alert">
          <span>This website was changed in another window or by the AI designer.</span>
          <button type="button" className="link-btn" onClick={conflictLoadLatest}>
            Load the latest version
          </button>
          <button type="button" className="link-btn" onClick={conflictKeepMine}>
            Keep my version
          </button>
        </div>
      )}
      {removed.length > 0 && (
        <p className="studio-notice" role="status">
          Adjusted by our checks: {[...new Set(removed.map((r) => REMOVED[r.reason]).filter(Boolean))].join('; ')}.
        </p>
      )}
      <div className={`studio-grid${mode === 'preview' ? ' studio-grid--preview' : ''}`}>
        <div className={`studio-stage studio-preview--${device}`} ref={stage}>
          {html ? <iframe ref={frame} key={mode} title="Editable website preview" srcDoc={html} sandbox="allow-same-origin" onLoad={onFrameLoad} /> : <div className="studio-loading">Loading your website…</div>}
          {hoverActions && hover.rect && <div className="studio-outline studio-outline--hover" style={clip(hover.rect, frame.current)} />}
          {hoverActions && hover.rect && <SectionBar rect={hover.rect} actions={hoverActions} subtle />}
          {selActions && <div className="studio-outline" style={clip(selRect, frame.current)} />}
          {selActions && <SectionBar rect={selRect} actions={selActions} />}
          {pop && pop.rect && (
            <Popover rect={pop.rect} stage={stage} tall={pop.kind === 'img'} onClose={() => setPop(null)}>
              {pop.kind === 'btn' ? (
                <ButtonFields
                  title="Button"
                  cta={popValue && (popValue.label !== undefined ? { label: popValue.label, target: popValue.target } : null)}
                  site={site}
                  page={page}
                  autoFocus
                  onChange={(c) => change((x) => {
                    const sec = x.site.pages[pageIndex].sections.find((y) => y.id === pop.sid)
                    const keys = pop.path.split('.')
                    let o = sec
                    for (const k of keys.slice(0, -1)) o = o[/^\d+$/.test(k) ? Number(k) : k]
                    const last = keys.at(-1)
                    if (c === null) delete o[last]
                    else if (/^\d+$/.test(last)) Object.assign(o[Number(last)], c)
                    else o[last] = c
                  }, { merge: `btn|${pop.sid}|${pop.path}` })}
                />
              ) : (
                <PhotoPop
                  sid={pop.sid}
                  path={pop.path}
                  section={page.sections.find((x) => x.id === pop.sid)}
                  assets={photoAssets}
                  change={(fn) => editPage((p) => fn(p.sections.find((x) => x.id === pop.sid)))}
                  onRemoved={() => setPop(null)}
                  onMore={() => setTab('photos')}
                />
              )}
            </Popover>
          )}
        </div>
        {mode === 'edit' && (
          <aside className="studio-panel" aria-label="Edit panel">
            <div className="studio-tabs" role="tablist" aria-label="Edit">
              {[
                ...(section ? [['section', SECTION_LABEL[section.type]]] : []),
                ['page', 'Sections'],
                ['site', 'Style'],
                ['photos', 'Photos'],
                ['history', 'History'],
              ].map(([k, label]) => (
                <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>
                  {label}
                </button>
              ))}
            </div>
            {tab === 'section' &&
              (section ? (
                <SectionEditor key={section.id + focus} section={section} site={site} page={page} services={content.services} assets={photoAssets} focus={focus} onChange={editSection} onServices={(fn) => change((c) => fn(c.services))} />
              ) : (
                <p className="studio-empty">Click any part of your website to edit it.</p>
              ))}
            {tab === 'page' && <PageEditor site={site} page={page} pageIndex={pageIndex} selected={selected} biz={biz} actionsFor={actionsFor} onSelect={(id) => (setSelected(id), setTab('section'))} onPage={editPage} onSite={(fn) => change((c) => fn(c.site, c))} onGo={(s2) => (setSlug(s2), setSelected(null))} onAdd={(type) => addSectionAfter(selected, type)} />}
            {tab === 'site' && (
              <>
                <LogoPanel
                  logo={content.logo}
                  assets={assets}
                  variants={content.variants}
                  onLogo={(id) => {
                    // Only the pointer changes (null = no logo, on purpose). A file chosen as the logo is marked at once,
                    // so the photo pickers stop offering it (the server remembers it on save).
                    change((c) => (c.logo = id))
                    if (id) setAssets((l) => l.map((a) => (a.id === id ? { ...a, logo: true } : a)))
                  }}
                  onUploaded={(a) => setAssets((l) => [a, ...l])}
                />
                <LookEditor site={site} onSite={(fn) => change((c) => fn(c.site, c))} services={content.services} onServices={(fn) => change((c) => fn(c.services))} />
              </>
            )}
            {tab === 'photos' && (
              <PhotosPanel
                assets={assets}
                variants={content.variants}
                content={content}
                saved={save.state === 'saved'}
                stamp={website.updatedAt}
                onReplace={(from, to) => {
                  const r = replacePhoto(content, from, to)
                  if (r.count) change((c) => Object.assign(c, r.content))
                  return r.count
                }}
                onHidden={(id) => setAssets((l) => l.filter((x) => x.id !== id))}
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
          </aside>
        )}
      </div>
    </section>
  )
}

// An outline over a section, kept inside the visible preview.
const clip = (r, f) => {
  if (!f) return {}
  const top = Math.max(r.top, f.offsetTop)
  const bottom = Math.min(r.top + r.height, f.offsetTop + f.offsetHeight)
  return { top, left: r.left, width: r.width, height: Math.max(0, bottom - top) }
}

// Compact controls for one section, shown over it on hover (subtle) or when selected: name, move up/down, and a menu.
const Ico = ({ d }) => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={d} />
  </svg>
)

function SectionBar({ rect, actions: a, subtle = false }) {
  const top = Math.max(rect.top + 8, 20)
  return (
    <div className={`studio-sbar${subtle ? ' studio-sbar--hover' : ''}`} style={{ top, left: rect.left + rect.width - 8 }} role="toolbar" aria-label={`${a.label} section`}>
      <button type="button" className="studio-sbar-name" onClick={a.onSettings} title={`${a.label} settings`}>
        {a.label}
        {a.hidden ? ' · hidden' : ''}
      </button>
      <button type="button" className="studio-sbar-btn" onClick={a.onUp} disabled={!a.canUp} title="Move up" aria-label={`Move ${a.label} up`}>
        ↑
      </button>
      <button type="button" className="studio-sbar-btn" onClick={a.onDown} disabled={!a.canDown} title="Move down" aria-label={`Move ${a.label} down`}>
        ↓
      </button>
      <SectionMenu actions={a} />
    </div>
  )
}

// The ⋯ menu for a section: settings, add below, duplicate, hide/show, remove (asks first). Escape closes it.
function SectionMenu({ actions: a }) {
  const [open, setOpen] = useState(false)
  const [adding, setAdding] = useState(false)
  const wrap = useRef(null)
  const toggle = useRef(null)
  const menuId = `menu-${useId()}`
  useBackLayer(menuId, open, () => setOpen(false))
  useEffect(() => {
    if (!open) return
    const away = (e) => !wrap.current?.contains(e.target) && setOpen(false)
    // Escape closes the menu and returns focus to its button.
    const esc = (e) => e.key === 'Escape' && (setOpen(false), toggle.current?.focus())
    document.addEventListener('mousedown', away)
    document.addEventListener('keydown', esc)
    return () => (document.removeEventListener('mousedown', away), document.removeEventListener('keydown', esc))
  }, [open])
  const pick = (fn) => () => (fn(), setOpen(false))
  return (
    <span className="studio-menu-wrap" ref={wrap}>
      <button ref={toggle} type="button" className="studio-sbar-btn" aria-haspopup="menu" aria-expanded={open} title="More" aria-label={`More for ${a.label}`} onClick={() => (setOpen(!open), setAdding(false))}>
        ⋯
      </button>
      {open && (
        <div className="studio-menu" role="menu">
          <button type="button" role="menuitem" onClick={pick(a.onSettings)}>
            Section settings
          </button>
          <button type="button" role="menuitem" onClick={() => setAdding(!adding)} aria-expanded={adding}>
            Add a section below
          </button>
          {adding && (
            <div className="studio-submenu">
              {ADDABLE.map((t) => (
                <button key={t} type="button" role="menuitem" onClick={pick(() => a.onAdd(t))}>
                  {SECTION_LABEL[t]}
                </button>
              ))}
            </div>
          )}
          {a.canDuplicate && (
            <button type="button" role="menuitem" onClick={pick(a.onDuplicate)}>
              Duplicate
            </button>
          )}
          {a.canHide && (
            <button type="button" role="menuitem" onClick={pick(a.onToggle)}>
              {a.hidden ? 'Show on website' : 'Hide from website'}
            </button>
          )}
          {a.canRemove && (
            <button type="button" role="menuitem" className="danger" onClick={pick(a.onRemove)}>
              Remove
            </button>
          )}
        </div>
      )}
    </span>
  )
}

// A small panel next to the clicked button or photo, inside the preview area.
function Popover({ rect, stage, tall = false, onClose, children }) {
  const w = 320
  const h = tall ? 380 : 210 // matches .studio-pop max-height (photo) / a button's two fields
  const box = stage.current?.getBoundingClientRect()
  const left = Math.max(8, Math.min(rect.left, (box?.width || 800) - w - 8))
  // Below what was clicked (so it stays visible), above only when there's no room below.
  const below = rect.top + rect.height + 8
  const room = box?.height || 900
  // …and always inside the preview area, so it never covers the editing panel next to or below it.
  const top = below + h <= room ? below : rect.top - 8 - h >= 8 ? rect.top - 8 - h : Math.max(8, room - h - 8)
  const box2 = useRef(null)
  // Escape or a click/tap anywhere outside the panel closes it (clicks inside the website preview are the frame's own).
  useEffect(() => {
    const k = (e) => e.key === 'Escape' && onClose()
    const away = (e) => box2.current && !box2.current.contains(e.target) && onClose()
    window.addEventListener('keydown', k)
    document.addEventListener('pointerdown', away)
    return () => (window.removeEventListener('keydown', k), document.removeEventListener('pointerdown', away))
  }, [onClose])
  return (
    <div ref={box2} className="studio-pop" style={{ top, left, width: w }} role="dialog" aria-label="Edit">
      <button type="button" className="studio-pop-close" onClick={onClose} aria-label="Close">
        ×
      </button>
      {children}
    </div>
  )
}

// The clicked photo: choose another, frame it (focus point + shape), describe it.
// "No photo" really removes it: a section photo is cleared; an opening's photo block is removed (a photo block without a
// photo would be empty). It used to be ignored, so an unwanted picture could be swapped but never removed.
function PhotoPop({ path, section, assets, change, onMore, onRemoved }) {
  const block = /^blocks\.\d+$/.test(path) ? Number(path.split('.')[1]) : null
  const b = block !== null ? section?.blocks?.[block] : null
  const value = b ? b.image : section?.image
  return (
    <ImageField
      label="Photo"
      value={value}
      alt={b ? b.alt : section?.imageAlt}
      assets={assets}
      onChange={(v) => {
        if (v) return change((s2) => (b ? (s2.blocks[block].image = v) : (s2.image = v)))
        change((s2) => (b ? s2.blocks.splice(block, 1) : delete s2.image))
        onRemoved?.()
      }}
      onAlt={(v) => change((s2) => (b ? (s2.blocks[block].alt = v) : (s2.imageAlt = v)))}
      focus={b ? b.focus : section?.imageFocus}
      aspect={b ? b.aspect : section?.imageAspect}
      onFocus={(v) => change((s2) => (b ? (s2.blocks[block].focus = v) : (s2.imageFocus = v)))}
      onAspect={(v) => change((s2) => (b ? (s2.blocks[block].aspect = v) : (s2.imageAspect = v)))}
      onMore={onMore}
    />
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
function Choice({ id, label, value, options, onChange }) {
  return (
    <label className="field">
      <span>{label}</span>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
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
// call: regular buttons only (not composition blocks): dials the phone number in Business details.
function Target({ label, value, site, page, onChange, call = false }) {
  const options = [['book', 'Booking page'], ...(call || value === 'call' ? [['call', 'Call (your phone number from Business details)']] : []), ...site.pages.map((p) => [`page:${p.slug}`, `Page: ${p.navLabel}`]), ...page.sections.map((s) => [`section:${s.id}`, `Section: ${s.heading || SECTION_LABEL[s.type]}`])]
  return <Choice label={label} value={value || 'book'} options={options} onChange={onChange} />
}
function ButtonFields({ title, cta, site, page, onChange, autoFocus, removable = false, call = true }) {
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
      <Target label="Goes to" value={cta.target} site={site} page={page} call={call} onChange={(v) => onChange({ ...cta, target: v })} />
      {cta.target === 'call' && <p className="fine">Shows and dials the phone number in Business details. Without one, the button isn’t shown.</p>}
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
  // The picture in use, when it isn't one of the choices (a stock photo, or a logo that was placed as a photo): shown so
  // the owner can see exactly what "No photo" removes.
  const current = value && !assets.some((a) => a.id === id) ? (id ? `/site-assets/${id}` : value.startsWith('stock:') ? `/site-stock/${value.slice(6)}-sm.jpg` : null) : null
  return (
    <fieldset className="field studio-group">
      <legend>{label}</legend>
      {value && onFocus && <Framing src={id ? `/site-assets/${id}` : null} focus={focus} aspect={aspect} onFocus={onFocus} onAspect={onAspect} />}
      <div className="studio-thumbs">
        {current && (
          <span className="studio-thumb studio-thumb--current" aria-pressed="true" title="Current photo">
            <img src={current} alt="Current photo" />
          </span>
        )}
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
            <ButtonFields key={i} title="Button" cta={{ label: b.label, target: b.target }} site={site} page={page} call={false} autoFocus={focus === 'button'} onChange={(c) => onChange((x) => Object.assign(x.blocks[i], c))} />
          ) : b.kind === 'media' ? (
            <ImageField key={i} label="Photo" value={b.image} alt={b.alt} assets={assets} onChange={(v) => onChange((x) => (v ? (x.blocks[i].image = v) : x.blocks.splice(i, 1)))} onAlt={(v) => onChange((x) => (x.blocks[i].alt = v))} focus={b.focus} aspect={b.aspect} onFocus={(v) => onChange((x) => (x.blocks[i].focus = v))} onAspect={(v) => onChange((x) => (x.blocks[i].aspect = v))} />
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
      {s.type === 'area' && (
        <>
          <label className="check">
            <input type="checkbox" checked={Boolean(s.showHours)} onChange={(e) => onChange((x) => (x.showHours = e.target.checked))} /> Show your online booking hours
          </label>
          <p className="fine">The towns and online booking hours come from Business details.</p>
        </>
      )}
      {LAYOUTS[s.type] && <Choice label="Layout" value={s.layout} options={LAYOUTS[s.type]} onChange={set('layout')} />}
      {s.type !== 'composition' && <Choice label="Background" value={s.background === 'image' ? 'ink' : s.background} options={BACKGROUNDS} onChange={set('background')} />}
    </div>
  )
}

// ---------- page ----------
function PageEditor({ site, page, pageIndex, selected, biz, actionsFor, onSelect, onPage, onSite, onGo, onAdd }) {
  const [adding, setAdding] = useState('')
  const [newPage, setNewPage] = useState('')
  const [service, setService] = useState('')
  const [drag, setDrag] = useState(null)
  // Drag a row onto another to move it there (the first screen of the home page stays first).
  const dropOn = (to) => {
    const from = drag
    setDrag(null)
    if (from === null || from === to || (pageIndex === 0 && (from === 0 || to === 0))) return
    onPage((p) => p.sections.splice(to, 0, p.sections.splice(from, 1)[0]))
  }
  return (
    <div className="studio-page-panel">
      <h3>Sections</h3>
      <ol className="studio-sections">
        {page.sections.map((s, i) => {
          const a = actionsFor(s.id)
          return (
            <li
              key={s.id}
              className={`${s.id === selected ? 'is-selected' : ''}${s.hidden ? ' is-hidden' : ''}${drag === i ? ' is-dragging' : ''}`}
              draggable={a.canUp || a.canDown}
              onDragStart={() => setDrag(i)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => dropOn(i)}
              onDragEnd={() => setDrag(null)}
            >
              <span className="studio-grip" aria-hidden="true" title="Drag to reorder">
                ⠿
              </span>
              <button type="button" className="studio-section-name" onClick={() => onSelect(s.id)}>
                <span>{a.label}</span>
                {s.hidden && <span className="studio-tag">Hidden</span>}
              </button>
              <span className="studio-row-actions">
                <button type="button" className="studio-sbar-btn" disabled={!a.canUp} onClick={a.onUp} title="Move up" aria-label={`Move ${a.label} up`}>
                  ↑
                </button>
                <button type="button" className="studio-sbar-btn" disabled={!a.canDown} onClick={a.onDown} title="Move down" aria-label={`Move ${a.label} down`}>
                  ↓
                </button>
                <SectionMenu actions={a} />
              </span>
            </li>
          )
        })}
      </ol>
      <div className="studio-add">
        <Choice label="Add a section" value={adding} options={[['', 'Choose…'], ...(page.legal ? ['text'] : ADDABLE).map((t) => [t, SECTION_LABEL[t]])]} onChange={setAdding} />
        <button
          type="button"
          className="btn btn-sm"
          disabled={!adding}
          onClick={() => {
            onAdd(adding)
            setAdding('')
          }}
        >
          Add
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
          <Choice id="studio-add-page" label="Add a page" value={newPage} options={[['', 'Choose…'], ...PAGE_TYPES]} onChange={setNewPage} />
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

// ---------- logo ----------
// The logo is one pointer in the content (content.logo). null means "no logo, on purpose": the business name is shown in
// the header and the site icon is a letter mark. "Remove from website" changes only that pointer (saved like any edit,
// undoable, published when the owner publishes); the uploaded file stays in the media library marked Logo and can be
// chosen again. Deleting the file for good is a separate, confirmed action under Photos. No AI anywhere here.
function LogoPanel({ logo, assets, variants, onLogo, onUploaded }) {
  const [state, setState] = useState({})
  const [choosing, setChoosing] = useState(false)
  const copies = new Set(Object.values(variants || {}))
  const choices = assets.filter((a) => !copies.has(a.id) && a.id !== logo)
  const pick = async (e) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setState({ busy: true })
    const r = await uploadImage(file, 'logo')
    setState(r.error ? { error: r.error } : {})
    if (r.asset) {
      onUploaded({ ...r.asset, createdAt: Date.now(), logo: true })
      onLogo(r.asset.id)
    }
  }
  return (
    <div className="image-pick" data-testid="logo-panel">
      <div className="image-pick-thumb image-pick-thumb--logo">{logo ? <img src={`/site-assets/${logo}`} alt="Current logo" /> : <span aria-hidden="true">+</span>}</div>
      <div>
        <p className="image-pick-label">Logo</p>
        <p className="fine">{logo ? 'Your site icon (browser tab and bookmarks). Your business name stays in the header.' : 'No logo: your site icon is a letter mark in your brand colour.'}</p>
        <div className="studio-photo-actions">
          <label className="btn btn-quiet btn-sm">
            {state.busy ? 'Uploading…' : logo ? 'Replace logo' : 'Upload logo'}
            <input type="file" accept="image/*" className="sr-only" onChange={pick} disabled={state.busy} data-testid="logo-file" />
          </label>
          {choices.length > 0 && (
            <button type="button" className="btn btn-quiet btn-sm" aria-expanded={choosing} onClick={() => setChoosing(!choosing)}>
              Choose an uploaded file
            </button>
          )}
          {logo && (
            <button type="button" className="btn btn-quiet btn-sm" onClick={() => (onLogo(null), setChoosing(false))}>
              Remove from website
            </button>
          )}
        </div>
        {choosing && (
          <div className="studio-thumbs" role="group" aria-label="Uploaded files">
            {choices.map((a) => (
              <button key={a.id} type="button" className="studio-thumb" onClick={() => (onLogo(a.id), setChoosing(false))} aria-label="Use this file as the logo">
                <img src={a.url} alt="" />
              </button>
            ))}
          </div>
        )}
        {state.error && (
          <p className="form-error" role="alert">
            {state.error}
          </p>
        )}
      </div>
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
// Each photo says where it is used ("Used on: Home · Hero, your live website, 2 saved versions"): the draft places come
// from the content being edited (unsaved edits included), the stored copies from the server (GET ?usage=1).
// "Delete uploaded file" (permanent, confirmed) is offered only when neither the draft nor the live website shows the
// file: the server then also takes it out of saved versions and History, so nothing can bring it back. Hide is for one
// only history uses (kept for restores); Replace swaps it everywhere in the draft (the live website changes only when
// the owner publishes).
// `stamp`: the dashboard's draft stamp (website.updatedAt): a publish or a version restore changes what the live website
// shows, so usage is read again (otherwise "your live website" would be stale and Delete withheld or offered wrongly).
function PhotosPanel({ assets, variants, content, saved, stamp, onAdded, onRemoved, onReload, onReplace, onHidden }) {
  const [state, setState] = useState({})
  const [usage, setUsage] = useState(null) // { [id]: usage } | null while loading | { failed }
  const [hidden, setHidden] = useState([])
  const [replacing, setReplacing] = useState(null) // photo id
  const [usageTick, setUsageTick] = useState(0)
  const loadUsage = () => setUsageTick((n) => n + 1)
  useEffect(() => {
    let live = true
    api('/api/dashboard/website/assets?usage=1').then(({ status, data }) => {
      if (!live) return
      if (status !== 200) return setUsage({ failed: true })
      setUsage(Object.fromEntries(data.assets.map((a) => [a.id, a.usage])))
      setHidden(data.assets.filter((a) => a.hidden))
    })
    return () => {
      live = false
    }
  }, [usageTick, assets.length, saved, stamp])
  const used = assets.reduce((n, a) => n + (a.size || 0), 0)
  const copies = new Set(Object.values(variants || {}))
  const photos = assets.filter((a) => !copies.has(a.id))
  const missing = photos.filter((a) => !variants?.[a.id])
  const statusOf = (a) => {
    const places = draftPlaces(content, a.id)
    const u = usage && !usage.failed ? usage[a.id] : null
    const known = usage && !usage.failed
    const stored = Boolean(u?.live || u?.versions || u?.history)
    const onSite = places.length > 0 || content.logo === a.id
    return { places, u, known, stored, parts: usageText(places, u ? { ...u, draft: saved && u.draft } : null), canDelete: known && saved && !onSite && !u?.draft && !u?.live, canHide: known && saved && !onSite && !u?.draft && !u?.live && stored }
  }
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
    const s = statusOf({ id })
    const where = s.stored ? usageText([], { ...s.u, draft: false, live: false }).join(' and ') : ''
    const ask = where ? `Delete this photo for good? It isn’t on your website or in your draft, but ${where} still show it: they will no longer, and restoring them can’t bring it back.` : 'Delete this photo for good? It isn’t used anywhere on your website, in saved versions or in History.'
    if (!window.confirm(ask)) return
    const { status, data } = await api('/api/dashboard/website/assets', { method: 'POST', body: { action: 'destroy', id, confirm: true } })
    if (status === 200) {
      for (const x of data.removed || [id]) onRemoved(x)
      // Published once? A copy cached while it was live may still show for a while (the server says how long).
      setState({ note: `Photo deleted.${data.references?.versions ? ` ${data.storage?.cache?.note || ''}` : ''}`.trim() })
    } else setState({ error: data?.error === 'live' ? 'That photo is on your live website. Remove it from your website and publish first.' : data?.error === 'in_draft' ? 'That photo is in your draft. Remove it from your website first.' : 'Couldn’t delete that photo. Please try again.' })
    loadUsage()
  }
  const hide = async (id, on) => {
    if (on && !window.confirm('Hide this photo? It leaves your photo list and the photo choices. It is kept, so restoring a saved version or an earlier draft that shows it still works. You can show it again below.')) return
    const { status, data } = await api('/api/dashboard/website/assets', { method: 'POST', body: { action: on ? 'hide' : 'show', id } })
    if (status === 200) {
      if (on) onHidden(id)
      else await onReload()
      setState({ note: on ? 'Photo hidden. It’s kept for your saved versions and History.' : 'Photo shown again.' })
    } else setState({ error: data?.error === 'not_available' ? 'Hiding photos isn’t available yet.' : data?.error === 'live' || data?.error === 'in_draft' ? 'That photo is on your website, so it can’t be hidden. Replace it first.' : 'Couldn’t change that photo. Please try again.' })
    loadUsage()
  }
  const replace = (from, to) => {
    const n = draftPlaces(content, from).length
    if (!window.confirm(`Use the new photo in ${n === 1 ? 'that place' : `all ${n} places`} in your draft? You can undo this. Your live website changes only when you publish.`)) return
    const count = onReplace(from, to)
    setReplacing(null)
    setState({ note: count ? `Replaced in your draft (${count} place${count === 1 ? '' : 's'}). Publish to show it on your live website.` : 'Nothing to replace.' })
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
      {!saved && <p className="fine">Waiting for your latest changes to save before photos can be deleted or hidden…</p>}
      <ul className="studio-photo-list" aria-label="Your photos">
        {photos.map((a, i) => {
          const s = statusOf(a)
          const others = photos.filter((x) => x.id !== a.id && !x.logo)
          return (
            <li key={a.id} className="studio-photo-row">
              <img src={a.url} alt={`Photo ${i + 1}`} />
              <div className="studio-photo-info">
                <span className="fine">
                  {content.logo === a.id ? 'Current logo · ' : a.logo ? 'Logo · ' : ''}
                  {variants?.[a.id] ? 'Phone version ready' : 'No phone version'}
                </span>
                <span className="fine studio-photo-used" data-testid="photo-usage">
                  {!s.known ? (usage?.failed ? 'Couldn’t check where it’s used.' : 'Checking where it’s used…') : s.parts.length ? `Used on: ${s.parts.join(', ')}` : 'Not used anywhere'}
                </span>
                <span className="studio-photo-row-actions">
                  {s.places.length > 0 && others.length > 0 && (
                    <button type="button" className="link-btn" aria-expanded={replacing === a.id} onClick={() => setReplacing(replacing === a.id ? null : a.id)} aria-label={`Replace photo ${i + 1} in the draft`}>
                      Replace…
                    </button>
                  )}
                  {s.canDelete && (
                    <button type="button" className="link-btn danger" onClick={() => remove(a.id)} aria-label={`Delete photo ${i + 1} for good`}>
                      Delete uploaded file
                    </button>
                  )}
                  {s.canHide && (
                    <button type="button" className="link-btn" onClick={() => hide(a.id, true)} aria-label={`Hide photo ${i + 1}`}>
                      Hide
                    </button>
                  )}
                </span>
                {s.u?.live && !s.places.length && <span className="fine">Still on your live website until you publish your draft.</span>}
              </div>
              {replacing === a.id && (
                <fieldset className="studio-replace">
                  <legend className="fine">Choose the photo to use instead</legend>
                  <div className="studio-thumbs">
                    {others.map((o) => (
                      <button key={o.id} type="button" className="studio-thumb" onClick={() => replace(a.id, o.id)} aria-label={`Use photo ${photos.indexOf(o) + 1} instead`}>
                        <img src={o.url} alt="" />
                      </button>
                    ))}
                  </div>
                </fieldset>
              )}
            </li>
          )
        })}
      </ul>
      {hidden.length > 0 && (
        <details className="studio-hidden-photos">
          <summary>Hidden photos ({hidden.length})</summary>
          <p className="fine">Kept because a saved version or an earlier draft shows them.</p>
          <ul className="studio-photo-list">
            {hidden.map((a, i) => (
              <li key={a.id} className="studio-photo-row">
                <img src={a.url} alt={`Hidden photo ${i + 1}`} />
                <button type="button" className="link-btn" onClick={() => hide(a.id, false)} aria-label={`Show hidden photo ${i + 1} again`}>
                  Show again
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  )
}

// ---------- history ----------
const REASON = { autosave: 'Saved while editing', published: 'Published', before_restore: 'Before a restore', before_version_restore: 'Before going back to a published version', before_designer_change: 'Before a designer change' }
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
