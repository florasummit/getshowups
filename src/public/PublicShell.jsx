// The frame of every public customer page (booking, chat): the business's own brand at the top (its published logo
// or a letter mark in its colour, never GetShowUps branding on a customer's page), the content, and a quiet footer.
// GetShowUps' own pages (brand.product) show the canonical logo (src/components/Logo.jsx). Styles: ./public.css.
import Logo from '../components/Logo.jsx'
import { accentVars } from './color.js'
import './public.css'

export function BrandMark({ name, brand, href }) {
  if (brand?.product) return <Logo href={href || '/'} />
  const body = brand?.logo ? (
    <img src={brand.logo} alt={name} />
  ) : (
    <>
      <span className="pub-brand-mark" aria-hidden="true">
        {String(name || '?').trim()[0]?.toUpperCase()}
      </span>
      <span className="pub-brand-name">{name}</span>
    </>
  )
  return href ? (
    <a className="pub-brand" href={href}>
      {body}
    </a>
  ) : (
    <span className="pub-brand">{body}</span>
  )
}

export default function PublicShell({ name, brand, homeHref, aside, preview, footer = true, embed = false, children }) {
  return (
    <div className={`pub${embed ? ' pub--embed' : ''}`} style={accentVars(brand?.accent, { product: brand?.product })}>
      {preview && (
        <p className="pub-preview" role="status">
          Preview. Nothing you enter here is booked or sent.
        </p>
      )}
      {!embed && (
        <header className="pub-top">
          <BrandMark name={name} brand={brand} href={homeHref} />
          {aside}
        </header>
      )}
      <main className="pub-main">{children}</main>
      {footer && !embed && (
        <footer className="pub-foot">
          {/* New tab: a customer part-way through booking never loses the page (and what they typed) to a footer link. */}
          {!brand?.product && (
            <span>
              Booking by{' '}
              <a href="https://getshowups.com/" target="_blank" rel="noopener">
                GetShowUps
              </a>
            </span>
          )}
          <a href="/privacy" target="_blank" rel="noopener">
            Privacy
          </a>
        </footer>
      )}
    </div>
  )
}
