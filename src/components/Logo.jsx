export default function Logo({ className = '' }) {
  return (
    <a href="#top" className={`logo ${className}`} aria-label="GetShowUps home">
      <svg viewBox="0 0 32 32" width="28" height="28" aria-hidden="true">
        <rect width="32" height="32" rx="8" className="logo-bg" />
        <rect x="7" y="9" width="18" height="16" rx="3" fill="none" stroke="#FF6A1A" strokeWidth="2.2" />
        <path d="M11 6.5v4M21 6.5v4" stroke="#FF6A1A" strokeWidth="2.2" strokeLinecap="round" />
        <path d="m12 17.5 3 3 5.5-6" fill="none" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span>
        GetShow<span className="logo-accent">Ups</span>
      </span>
    </a>
  )
}
