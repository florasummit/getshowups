import { useEffect, useState } from 'react'
import Icon from './Icon.jsx'
import Logo from './Logo.jsx'
import GetStarted from './GetStarted.jsx'
import { INVITED_HREF, useEnrollmentOpen } from '../lib/enrollment.js'
import { navLinks } from '../content/site.js'
import { track } from '../lib/analytics.js'

export default function Header() {
  const [open, setOpen] = useState(false)
  const [scrolled, setScrolled] = useState(false)

  const [dark, setDark] = useState(false)
  // Public sign-up closed: people we arranged a start with get their own way in, not hidden behind "Sign in".
  const closed = useEnrollmentOpen() === false

  // Solid after a few pixels; dark while a dark section (or the footer) sits under the header line.
  useEffect(() => {
    const onScroll = () => {
      setScrolled(window.scrollY > 8)
      const y = window.scrollY + 34
      const under = [...document.querySelectorAll('main > section, footer')].find((s) => s.offsetTop <= y && s.offsetTop + s.offsetHeight > y)
      const from = Number(under?.dataset.darkFrom || 0) // a dark section whose first pixels are still light (the stage straddles the hero)
      setDark(Boolean(under && (under.classList.contains('section--dark') || under.tagName === 'FOOTER') && y >= under.offsetTop + from))
    }
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', onScroll)
    return () => {
      window.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onScroll)
    }
  }, [])

  useEffect(() => {
    if (!open) return
    const onKey = (e) => e.key === 'Escape' && setOpen(false)
    const onResize = () => window.innerWidth > 900 && setOpen(false)
    document.addEventListener('keydown', onKey)
    window.addEventListener('resize', onResize)
    document.body.classList.add('nav-open')
    return () => {
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', onResize)
      document.body.classList.remove('nav-open')
    }
  }, [open])

  const close = () => setOpen(false)

  return (
    <header className={`site-header ${scrolled || open ? 'is-solid' : ''} ${dark && !open ? 'is-dark' : ''}`}>
      <div className="container header-inner">
        <Logo mark={false} />
        <nav aria-label="Primary" className="desktop-nav">
          <ul>
            {navLinks.map((l) => (
              <li key={l.href}>
                <a href={l.href}>{l.label}</a>
              </li>
            ))}
          </ul>
        </nav>
        {closed && (
          <a href={INVITED_HREF} className="header-login header-invited" data-invited-entry>
            Invited? Set up
          </a>
        )}
        <a href="/dashboard" className="header-login">
          Sign in
        </a>
        <GetStarted location="header" className="btn btn-ink btn-sm header-cta" onClick={() => track('early_access_cta', { location: 'header' })} />
        <button
          type="button"
          className="menu-toggle"
          aria-expanded={open}
          aria-controls="mobile-nav"
          aria-label={open ? 'Close menu' : 'Open menu'}
          onClick={() => setOpen((v) => !v)}
        >
          <Icon name={open ? 'close' : 'menu'} size={24} />
        </button>
      </div>
      <nav id="mobile-nav" aria-label="Mobile" className={`mobile-nav ${open ? 'is-open' : ''}`} hidden={!open}>
        <ul>
          {navLinks.map((l) => (
            <li key={l.href}>
              <a href={l.href} onClick={close}>
                {l.label}
              </a>
            </li>
          ))}
        </ul>
        {closed && (
          <a href={INVITED_HREF} className="btn btn-ghost btn-block" data-invited-entry>
            Invited? Set up your business
          </a>
        )}
        <a href="/dashboard" className="btn btn-ghost btn-block">
          Sign in
        </a>
        <GetStarted
          location="mobile_nav"
          className="btn btn-ink btn-block"
          onClick={() => {
            track('early_access_cta', { location: 'mobile_nav' })
            close()
          }}
        />
      </nav>
    </header>
  )
}
