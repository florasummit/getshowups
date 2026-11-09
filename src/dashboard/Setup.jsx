// Three-step setup. The current step is derived from saved progress; one action per screen.
import { useState } from 'react'
import Logo from '../components/Logo.jsx'
import { BusinessForm, HoursForm } from './forms.jsx'
import { connectCalendar } from '../lib/connect.js'
import { SignOut } from './Home.jsx'

const STEPS = ['Business', 'Calendar', 'Hours']

export default function Setup({ me, reload }) {
  const { progress, customer, email } = me
  const [editingBusiness, setEditingBusiness] = useState(false)
  const step = !progress.business || editingBusiness ? 0 : !progress.calendar ? 1 : 2

  return (
    <div className="app">
      <header className="app-header">
        <Logo href="/" />
        <SignOut email={email} />
      </header>
      <main className="center-page center-page--top">
        <ol className="steps-bar" aria-label="Setup progress">
          {STEPS.map((label, i) => (
            <li key={label} className={i < step ? 'is-done' : i === step ? 'is-current' : ''} aria-current={i === step ? 'step' : undefined}>
              <span className="steps-bar-dot">{i < step ? '✓' : i + 1}</span>
              {label}
            </li>
          ))}
        </ol>

        <section key={step} className="panel panel--narrow enter" aria-labelledby="step-title">
          {step === 0 && (
            <>
              <h1 id="step-title" className="title">
                {customer ? 'Your business' : 'Let’s set up your booking page'}
              </h1>
              <BusinessForm
                customer={customer}
                submitLabel="Continue"
                onSaved={() => {
                  setEditingBusiness(false)
                  reload()
                }}
              />
            </>
          )}

          {step === 1 && <CalendarStep onBack={() => setEditingBusiness(true)} />}

          {step === 2 && (
            <>
              <h1 id="step-title" className="title">
                When can customers book?
              </h1>
              <p className="lede">Times already busy on your Google Calendar are hidden automatically.</p>
              <HoursForm customer={customer} submitLabel="Finish setup" onSaved={reload} />
            </>
          )}
        </section>
      </main>
    </div>
  )
}

function CalendarStep({ onBack }) {
  const [state, setState] = useState({})
  const start = async () => {
    setState({ busy: true })
    if (!(await connectCalendar())) setState({ failed: true })
  }
  return (
    <>
      <h1 id="step-title" className="title">
        Connect Google Calendar
      </h1>
      <p className="lede">We check when you’re free and add booked appointments to your calendar. We never read event details.</p>
      {state.failed && (
        <p className="form-error" role="alert">
          That didn’t connect. Please try again.
        </p>
      )}
      <button type="button" className="btn btn-primary btn-lg btn-block" onClick={start} disabled={state.busy}>
        {state.busy ? 'Opening Google…' : 'Connect Google Calendar'}
      </button>
      <button type="button" className="link-btn" onClick={onBack}>
        Back
      </button>
    </>
  )
}
