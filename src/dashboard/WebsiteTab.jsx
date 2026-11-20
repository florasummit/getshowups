// Website tab: is my site live, edit it (autosaved), preview, publish, address/domain, earlier versions.
import { useState } from 'react'
import { api, fmt } from '../lib/api.js'
import WebsiteEditor, { WebsitePreview } from './WebsiteEditor.jsx'
import { problemText, useWebsite } from './website-data.js'
import DomainSettings from './DomainSettings.jsx'
import WebsiteImport from './WebsiteImport.jsx'
import WebsiteDesigner from './WebsiteDesigner.jsx'
import SiteStudio from './SiteStudio.jsx'
import WebsiteGenerator, { ReviseBox } from './WebsiteGenerator.jsx'
import WebsiteJourney from './WebsiteJourney.jsx'
import WebsiteStart from './WebsiteStart.jsx'
import WebsiteHosting from './WebsiteHosting.jsx'
import { Pill } from './ui.jsx'

const day = (ms) => fmt(new Date(ms).toISOString(), undefined, { month: 'short', day: 'numeric', year: 'numeric' })
// Only while publishing is switched off for maintenance (WEBSITE_STUDIO_PUBLISH=false).
const STUDIO_PRIVATE = 'Publishing AI-designed websites is paused for a moment: you can keep editing and previewing. Your live website hasn’t changed.'
const studioOutput = (c) => Boolean(c && (c.site || c.redirects?.length))

export function PublishBox({ data, onDone, label = 'Publish', secondary }) {
  const [ok, setOk] = useState(false)
  const [legalOk, setLegalOk] = useState(false)
  const [state, setState] = useState({})
  const address = (data.domain?.status === 'connected' ? data.domain.url : data.url).replace(/^https?:\/\//, '')
  // Legal pages need their own explicit review before they go public (server: legal_review_required).
  const legal = (data.website.draft?.site?.pages || []).filter((p) => p.legal)
  const publish = async () => {
    setState({ busy: true })
    // baseUpdatedAt: the draft version shown here. If it changed elsewhere meanwhile, nothing is published (409).
    const base = Number.isFinite(data.website.updatedAt) ? { baseUpdatedAt: data.website.updatedAt } : {}
    const { status, data: d } = await api('/api/dashboard/website', { method: 'POST', body: { action: 'publish', content: data.website.draft, confirm: true, ...base, ...(legal.length ? { legalReviewed: legalOk } : {}) } })
    if (status === 200) return onDone(d)
    setState({
      error:
        d.error === 'conflict'
          ? 'Your draft was changed somewhere else (another tab, device or the designer), so nothing was published. Reload the page to review the latest draft, then publish.'
          : d.error === 'not_ready'
          ? 'Connect your calendar and set your hours first, so customers can book.'
          : d.error === 'plan_required'
            ? 'Your plan isn’t active. Reactivate it in Settings to publish.'
            : d.error === 'studio_publish_off'
              ? STUDIO_PRIVATE
              : d.error === 'render_failed'
                ? 'This version couldn’t be prepared for visitors, so your live website hasn’t changed. Please try again, or contact us.'
            : d.fields
              ? problemText(d.fields)
              : 'Couldn’t publish. Please try again.',
    })
  }
  return (
    <div className="form">
      <label className="check">
        <input type="checkbox" checked={ok} onChange={(e) => setOk(e.target.checked)} />
        <span>The details are accurate and I want this to be public at {address}.</span>
      </label>
      {legal.length > 0 && (
        <label className="check">
          <input type="checkbox" checked={legalOk} onChange={(e) => setLegalOk(e.target.checked)} />
          <span>
            I’ve read my {legal.map((p) => p.navLabel.toLowerCase()).join(' and ')} page and it’s accurate for my business
            {legal.some((p) => p.source?.kind === 'starter') ? ' (it started as a draft from GetShowUps, not legal advice)' : ''}.
          </span>
        </label>
      )}
      {state.error && (
        <p className="form-error" role="alert">
          {state.error}
        </p>
      )}
      <button type="button" className="btn btn-primary btn-lg btn-block" disabled={!ok || (legal.length > 0 && !legalOk) || state.busy} onClick={publish}>
        {state.busy ? 'Publishing…' : label}
      </button>
      {secondary}
    </div>
  )
}

function HostingNotice({ hosting }) {
  if (hosting.status === 'grace') return <p className="notice-soft">Your plan has ended. Your website stays online until {day(hosting.until)}. Reactivate in Settings to keep it running.</p>
  if (hosting.status === 'ended') return <p className="notice-soft">Your website is offline because your plan ended. Your content is saved. Reactivate in Settings to bring it back.</p>
  return null
}

// Phone, hours and towns are shown from the records at render time once they exist; services and notes need a section.
const MISSING_TEXT = {
  phone: { text: 'Your phone number: the Call button next to Book online appears once it’s in Settings.' },
  hours: { text: 'Your online booking hours: they appear on the page once you confirm them in Settings.' },
  area: { text: 'The towns you serve: they appear on the page once they’re in Settings.' },
  services: { text: 'Your services: add them, then add a Services section in the editor.' },
  policies: { text: 'What customers should know: write it in Settings, then add a Good to know section in the editor.' },
}
function StarterMissing({ missing }) {
  const items = missing.filter((k) => MISSING_TEXT[k])
  if (!items.length) return null
  return (
    <section className="card" aria-label="Details to add">
      <p>
        <strong>Your draft is ready.</strong> We left out what we don’t know yet rather than make it up. To complete it, add these in <a href="/dashboard/settings">Settings</a>:
      </p>
      <ul>
        {items.map((k) => (
          <li key={k}>{MISSING_TEXT[k].text}</li>
        ))}
      </ul>
    </section>
  )
}

export default function WebsiteTab() {
  const [data, setData] = useWebsite()
  const [stamp, setStamp] = useState(0)
  const [rewrite, setRewrite] = useState(false)
  const [pending, setPending] = useState(null)
  const [editorKey, setEditorKey] = useState(0)
  // What "I'm starting fresh" needed but didn't find (those parts were left out, never made up).
  const [starterMissing, setStarterMissing] = useState([])
  // The Studio editor has edits the server hasn't confirmed yet: publishing waits (Publish sends the saved draft).
  const [unsaved, setUnsaved] = useState(false)
  const [moreOpen, setMoreOpen] = useState(null) // null = default: open until the site is AI-designed
  const [publishing, setPublishing] = useState(false)
  const [more, setMore] = useState({})
  if (!data) return <div aria-busy="true" />
  if (data.failed) return <p className="form-error">Couldn’t load your website. Please refresh.</p>
  const w = data.website
  // An AI-designed draft (content.site): the AI designer owns its look. The older template tools would replace it (their
  // results carry no AI design), so they are not offered for it; Undo and earlier versions stay available.
  const designed = Boolean(w.draft?.site)
  const live = data.domain?.status === 'connected' ? data.domain.url : data.url
  const setUsage = (aiUsage) => setData((d) => ({ ...d, aiUsage }))
  const refresh = (d) => {
    setData(d)
    setStamp((n) => n + 1)
  }
  const post = async (body) => {
    setMore({ busy: true })
    const { status, data: d } = await api('/api/dashboard/website', { method: 'POST', body })
    if (status === 200) {
      refresh(d)
      setMore({})
    } else setMore({ error: d?.error === 'studio_publish_off' ? STUDIO_PRIVATE : 'Something went wrong. Please try again.' })
  }

  // AI-designed site in Website Studio: the editor is the page (status bar above it, other tools tucked below).
  const studioMode = Boolean(designed && data.studio && !w.generated)
  const openPublish = () => {
    setPublishing(true)
    document.getElementById('site-publish')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }
  // The import + AI designer tools: collapsed under a labelled row only when an AI-designed site is being edited.
  // Always the same element (a <details>), so the import/designer state (e.g. "Added to your draft…") survives the moment
  // a site becomes AI-designed; without a site to edit it simply stays open with its toggle hidden.
  const ToolsWrap = 'details'
  const toolsProps = studioMode ? { className: 'card site-more', open: moreOpen ?? false, onToggle: (e) => setMoreOpen(e.currentTarget.open) } : { className: 'site-tools', open: true }
  return (
    <div className="enter">
      <h1 className="ui-page-title ui-page-title--top">Website</h1>
      {/* Before there's a website, the first decision comes first; the step-by-step overview follows. */}
      {data.studio && !designed && !w.published && (
        <WebsiteStart
          onImport={() => {
            const el = document.getElementById('site-import')
            el?.scrollIntoView({ behavior: 'smooth', block: 'start' })
            el?.querySelector('input')?.focus({ preventScroll: true })
          }}
          onCreated={(d) => {
            refresh(d)
            setEditorKey((k) => k + 1)
            setStarterMissing(Array.isArray(d?.starterMissing) ? d.starterMissing : [])
          }}
        />
      )}
      {starterMissing.length > 0 && <StarterMissing missing={starterMissing} />}
      <WebsiteJourney data={data} onPublish={openPublish} canPublish={!w.generated && !pending && !publishing && !unsaved && !(studioOutput(w.draft) && !data.studioPublish)} />
      <section id="site-publish" className={`card site-status${studioMode ? ' site-status--bar' : ''}`} aria-label="Website status">
        <p className="site-status-line">
          <Pill tone={w.published ? (w.changed ? 'warn' : 'ok') : 'neutral'}>{w.published ? 'Live' : 'Not published'}</Pill>
          {w.published ? (w.changed ? <span>You have changes that aren’t published yet</span> : null) : <span>Not published yet</span>}
        </p>
        {w.published && (
          <a className="booking-url booking-url--dark" href={live} target="_blank" rel="noreferrer">
            {live.replace(/^https?:\/\//, '')}
          </a>
        )}
        <HostingNotice hosting={data.hosting} />
        <div className="card-actions">
          {!w.generated && !pending && !publishing && (!w.published || w.changed) && !(studioOutput(w.draft) && !data.studioPublish) && (
            <button type="button" className="btn btn-primary" onClick={() => setPublishing(!publishing)} aria-expanded={publishing} disabled={unsaved}>
              {w.published ? 'Publish changes' : 'Publish website'}
            </button>
          )}
          {w.published && (
            <a className="btn btn-quiet" href={live} target="_blank" rel="noreferrer">
              View website
            </a>
          )}
        </div>
        {pending && <p className="fine">Keep or discard the new version below before publishing.</p>}
        {unsaved && <p className="fine">Saving your latest changes before you can publish…</p>}
        {studioOutput(w.draft) && !data.studioPublish && <p className="fine">{STUDIO_PRIVATE}</p>}
        {publishing && !pending && (
          <>
            <PublishBox
              data={data}
              label={w.published ? 'Publish changes' : 'Publish website'}
              onDone={(d) => {
                setPublishing(false)
                refresh(d)
              }}
            />
            <button type="button" className="link-btn" onClick={() => setPublishing(false)}>
              Not yet
            </button>
          </>
        )}
      </section>

      {/* Import + AI designer: one fixed place (never remounted, so a conversation in progress is kept). With an
          AI-designed site it is a one-line row above the editor, open while the owner is using it. */}
      {data.studio && (
        <ToolsWrap {...toolsProps}>
          <summary hidden={!studioMode}>Import your current website · AI designer</summary>
      {/* Website Studio (internal pilot, server/website-studio.js): import + AI designer only for businesses in it. */}
      {data.studio && (
      <section id="site-import" className="card" aria-label="Bring your current website">
        <h2 className="card-title">Bring your current website</h2>
        <WebsiteImport
          defaultUrl={data.domain?.hostname || ''}
          hasContent={Boolean(designed || w.published)}
          onApplied={async () => {
            const { status, data: d } = await api('/api/dashboard/website')
            if (status === 200) {
              refresh(d)
              setEditorKey((k) => k + 1)
              setMoreOpen(true)
            }
          }}
        />
      </section>
      )}

      {data.studio && (
      <section className="card" aria-label="AI designer">
        <h2 className="card-title">AI designer</h2>
        <WebsiteDesigner
          onChanged={async () => {
            const { status, data: d } = await api('/api/dashboard/website')
            if (status === 200) {
              refresh(d)
              setEditorKey((k) => k + 1)
              setMoreOpen(true)
            }
          }}
        />
      </section>
      )}

        </ToolsWrap>
      )}

      {!designed && (
      <section id="site-create" className="card" aria-label="Create with AI">
        {w.generated || rewrite ? (
          <WebsiteGenerator
            hasDraft={!w.generated}
            templates={rewrite === 'templates'}
            usage={data.aiUsage}
            ownKey={data.aiKey?.status === 'ok' ? data.aiKey.provider : null}
            onUsage={setUsage}
            intro={w.generated ? 'We’ll write your website from your business details. You choose the design, check it, then publish.' : null}
            onApplied={(d) => {
              setRewrite(false)
              setPending(null)
              refresh(d)
              setEditorKey((k) => k + 1)
            }}
          />
        ) : (
          <>
            <ReviseBox
              usage={data.aiUsage}
              ownKey={data.aiKey?.status === 'ok' ? data.aiKey.provider : null}
              onUsage={setUsage}
              onPreview={setPending}
              onApplied={(d) => {
                refresh(d)
                setEditorKey((k) => k + 1)
              }}
            />
            <button
              type="button"
              className="link-btn"
              onClick={() => {
                // An unkept revision must not stay in the preview once the owner moves on (it isn't the draft).
                setPending(null)
                setRewrite(true)
              }}
            >
              Start over with three new designs
            </button>
            <button
              type="button"
              className="link-btn"
              onClick={() => {
                setPending(null)
                setRewrite('templates')
              }}
            >
              Choose one of our standard designs (no AI)
            </button>
          </>
        )}
      </section>
      )}

      {!w.generated && (
        <div id="site-edit" className="site-edit-anchor">
          {designed && data.studio ? (
            // Website Studio editor: edit the AI-designed site directly (no AI), with live preview and autosave.
            <SiteStudio key={editorKey} storeKey={data.url} website={w} assets={data.assets} brand={data.brand} visit={data.visit} checkpoints={data.checkpoints || []} onSaved={refresh} onUnsaved={setUnsaved} />
          ) : (
            <section className="site-preview-wrap" aria-label="Preview">
              <WebsitePreview stamp={stamp} query={pending ? `generation=${pending.id}&option=0&` : ''} unsaved={Boolean(pending)} />
            </section>
          )}
          {/* One editor per draft: the Studio editor (above) replaces this form for AI-designed sites, so two autosaving
              copies can't overwrite each other. */}
          {!(designed && data.studio) && (
            <section className="card site-editor" aria-label="Edit website">
              <h2 className="card-title">Edit text and photos</h2>
              <WebsiteEditor key={editorKey} initial={w.draft} baseUpdatedAt={w.updatedAt} colors={data.options.colors} designOptions={data.options} onSaved={refresh} designed={designed ? 'locked' : false} />
            </section>
          )}
        </div>
      )}

      <section id="site-domain" className="card" aria-label="Website address">
        <h2 className="card-title">Website address</h2>
        <DomainSettings
          siteUrl={data.url}
          site={{ published: Boolean(w.published), redirects: w.draft?.redirects?.length || 0 }}
          onChange={async () => {
            const { status, data: d } = await api('/api/dashboard/website')
            if (status === 200) setData(d)
          }}
        />
      </section>

      {data.studio && <WebsiteHosting published={Boolean(w.published)} />}

      <section className="card">
        <details className="more more--flat">
          <summary>Earlier versions and more</summary>
          {w.versions.length > 0 ? (
            <ul className="rows">
              {w.versions.map((v) => (
                <li key={v.version} className="row">
                  <div className="row-main">
                    <p className="row-title">
                      Published {day(v.createdAt)}
                      {v.live && <span className="tag tag--ok">Live</span>}
                    </p>
                  </div>
                  {!v.live && (
                    <button type="button" className="btn btn-quiet btn-sm" disabled={more.busy} onClick={() => window.confirm(`Make the version published ${day(v.createdAt)} your live website again? Visitors will see it right away, and your draft becomes that version too.${data.studio ? ' Your current draft is kept under History in the editor.' : ''} You can switch back from this list.`) && post({ action: 'restore', version: v.version, confirm: true })}>
                      Restore
                    </button>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="fine">Each time you publish, we keep a copy you can go back to.</p>
          )}
          <div className="card-actions">
            <a className="btn btn-quiet btn-sm" href="/api/dashboard/website/export" download>
              Download my content
            </a>
            {w.published &&
              (more.confirm ? (
                <>
                  <button type="button" className="btn btn-danger btn-sm" disabled={more.busy} onClick={() => post({ action: 'unpublish' })}>
                    Take website offline
                  </button>
                  <button type="button" className="link-btn" onClick={() => setMore({})}>
                    Cancel
                  </button>
                </>
              ) : (
                <button type="button" className="link-btn" onClick={() => setMore({ confirm: true })}>
                  Take website offline…
                </button>
              ))}
          </div>
          {more.error && (
            <p className="form-error" role="alert">
              {more.error}
            </p>
          )}
          <p className="fine">Your text and photos belong to you. Download them any time.</p>
        </details>
      </section>
    </div>
  )
}
