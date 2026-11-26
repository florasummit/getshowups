// Website tab. Before a website exists: one start decision (WebsiteStart). Afterwards, top to bottom: is it live (publish,
// view, take offline) → what it still lacks → the editor → the step-by-step overview → the other tools, each under its
// own disclosure (bring your current website / AI designer, address and hosting, published versions and download).
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
import { ConfirmInline, Pill } from './ui.jsx'

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
  // Said before it goes public, not discovered afterwards (finding WEB-06).
  const noServices = (data.missing || []).some((k) => k === 'services' || k === 'services_section')
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
      {noServices && (
        <p className="notice-soft" data-publish-note="services">
          This website doesn’t show your services or prices yet. You can publish it like this, or add a Services section in the editor first.
        </p>
      )}
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

// What the website still lacks, from the records on every load (server/site-starter.js missingFor): it stays until it is
// resolved, and every line links to the place where it is added (finding WEB-06).
const MISSING = {
  phone: ['Your phone number', 'Add it and the Call button appears next to Book online.', '/dashboard/settings#business', 'Add it in Settings'],
  hours: ['Your online booking hours', 'They show on the page once you confirm them.', '/dashboard/settings#booking-hours', 'Set them in Settings'],
  area: ['The towns you serve', 'They show on the page once they’re in your business details.', '/dashboard/settings#business', 'Add them in Settings'],
  services: ['Your services', 'Add a Services section in the editor below (Sections → Add a section) and list them there.', '#site-edit', 'Go to the editor'],
  services_section: ['Your services aren’t shown', 'Add a Services section in the editor below (Sections → Add a section), or show the hidden one.', '#site-edit', 'Go to the editor'],
  policies: ['What customers should know', 'Write it once and add a Questions section in the editor to show it.', '/dashboard/settings#policies', 'Write it in Settings'],
}
function StarterMissing({ missing, published }) {
  const items = missing.filter((k) => MISSING[k])
  if (!items.length) return null
  return (
    <section className="card site-missing" aria-label="Details to add">
      <p>
        <strong>{published ? 'Still missing from your website.' : 'Your draft is ready.'}</strong> We left out what we don’t know yet rather than make it up:
      </p>
      <ul>
        {items.map((k) => (
          <li key={k} data-missing={k}>
            <strong>{MISSING[k][0]}.</strong> {MISSING[k][1]} <a className="link-btn" href={MISSING[k][2]}>{MISSING[k][3]}</a>
          </li>
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
  // The Studio editor has edits the server hasn't confirmed yet: publishing waits (Publish sends the saved draft).
  const [unsaved, setUnsaved] = useState(false)
  const [moreOpen, setMoreOpen] = useState(null) // null = default: open until the site is AI-designed
  const [importing, setImporting] = useState(false) // "I have a website" pressed before a draft exists
  const [publishing, setPublishing] = useState(false)
  const [more, setMore] = useState({})
  const [offline, setOffline] = useState(false) // asking "Take your website offline?"
  const [switching, setSwitching] = useState(false) // asking "Open in the full editor?"
  const [restoring, setRestoring] = useState(null) // a published version being asked about
  if (!data) return <div aria-busy="true" />
  if (data.failed) return <p className="form-error">Couldn’t load your website. Please refresh.</p>
  const w = data.website
  // A multi-page draft (content.site): edited in the full editor. The older template tools would replace it (their
  // results carry no pages), so they are not offered for it; Undo and earlier versions stay available.
  const designed = Boolean(w.draft?.site)
  const live = data.domain?.status === 'connected' ? data.domain.url : data.url
  const address = live.replace(/^https?:\/\//, '')
  const setUsage = (aiUsage) => setData((d) => ({ ...d, aiUsage }))
  const refresh = (d) => {
    setData(d)
    setStamp((n) => n + 1)
  }
  // Returns true when it worked; a failure is shown in the status card (always the first thing on the page).
  const post = async (body, note = null) => {
    setMore({ busy: true })
    const { status, data: d } = await api('/api/dashboard/website', { method: 'POST', body })
    if (status === 200) {
      refresh(d)
      setMore(note ? { note } : {})
      return true
    }
    setMore({ error: d?.error === 'studio_publish_off' ? STUDIO_PRIVATE : d?.error === 'plan_required' ? 'Your plan isn’t active. Reactivate it in Settings first.' : d?.error === 'render_failed' ? 'That version couldn’t be prepared for visitors, so your live website hasn’t changed.' : 'Something went wrong. Please try again.' })
    return false
  }
  const reload = async () => {
    const { status, data: d } = await api('/api/dashboard/website')
    if (status === 200) {
      refresh(d)
      setEditorKey((k) => k + 1)
      setMoreOpen(true)
    }
  }

  // Nothing yet (no draft, nothing live) and the full editor is available: only the start decision is shown.
  const starting = Boolean(data.studio && w.generated && !designed)
  // The full editor is the page (status bar above it, other tools tucked below).
  const studioMode = Boolean(designed && data.studio && !w.generated)
  const canPublish = !w.generated && !pending && !publishing && !unsaved && !(studioOutput(w.draft) && !data.studioPublish)
  const openPublish = () => {
    setPublishing(true)
    document.getElementById('site-publish')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }
  const restoreVersion = async (v) => {
    const ok = await post({ action: 'restore', version: v.version, confirm: true }, `The version published ${day(v.createdAt)} is your live website again.`)
    setRestoring(null)
    if (ok) setEditorKey((k) => k + 1)
    return ok
  }
  // The import + AI designer tools. Always the same element (a <details>) at the same place, so the import/designer
  // state (e.g. "We built your website pages from this.") survives the moment a draft appears; before a draft exists it
  // is shown only once the owner chose "I have a website", and with the form editor it stays open with its toggle hidden.
  const toolsProps = studioMode ? { className: 'card site-more', open: moreOpen ?? false, onToggle: (e) => setMoreOpen(e.currentTarget.open) } : { className: 'site-tools', open: true, hidden: starting && !importing }
  return (
    <div className="enter">
      <h1 className="ui-page-title ui-page-title--top">Website</h1>
      {starting && (
        <WebsiteStart
          data={data}
          onUsage={setUsage}
          onImport={() => {
            setImporting(true)
            // After the section is shown: bring it into view with the address field ready.
            setTimeout(() => {
              const el = document.getElementById('site-import')
              el?.scrollIntoView({ behavior: 'smooth', block: 'start' })
              el?.querySelector('input')?.focus({ preventScroll: true })
            }, 0)
          }}
          onCreated={(d) => {
            refresh(d)
            setEditorKey((k) => k + 1)
          }}
        />
      )}
      {!starting && (
        <section id="site-publish" className={`card site-status${studioMode ? ' site-status--bar' : ''}`} aria-label="Website status">
          <p className="site-status-line">
            <Pill tone={w.published ? (w.changed ? 'warn' : 'ok') : 'neutral'}>{w.published ? 'Live' : 'Not published'}</Pill>
            {w.published ? (w.changed ? <span>You have changes that aren’t published yet</span> : null) : <span>Not published yet</span>}
          </p>
          {w.published && (
            <a className="booking-url booking-url--dark" href={live} target="_blank" rel="noreferrer">
              {address}
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
            {w.published && !offline && !publishing && (
              <button type="button" className="link-btn" onClick={() => setOffline(true)}>
                Take website offline
              </button>
            )}
          </div>
          {offline && (
            <ConfirmInline
              question="Take your website offline?"
              detail={`Visitors to ${address} will see “This website isn’t available” until you publish again. Your booking page keeps working, and your content, draft and published versions are kept.`}
              confirmLabel="Take website offline"
              busy={more.busy}
              onConfirm={async () => {
                await post({ action: 'unpublish' }, 'Your website is offline. Visitors see “This website isn’t available”. Publish again whenever you’re ready.')
                setOffline(false)
              }}
              onCancel={() => setOffline(false)}
            />
          )}
          {more.note && (
            <p className="fine" role="status" data-site-note>
              {more.note}
            </p>
          )}
          {more.error && (
            <p className="form-error" role="alert">
              {more.error}
            </p>
          )}
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
                  setMore({})
                  refresh(d)
                }}
              />
              <button type="button" className="link-btn" onClick={() => setPublishing(false)}>
                Not yet
              </button>
            </>
          )}
        </section>
      )}
      {!starting && <StarterMissing missing={data.missing || []} published={Boolean(w.published)} />}

      {/* An existing single-page website (made in setup or with the older editor) is never converted by itself; the owner
          can move it to the full editor (pages, sections, History). The draft as it was is kept in History. */}
      {data.studio && !designed && !w.generated && !pending && (
        <section className="card site-switch" aria-label="Full editor">
          {switching ? (
            <ConfirmInline
              question="Open your website in the full editor?"
              detail="Your text, services, prices, photos and colours come with you. The page is rebuilt for the full editor, so the layout will look a little different: check it before you publish. Your live website doesn’t change until you publish, and this draft is kept under History so you can come back."
              confirmLabel="Open in the full editor"
              danger={false}
              busy={more.busy}
              onConfirm={async () => {
                const ok = await post({ action: 'starter' })
                setSwitching(false)
                if (ok) setEditorKey((k) => k + 1)
              }}
              onCancel={() => setSwitching(false)}
            />
          ) : (
            <p className="site-switch-line">
              <span>
                <strong>Want more pages, or to hide, move and add sections?</strong> The full editor does that, and keeps earlier versions of your draft.
              </span>
              <button type="button" className="btn btn-quiet btn-sm" onClick={() => setSwitching(true)}>
                Open in the full editor
              </button>
            </p>
          )}
        </section>
      )}

      {!designed && !starting && (
      <section id="site-create" className="card" aria-label="Create with AI">
        {w.generated || rewrite ? (
          <WebsiteGenerator
            hasDraft={!w.generated}
            templates={rewrite === 'templates'}
            usage={data.aiUsage}
            storeKey={data.url}
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
              storeKey={data.url}
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
            // The full editor: edit the multi-page website directly (no AI), with live preview and autosave.
            <SiteStudio
              key={editorKey}
              storeKey={data.url}
              website={w}
              assets={data.assets}
              brand={data.brand}
              visit={data.visit}
              checkpoints={data.checkpoints || []}
              versions={w.versions}
              stock={data.stock || []}
              restoring={more.busy}
              onRestoreVersion={restoreVersion}
              onSaved={refresh}
              onUnsaved={setUnsaved}
            />
          ) : (
            <section className="site-preview-wrap" aria-label="Preview">
              <WebsitePreview stamp={stamp} query={pending ? `generation=${pending.id}&option=0&` : ''} unsaved={Boolean(pending)} />
            </section>
          )}
          {/* One editor per draft: the full editor (above) replaces this form for multi-page websites, so two autosaving
              copies can't overwrite each other. */}
          {!(designed && data.studio) && (
            <section className="card site-editor" aria-label="Edit website">
              <h2 className="card-title">Edit text and photos</h2>
              <WebsiteEditor key={editorKey} initial={w.draft} baseUpdatedAt={w.updatedAt} colors={data.options.colors} designOptions={data.options} onSaved={refresh} designed={designed ? 'locked' : false} />
            </section>
          )}
        </div>
      )}

      {!starting && <WebsiteJourney data={data} onPublish={openPublish} canPublish={canPublish} />}

      {/* Import + AI designer: one fixed place (never remounted, so a conversation in progress is kept). */}
      {data.studio && (
        <details {...toolsProps}>
          <summary hidden={!studioMode}>Import your current website · AI designer (uses your own AI account)</summary>
          <section id="site-import" className="card" aria-label="Bring your current website">
            <h2 className="card-title">Bring your current website</h2>
            <WebsiteImport defaultUrl={data.domain?.hostname || ''} hasContent={Boolean(designed || w.published)} onApplied={reload} />
          </section>
          {!starting && (
            <section className="card" aria-label="AI designer">
              <h2 className="card-title">AI designer</h2>
              <WebsiteDesigner onChanged={reload} />
            </section>
          )}
        </details>
      )}

      {/* Address and hosting: after a draft exists, under one disclosure (open while a domain is being connected). */}
      {!starting && (
        <details className="card site-more" id="site-address" open={Boolean(data.domain) || undefined}>
          <summary>Website address and hosting · {address}</summary>
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
        </details>
      )}

      {!starting && (
        <section className="card">
          <details className="more more--flat">
            <summary>{studioMode ? 'Download my content' : 'Published versions and download'}</summary>
            {/* With the full editor, published versions are listed in its History tab (one place for every version). */}
            {!studioMode &&
              (w.versions.length > 0 ? (
                <ul className="rows">
                  {w.versions.map((v) => (
                    <li key={v.version} className="row">
                      <div className="row-main">
                        <p className="row-title">
                          Published {day(v.createdAt)}
                          {v.live && <span className="tag tag--ok">Live</span>}
                        </p>
                        {restoring === v.version && (
                          <ConfirmInline
                            question={`Make the version published ${day(v.createdAt)} your live website again?`}
                            detail="Visitors will see it right away, and your draft becomes that version too: changes you made since then are replaced. You can switch back from this list."
                            confirmLabel="Restore this version"
                            busy={more.busy}
                            onConfirm={() => restoreVersion(v)}
                            onCancel={() => setRestoring(null)}
                          />
                        )}
                      </div>
                      {!v.live && restoring !== v.version && (
                        <button type="button" className="btn btn-quiet btn-sm" disabled={more.busy} onClick={() => setRestoring(v.version)}>
                          Restore
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="fine">Each time you publish, we keep a copy you can go back to.</p>
              ))}
            <div className="card-actions">
              <a className="btn btn-quiet btn-sm" href="/api/dashboard/website/export" download>
                Download my content
              </a>
            </div>
            <p className="fine">Your text and photos belong to you. Download them any time.</p>
          </details>
        </section>
      )}
    </div>
  )
}
