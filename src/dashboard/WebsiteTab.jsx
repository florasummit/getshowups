// Website tab: is my site live, edit it (autosaved), preview, publish, address/domain, earlier versions.
import { useState } from 'react'
import { api, fmt } from '../lib/api.js'
import WebsiteEditor, { WebsitePreview } from './WebsiteEditor.jsx'
import { problemText, useWebsite } from './website-data.js'
import DomainSettings from './DomainSettings.jsx'
import WebsiteGenerator from './WebsiteGenerator.jsx'

const day = (ms) => fmt(new Date(ms).toISOString(), undefined, { month: 'short', day: 'numeric', year: 'numeric' })

export function PublishBox({ data, onDone, label = 'Publish', secondary }) {
  const [ok, setOk] = useState(false)
  const [state, setState] = useState({})
  const address = (data.domain?.status === 'connected' ? data.domain.url : data.url).replace(/^https?:\/\//, '')
  const publish = async () => {
    setState({ busy: true })
    const { status, data: d } = await api('/api/dashboard/website', { method: 'POST', body: { action: 'publish', content: data.website.draft, confirm: true } })
    if (status === 200) return onDone(d)
    setState({
      error:
        d.error === 'not_ready'
          ? 'Connect your calendar and set your hours first, so customers can book.'
          : d.error === 'plan_required'
            ? 'Your plan isn’t active. Reactivate it in Settings to publish.'
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
      {state.error && (
        <p className="form-error" role="alert">
          {state.error}
        </p>
      )}
      <button type="button" className="btn btn-primary btn-lg btn-block" disabled={!ok || state.busy} onClick={publish}>
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

export default function WebsiteTab() {
  const [data, setData] = useWebsite()
  const [stamp, setStamp] = useState(0)
  const [rewrite, setRewrite] = useState(false)
  const [editorKey, setEditorKey] = useState(0)
  const [publishing, setPublishing] = useState(false)
  const [more, setMore] = useState({})
  if (!data) return <div aria-busy="true" />
  if (data.failed) return <p className="form-error">Couldn’t load your website. Please refresh.</p>
  const w = data.website
  const live = data.domain?.status === 'connected' ? data.domain.url : data.url
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
    } else setMore({ error: 'Something went wrong. Please try again.' })
  }

  return (
    <div className="enter">
      <h1 className="title title--page">Website</h1>
      <section className="card site-status" aria-label="Website status">
        <p className={`status status--${w.published ? (w.changed ? 'pending' : 'ok') : 'bad'}`}>
          <span className="status-dot" aria-hidden="true" />
          {w.published ? (w.changed ? 'Live · you have changes that aren’t published yet' : 'Live') : 'Not published yet'}
        </p>
        {w.published && (
          <a className="booking-url booking-url--dark" href={live} target="_blank" rel="noreferrer">
            {live.replace(/^https?:\/\//, '')}
          </a>
        )}
        <HostingNotice hosting={data.hosting} />
        <div className="card-actions">
          {!w.generated && (!w.published || w.changed) && (
            <button type="button" className="btn btn-primary" onClick={() => setPublishing(!publishing)} aria-expanded={publishing}>
              {w.published ? 'Publish changes' : 'Publish website'}
            </button>
          )}
          {w.published && (
            <a className="btn btn-quiet" href={live} target="_blank" rel="noreferrer">
              View website
            </a>
          )}
        </div>
        {publishing && (
          <PublishBox
            data={data}
            label={w.published ? 'Publish changes' : 'Publish website'}
            onDone={(d) => {
              setPublishing(false)
              refresh(d)
            }}
          />
        )}
      </section>

      <section className="card" aria-label="Create with AI">
        {w.generated || rewrite ? (
          <WebsiteGenerator
            hasDraft={!w.generated}
            intro={w.generated ? 'We’ll write your website from your business details. You choose the design, check it, then publish.' : null}
            onApplied={(d) => {
              setRewrite(false)
              refresh(d)
              setEditorKey((k) => k + 1)
            }}
          />
        ) : (
          <div className="generator-row">
            <p className="fine">Want fresh wording? We can write it again from your business details.</p>
            <button type="button" className="btn btn-quiet btn-sm" onClick={() => setRewrite(true)}>
              Write it again
            </button>
          </div>
        )}
      </section>

      {!w.generated && (
        <>
          <section className="site-preview-wrap" aria-label="Preview">
            <WebsitePreview stamp={stamp} />
          </section>
          <section className="card site-editor" aria-label="Edit website">
            <h2 className="card-title">Edit text and photos</h2>
            <WebsiteEditor key={editorKey} initial={w.draft} colors={data.options.colors} onSaved={refresh} />
          </section>
        </>
      )}

      <section className="card">
        <h2 className="card-title">Website address</h2>
        <DomainSettings siteUrl={data.url} />
      </section>

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
                    <button type="button" className="btn btn-quiet btn-sm" disabled={more.busy} onClick={() => post({ action: 'restore', version: v.version })}>
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
