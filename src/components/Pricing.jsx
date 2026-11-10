import Icon from './Icon.jsx'
import SectionHeading from './SectionHeading.jsx'
import { getStarted, pricing } from '../content/site.js'

export default function Pricing() {
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
          <a href={getStarted.href} className="btn btn-primary btn-lg btn-block">
            {getStarted.label}
          </a>
          <a href="#book-demo" className="price-alt">
            Questions first? Book a call
          </a>
          <p className="price-fine">{pricing.excludes}</p>
        </div>
      </div>
    </section>
  )
}
