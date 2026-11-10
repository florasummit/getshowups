import Logo from './Logo.jsx'
import { getStarted, navLinks } from '../content/site.js'

const year = new Date().getFullYear()

export default function Footer() {
  return (
    <footer className="site-footer">
      <div className="container footer-cta">
        <h2>Ready to turn more leads into booked appointments?</h2>
        <a href={getStarted.href} className="btn btn-primary btn-lg">
          {getStarted.label}
        </a>
      </div>
      <div className="container footer-inner">
        <div className="footer-brand">
          <Logo className="logo--light" />
          <p>Online booking and show-up tracking for service businesses.</p>
        </div>
        <nav aria-label="Footer">
          <ul className="footer-links">
            {navLinks.map((l) => (
              <li key={l.href}>
                <a href={l.href}>{l.label}</a>
              </li>
            ))}
            <li>
              <a href="#book-demo">Book a call</a>
            </li>
            <li>
              <a href="/dashboard">Sign in</a>
            </li>
            <li>
              <a href="/privacy">Privacy</a>
            </li>
          </ul>
        </nav>
      </div>
      <div className="container footer-bottom">
        <p>© {year} GetShowUps. All rights reserved.</p>
        <p>Pricing shown is proposed and subject to change.</p>
      </div>
    </footer>
  )
}
