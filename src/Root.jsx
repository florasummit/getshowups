import { Suspense } from 'react'
import { lazyPage } from './lib/lazy.js'
import App from './App.jsx'
import { captureReferral } from './lib/referral.js'

// App pages are separate lazy chunks so the marketing page stays small.
const Dashboard = lazyPage(() => import('./dashboard/Dashboard.jsx'))
const EmailLink = lazyPage(() => import('./dashboard/EmailLink.jsx'))
const BookingPage = lazyPage(() => import('./booking/BookingPage.jsx'))
const Admin = lazyPage(() => import('./admin/Admin.jsx'))
const ResearchVault = lazyPage(() => import('./admin/research/ResearchVault.jsx'))
const Privacy = lazyPage(() => import('./legal/Privacy.jsx'))
const ChatPage = lazyPage(() => import('./receptionist/ChatPage.jsx'))
const Claim = lazyPage(() => import('./claim/Claim.jsx'))

// First-touch acquisition source (utm_source or ref), kept on this device for signup attribution.
try {
  const params = new URLSearchParams(window.location.search)
  const src = params.get('utm_source') || params.get('ref')
  if (src && !localStorage.getItem('gsu_source')) localStorage.setItem('gsu_source', src.slice(0, 40))
} catch {
  // storage unavailable: attribution falls back to 'direct'
}
captureReferral()

export default function Root() {
  const path = window.location.pathname
  const booking = path.match(/^\/book\/([a-z0-9][a-z0-9-]{1,62})\/?$/)
  if (booking) {
    return (
      <Suspense fallback={null}>
        <BookingPage id={booking[1]} />
      </Suspense>
    )
  }
  const chat = path.match(/^\/chat\/([a-z0-9][a-z0-9-]{1,62})\/?$/)
  if (chat) {
    return (
      <Suspense fallback={null}>
        <ChatPage id={chat[1]} />
      </Suspense>
    )
  }
  if (path === '/privacy' || path === '/privacy/') {
    return (
      <Suspense fallback={null}>
        <Privacy />
      </Suspense>
    )
  }
  if (path === '/claim' || path === '/claim/') {
    return (
      <Suspense fallback={null}>
        <Claim />
      </Suspense>
    )
  }
  // Research Vault: its own lazy chunk, not in any navigation; the server authorizes every request (404 otherwise).
  if (path === '/admin/research-vault' || path.startsWith('/admin/research-vault/')) {
    return (
      <Suspense fallback={null}>
        <ResearchVault />
      </Suspense>
    )
  }
  if (path === '/admin' || path.startsWith('/admin/')) {
    return (
      <Suspense fallback={null}>
        <Admin />
      </Suspense>
    )
  }
  // The link in a sign-in email (before the dashboard: it must not first ask "who is signed in?").
  if (path === '/dashboard/email-sign-in') {
    return (
      <Suspense fallback={null}>
        <EmailLink />
      </Suspense>
    )
  }
  if (path === '/dashboard' || path.startsWith('/dashboard/')) {
    return (
      <Suspense fallback={null}>
        <Dashboard />
      </Suspense>
    )
  }
  return <App />
}
