import { useRef, useState } from 'react'
import Icon from './Icon.jsx'
import SectionHeading from './SectionHeading.jsx'
import GetStarted from './GetStarted.jsx'
import EnterpriseInquiry from './EnterpriseInquiry.jsx'
import { useStartAction } from '../lib/enrollment.js'
import { pricing, enterprise } from '../content/site.js'
import { track } from '../lib/analytics.js'

// Two offerings, one design: the Growth card is unchanged; Enterprise sits under it with "Contact sales", which opens
// the inquiry form in place (no checkout, no new page). Copy comes from content/site.js.
export default function Pricing() {
  const start = useStartAction()
  const [inquiry, setInquiry] = useState(false)
  const formRef = useRef(null)
  const contactSales = () => {
    track('enterprise_cta', { location: 'pricing' })
    setInquiry(true)
    requestAnimationFrame(() => formRef.current?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' }))
  }
  return (
    <section id="pricing" className="section pricing" aria-labelledby="pricing-title">
      <div className="container">
        <SectionHeading id="pricing-title" eyebrow="Pricing" title="Two ways to start" intro="One business, or many. Ad spend is separate." />
        <div className="price-grid">
          <div className="price-card" data-plan="growth">
            <div className="price-main">
              <div className="price-head">
                <p className="price-name">{pricing.name}</p>
                <span className="badge">{pricing.badge}</span>
              </div>
              <p className="price-amount">
                <span className="price-currency">$</span>
                {pricing.price}
                <span className="price-period">/{pricing.period}</span>
              </p>
              <p className="price-note">{pricing.note}</p>
              {start.closed && (
                <p className="price-note enrollment-note" role="status">
                  {start.note}
                </p>
              )}
              <GetStarted className="btn btn-primary btn-lg btn-block" onClick={() => track('early_access_cta', { location: 'pricing' })} />
              {!start.closed && (
                <a href="#book-demo" className="price-alt">
                  Questions first? Book a call
                </a>
              )}
            </div>
            <div className="price-side">
              <p className="price-list-title">What’s included</p>
              <ul className="price-list">
                {pricing.includes.map((item) => (
                  <li key={item}>
                    <Icon name="tick" size={16} strokeWidth={2.5} />
                    {item}
                  </li>
                ))}
              </ul>
              <p className="price-fine">{pricing.excludes}</p>
            </div>
          </div>

          <div className="price-card price-card--enterprise" data-plan="enterprise">
            <div className="price-main price-main--light">
              <div className="price-head">
                <p className="price-name">{enterprise.name}</p>
                <span className="badge badge--lav">{enterprise.badge}</span>
              </div>
              <p className="price-amount price-amount--from">
                <span className="price-from">{enterprise.lead}</span>
                <span className="price-currency">$</span>
                {enterprise.price}
                <span className="price-period">/{enterprise.period}</span>
              </p>
              <p className="price-note">{enterprise.audience}</p>
              <button type="button" className="btn btn-ink btn-lg btn-block" onClick={contactSales} aria-expanded={inquiry} aria-controls="enterprise-inquiry" data-enterprise-cta>
                {enterprise.cta}
              </button>
            </div>
            <div className="price-side">
              <p className="price-list-title">What Enterprise means</p>
              <ul className="price-list price-list--one">
                {enterprise.points.map((item) => (
                  <li key={item}>
                    <Icon name="tick" size={16} strokeWidth={2.5} />
                    {item}
                  </li>
                ))}
              </ul>
              <p className="price-fine">{enterprise.today}</p>
            </div>
          </div>
        </div>
        <div id="enterprise-inquiry" ref={formRef} className="enq-anchor">
          {inquiry && <EnterpriseInquiry onClose={() => setInquiry(false)} />}
        </div>
      </div>
    </section>
  )
}
