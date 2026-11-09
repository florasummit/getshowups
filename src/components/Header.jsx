import { useEffect, useState } from 'react'
import Icon from './Icon.jsx'
import Logo from './Logo.jsx'
import { navLinks } from '../content/site.js'

export default function Header() {
  const [open, setOpen] = useState(false)
  const [scrolled, setScrolled] = useState(false)

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8)
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
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
    <header className={`site-header ${scrolled || open ? 'is-solid' : ''}`}>
      <div className="container header-inner">
        <Logo />
        <nav aria-label="Primary" className="desktop-nav">
          <ul>
            {navLinks.map((l) => (
              <li key={l.href}>
                <a href={l.href}>{l.label}</a>
              </li>
            ))}
          </ul>
        </nav>
        <a href="/dashboard" className="header-login">
          Log in
        </a>
        <a href="#book-demo" className="btn btn-primary btn-sm header-cta">
          Book a Demo
        </a>
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
        <a href="/dashboard" className="btn btn-ghost btn-block">
          Log in
        </a>
        <a href="#book-demo" className="btn btn-primary btn-block" onClick={close}>
          Book a Demo
        </a>
      </nav>
    </header>
  )
}
