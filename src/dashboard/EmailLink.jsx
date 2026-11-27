// /dashboard/email-sign-in#t=… — the link in a sign-in email. Opening it changes nothing (mail scanners open links):
// the person clicks "Sign in", which POSTs the token. The token travels in the #fragment, so it never reaches a server
// log or a Referer header, and it is removed from the address bar at once. Works only in the browser that asked;
// elsewhere the person types the code from the same email instead.
import { useEffect, useState } from 'react'
import Logo from '../components/Logo.jsx'
import { api, noIndex } from '../lib/api.js'
import { CodeForm } from './SignIn.jsx'
import '../app.css'

const PROBLEMS = {
  other_browser: ['Use the code instead', 'This link only works in the browser where you asked to sign in. Enter your email and the 6-digit code from the same email.'],
  link_expired: ['This link has expired', 'Sign-in links work for 15 minutes. Ask for a new one and use it right away.'],
  link_used: ['This link was already used', 'Each sign-in link works once. If you’re not signed in, ask for a new one.'],
  link_invalid: ['This link isn’t complete', 'Open the link straight from the email, or copy all of it. You can also sign in again from the start.'],
  rate_limited: ['Too many tries', 'Wait a few minutes, then open the link again.'],
  not_available: ['Email sign-in isn’t available', 'Continue with Google instead, or try again later.'],
}

const readToken = () => {
  const t = new URLSearchParams(window.location.hash.slice(1)).get('t')
  // Out of the address bar and the history (a shared screenshot or Back never shows it).
  if (window.location.hash) window.history.replaceState(null, '', window.location.pathname)
  return t && /^[A-Za-z0-9_-]{43}$/.test(t) ? t : ''
}

export default function EmailLink() {
  const [token] = useState(readToken)
  const [state, setState] = useState(token ? {} : { error: 'link_invalid' })
  useEffect(() => {
    document.title = 'Sign in · GetShowUps'
    return noIndex()
  }, [])
  const go = (to) => window.location.assign(to || '/dashboard')
  const confirm = async () => {
    setState({ busy: true })
    const { status, data } = await api('/api/auth/email/verify', { method: 'POST', body: { token } })
    if (status === 200) return go(data.next)
    setState({ error: PROBLEMS[data.error] ? data.error : 'failed' })
  }
  const [title, text] = PROBLEMS[state.error] || (state.error ? ['We couldn’t sign you in', 'Something went wrong on our side. Please try again.'] : ['Sign in to GetShowUps', 'You’re one click away from your dashboard.'])
  return (
    <main className="center-page">
      <div className="panel panel--narrow enter signin" data-email-link={state.error || 'ready'}>
        <Logo href="/" />
        <h1 className="title">{title}</h1>
        <p className="lede">{text}</p>
        {!state.error && (
          <button type="button" className="btn btn-primary btn-lg btn-block" onClick={confirm} disabled={state.busy} data-confirm-link>
            {state.busy ? 'Signing in…' : 'Sign in'}
          </button>
        )}
        {state.error === 'other_browser' && <CodeForm askEmail onSignedIn={go} />}
        {state.error === 'failed' && (
          <button type="button" className="btn btn-primary btn-lg btn-block" onClick={confirm}>
            Try again
          </button>
        )}
        {state.error && state.error !== 'failed' && (
          <a className={`btn ${state.error === 'other_browser' ? 'btn-quiet' : 'btn-primary'} btn-lg btn-block`} href="/dashboard?email=1">
            {state.error === 'other_browser' ? 'Start over' : 'Sign in again'}
          </a>
        )}
      </div>
    </main>
  )
}
