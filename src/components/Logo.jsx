// The GetShowUps logo: the Calendar + Growth icon and the wordmark. The icon geometry is the canonical brand asset
// brand/icon/getshowups-icon.svg (test/brand.test.js keeps them identical); the wordmark is live text styled by .logo in
// index.css. Never redraw or recolour either here: change brand/ first (brand/README.md), then mirror it.
export default function Logo({ className = '', href = '#top' }) {
  return (
    <a href={href} className={`logo ${className}`} aria-label="GetShowUps home">
      <svg viewBox="0 0 32 32" width="28" height="28" aria-hidden="true">
        <rect width="32" height="32" rx="8" className="logo-bg" />
        <path d="M19.3 9.5H9a3 3 0 0 0-3 3v10a3 3 0 0 0 3 3h11a3 3 0 0 0 3-3V13.2" fill="none" stroke="#FF6A1A" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M10 7v4M15 7v4" fill="none" stroke="#FF6A1A" strokeWidth="2.2" strokeLinecap="round" />
        <path d="M9.5 16L13 19.5L23.21 9.29" fill="none" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M27.1 5.4L21.09 6.74L25.76 11.41Z" fill="#fff" />
      </svg>
      <span>
        GetShow<span className="logo-accent">Ups</span>
      </span>
    </a>
  )
}
