// Where the website lives. Building it and hosting it are separate: GetShowUps hosting is the default (publishing,
// HTTPS, your domain, booking and chat built in); the owner can instead download the published website as plain files
// for any static host. Domain registration stays wherever the owner keeps it.
import { useState } from 'react'

export default function WebsiteHosting({ published }) {
  const [own, setOwn] = useState(false)
  return (
    <section id="site-hosting" className="card" aria-label="Where your website lives">
      <h2 className="card-title">Where your website lives</h2>
      <div className="choice-list" role="radiogroup" aria-label="Hosting">
        <label className="choice-card">
          <input type="radio" name="hosting" checked={!own} onChange={() => setOwn(false)} />
          <span>
            <strong>Host with GetShowUps (recommended)</strong>
            <span className="fine">Publish with one click, secure (https) on your own domain, and booking, chat and forms keep working. Included in your plan.</span>
          </span>
        </label>
        <label className="choice-card">
          <input type="radio" name="hosting" checked={own} onChange={() => setOwn(true)} />
          <span>
            <strong>Use my own hosting</strong>
            <span className="fine">Download your website as plain files and upload them to any static web host.</span>
          </span>
        </label>
      </div>
      {own && (
        <div className="stack">
          {published ? (
            <a className="btn btn-quiet btn-sm" href="/api/dashboard/website/export?format=static" download>
              Download my website (.zip)
            </a>
          ) : (
            <p className="fine">Publish your website first; the download is your published version.</p>
          )}
          <ul className="fine hosting-notes">
            <li>Works with static hosts such as Cloudflare Pages, Netlify or GitHub Pages: upload the folder and point your domain to that host.</li>
            <li>Squarespace and Wix can’t host an uploaded website. You can keep your domain registered there and point it to another host.</li>
            <li>Booking and chat buttons link to your GetShowUps pages, so they keep working anywhere. Contact forms need GetShowUps hosting.</li>
            <li>Changes you make here aren’t sent to your other host: download and upload again after you publish.</li>
          </ul>
        </div>
      )}
    </section>
  )
}
