// /dashboard: sign-in → (accept invitation) → setup (business → calendar → hours) → home.
// Progress comes from the server, so setup resumes where the user left off on any device.
import { useCallback, useEffect, useState } from 'react'
import Logo from '../components/Logo.jsx'
import { api, noIndex } from '../lib/api.js'
import Setup from './Setup.jsx'
import Home, { SignOut } from './Home.jsx'
import '../app.css'

const LOGIN_ERRORS = {
  expired: 'That sign-in expired. Please try again.',
  cancelled: 'Sign-in was cancelled.',
  failed: 'We couldn’t sign you in. Please try again.',
  rate_limited: 'Too many sign-in attempts. Please wait a few minutes.',
}

// An invitation token arrives as ?invite=… and is kept for this tab until sign-in completes.
const INVITE_KEY = 'gsu_invite'
function pendingInvite() {
  try {
    const fromUrl = new URLSearchParams(window.location.search).get('invite')
    if (fromUrl) {
      sessionStorage.setItem(INVITE_KEY, fromUrl)
      window.history.replaceState(null, '', '/dashboard')
    }
    return sessionStorage.getItem(INVITE_KEY)
  } catch {
    return null
  }
}
// "Get started" sends visitors to /dashboard?plan=founding; the plan survives the Google round trip.
const PLAN_KEY = 'gsu_plan'
function pendingPlan() {
  try {
    const fromUrl = new URLSearchParams(window.location.search).get('plan')
    if (fromUrl && /^[a-z0-9-]{1,40}$/.test(fromUrl)) localStorage.setItem(PLAN_KEY, fromUrl)
    return localStorage.getItem(PLAN_KEY)
  } catch {
    return null
  }
}

const clearInvite = () => {
  try {
    sessionStorage.removeItem(INVITE_KEY)
  } catch {
    // ignore
  }
}

function SignIn({ invite, plan }) {
  const message = LOGIN_ERRORS[new URLSearchParams(window.location.search).get('login_error')]
  const signup = plan && !invite
  return (
    <main className="center-page">
      <div className="panel panel--narrow enter">
        <Logo href="/" />
        <h1 className="title">{invite ? `Join ${invite.businessName}` : signup ? 'Create your GetShowUps account' : 'Welcome back'}</h1>
        <p className="lede">
          {invite
            ? `Sign in with the Google account for ${invite.email}.`
            : signup
              ? 'Use the Google account that has the calendar you book appointments on. Next: your business name, then the $499/month founding plan.'
              : 'Sign in to manage your booking page.'}
        </p>
        {message && (
          <p className="form-error" role="alert">
            {message}
          </p>
        )}
        <a className="btn btn-primary btn-lg btn-block" href="/api/auth/google/start">
          Continue with Google
        </a>
        <p className="fine">We only use your email address to sign you in. Google verifies it, so there’s no password to manage.</p>
        {!invite && (
          <p className="fine">
            {signup ? (
              <>
                Already have an account? <a href="/dashboard">Sign in</a>
              </>
            ) : (
              <>
                New to GetShowUps? <a href="/dashboard?plan=founding">Create an account</a>
              </>
            )}
          </p>
        )}
      </div>
    </main>
  )
}

const INVITE_ERRORS = {
  invite_invalid: 'This invitation has expired or was already used. Ask GetShowUps for a new one.',
  already_in_business: 'This Google account already belongs to a business.',
}

function InviteProblem({ error, expected, email }) {
  return (
    <main className="center-page">
      <div className="panel panel--narrow enter">
        <h1 className="title">Invitation not accepted</h1>
        <p className="lede">
          {error === 'wrong_account'
            ? `This invitation is for ${expected}. You’re signed in as ${email}.`
            : INVITE_ERRORS[error] || 'Something went wrong. Please try again.'}
        </p>
        <SignOut email={email} label={error === 'wrong_account' ? 'Use a different account' : 'Sign out'} />
        <a className="link-btn" href="/dashboard" onClick={clearInvite}>
          Continue without the invitation
        </a>
      </div>
    </main>
  )
}

export default function Dashboard() {
  const [me, setMe] = useState({ loading: true })
  const [invite] = useState(pendingInvite)
  const [plan] = useState(pendingPlan)
  const [invitePreview, setInvitePreview] = useState(null)
  const [inviteError, setInviteError] = useState(null)

  // Resolves the account, accepting a pending invitation first when the user has no business yet.
  const resolve = useCallback(async () => {
    const { status, data } = await api(`/api/dashboard/me${plan ? `?plan=${encodeURIComponent(plan)}` : ''}`)
    if (status === 200 && invite && !data.customer) {
      const r = await api('/api/dashboard/accept-invite', { method: 'POST', body: { token: invite } })
      if (r.status === 200) {
        clearInvite()
        const again = await api('/api/dashboard/me')
        return { me: again.status === 200 ? { data: again.data } : { error: true } }
      }
      return { me: { data }, inviteError: r.data }
    }
    if (status === 200 && invite) clearInvite()
    return { me: status === 200 ? { data } : status === 401 ? { signedOut: true } : { error: true } }
  }, [invite, plan])

  const load = useCallback(
    () =>
      resolve().then((r) => {
        setInviteError(r.inviteError || null)
        setMe(r.me)
      }),
    [resolve],
  )

  useEffect(() => {
    document.title = 'GetShowUps'
    const cleanup = noIndex()
    load()
    if (invite) api(`/api/invite?token=${encodeURIComponent(invite)}`).then(({ status, data }) => status === 200 && setInvitePreview(data))
    return cleanup
  }, [load, invite])

  if (me.loading) return <main className="center-page" aria-busy="true" />
  if (me.signedOut) return <SignIn invite={invitePreview} plan={plan} />
  if (me.error) {
    return (
      <main className="center-page">
        <div className="panel panel--narrow enter">
          <p className="lede">We can’t reach your account right now.</p>
          <button type="button" className="btn btn-primary btn-block" onClick={() => location.reload()}>
            Try again
          </button>
        </div>
      </main>
    )
  }
  if (inviteError && !me.data.customer) return <InviteProblem {...inviteError} email={me.data.email} />
  return me.data.progress.complete ? <Home me={me.data} reload={load} /> : <Setup me={me.data} reload={load} />
}
