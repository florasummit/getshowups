import Logo from './Logo.jsx'
import { navLinks } from '../content/site.js'

const year = new Date().getFullYear()

export default function Footer() {
  return (
    <footer className="site-footer">
      <div className="container footer-cta">
        <h2>Ready to stop losing booked leads to no-shows?</h2>
        <a href="#book-demo" className="btn btn-primary btn-lg">
          Book a Demo
        </a>
      </div>
      <div className="container footer-inner">
        <div className="footer-brand">
          <Logo className="logo--light" />
          <p>AI-powered appointment conversion for service businesses.</p>
        </div>
        <nav aria-label="Footer">
          <ul className="footer-links">
            {navLinks.map((l) => (
              <li key={l.href}>
                <a href={l.href}>{l.label}</a>
              </li>
            ))}
            <li>
              <a href="#book-demo">Book a Demo</a>
            </li>
            <li>
              <a href="/dashboard">Log in</a>
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
