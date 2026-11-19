import Icon from './Icon.jsx'
import SectionHeading from './SectionHeading.jsx'
import GetStarted from './GetStarted.jsx'
import { useStartAction } from '../lib/enrollment.js'
import { pricing } from '../content/site.js'

export default function Pricing() {
  const start = useStartAction()
  return (
    <section id="pricing" className="section" aria-labelledby="pricing-title">
      <div className="container">
        <SectionHeading
          id="pricing-title"
          eyebrow="Pricing"
          title="One plan for founding customers"
          intro="Everything you need to start taking bookings. Ad spend is separate."
        />
        <div className="price-card">
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
          <ul className="price-list">
            {pricing.includes.map((item) => (
              <li key={item}>
                <Icon name="tick" size={18} strokeWidth={2.5} />
                {item}
              </li>
            ))}
          </ul>
          {start.closed && (
            <p className="price-note enrollment-note" role="status">
              {start.note}
            </p>
          )}
          <GetStarted className="btn btn-primary btn-lg btn-block" />
          {!start.closed && (
            <a href="#book-demo" className="price-alt">
              Questions first? Book a call
            </a>
          )}
          <p className="price-fine">{pricing.excludes}</p>
        </div>
      </div>
    </section>
  )
}
