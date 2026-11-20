import Logo from './Logo.jsx'
import GetStarted from './GetStarted.jsx'
import { navLinks } from '../content/site.js'
import { track } from '../lib/analytics.js'

const year = new Date().getFullYear()

export default function Footer() {
  return (
    <footer className="site-footer">
      <div className="container footer-cta">
        <h2>
          More booked jobs. <em>Less chasing.</em>
        </h2>
        <GetStarted className="btn btn-primary btn-lg" onClick={() => track('early_access_cta', { location: 'footer' })} />
      </div>
      <div className="container footer-inner">
        <div className="footer-brand">
          <Logo className="logo--light" />
          <p>AI answering, qualifying and booking for pool, HVAC and roofing businesses.</p>
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
