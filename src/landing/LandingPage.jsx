// Public business landing page at /p/:id, generated from the shared template and published by the
// owner. Every "Book" button opens the business's existing booking page, keeping ad parameters.
import { useEffect, useState } from 'react'
import { api } from '../lib/api.js'
import '../app.css'

// `preview`: render the owner's unpublished draft (onboarding/settings) without fetching; links are inert.
export default function LandingPage({ id, preview }) {
  const [state, setState] = useState(preview ? { data: preview } : { loading: true })
  useEffect(() => {
    if (preview) return
    api(`/api/page/${id}`).then(({ status, data }) => {
      setState(status === 200 ? { data } : { missing: status === 404, error: status !== 404 })
      if (status === 200) document.title = `${data.headline} | ${data.name}`
    })
  }, [id, preview])

  if (state.loading) return <main className="center-page" aria-busy="true" />
  if (!state.data) {
    return (
      <main className="center-page">
        <div className="panel panel--narrow enter">
          <h1 className="title">{state.missing ? 'This page isn’t available' : 'We can’t load this page right now'}</h1>
          <p className="lede">{state.missing ? 'Check the link and try again.' : 'Please try again in a moment.'}</p>
        </div>
      </main>
    )
  }
  const p = preview || state.data
  const visit = p.appointmentMode === 'at_customer'
  // Carry utm/gclid to the booking page so the lead is attributed to the ad that brought them.
  const book = preview ? undefined : `/book/${id}${window.location.search}`
  const inert = preview ? { onClick: (e) => e.preventDefault(), 'aria-disabled': true, tabIndex: -1 } : {}
  const tel = p.phone ? `tel:+1${p.phone.replace(/\D/g, '')}` : null
  const cta = visit ? 'Book a visit' : 'Book a time'
  return (
    <main className={preview ? 'landing landing--preview' : 'landing'}>
      <header className="landing-hero">
        <p className="booking-biz">{p.name}</p>
        <h1 className="title">{p.headline}</h1>
        <p className="lede">{p.intro}</p>
        <a className="btn btn-primary btn-block landing-cta" href={book} {...inert}>
          {cta}
        </a>
        {tel && (
          <a className="btn btn-quiet btn-block" href={preview ? undefined : tel} {...inert}>
            Call {p.phone}
          </a>
        )}
      </header>

      {p.services.length > 0 && (
        <section className="card">
          <h2 className="card-title">Services</h2>
          <ul className="landing-list">
            {p.services.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
        </section>
      )}

      {p.highlights.length > 0 && (
        <section className="card">
          <h2 className="card-title">About {p.name}</h2>
          <ul className="landing-list">
            {p.highlights.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
        </section>
      )}

      <section className="card">
        <h2 className="card-title">How it works</h2>
        <ol className="landing-steps">
          <li>Tell us what you need.</li>
          <li>Pick a time from the real calendar.</li>
          <li>{visit ? 'We come to you at the booked time.' : 'Come in at the booked time.'} You’ll get a confirmation by email.</li>
        </ol>
        {p.area && <p className="fine">Service area: {p.area}</p>}
      </section>

      <a className="btn btn-primary btn-block landing-cta" href={book} {...inert}>
        {cta}
      </a>
      <p className="fine landing-foot">
        Booking by GetShowUps · <a href="/privacy">Privacy</a>
      </p>
    </main>
  )
}
