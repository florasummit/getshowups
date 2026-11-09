import { Suspense, lazy } from 'react'
import App from './App.jsx'

// App pages are separate lazy chunks so the marketing page stays small.
const Dashboard = lazy(() => import('./dashboard/Dashboard.jsx'))
const BookingPage = lazy(() => import('./booking/BookingPage.jsx'))
const Admin = lazy(() => import('./admin/Admin.jsx'))
const Privacy = lazy(() => import('./legal/Privacy.jsx'))
const LandingPage = lazy(() => import('./landing/LandingPage.jsx'))

// First-touch acquisition source (utm_source or ref), kept on this device for signup attribution.
try {
  const params = new URLSearchParams(window.location.search)
  const src = params.get('utm_source') || params.get('ref')
  if (src && !localStorage.getItem('gsu_source')) localStorage.setItem('gsu_source', src.slice(0, 40))
} catch {
  // storage unavailable: attribution falls back to 'direct'
}

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
  const landing = path.match(/^\/p\/([a-z0-9][a-z0-9-]{1,62})\/?$/)
  if (landing) {
    return (
      <Suspense fallback={null}>
        <LandingPage id={landing[1]} />
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
  if (path === '/admin' || path.startsWith('/admin/')) {
    return (
      <Suspense fallback={null}>
        <Admin />
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
