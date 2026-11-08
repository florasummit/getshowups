import Icon from './Icon.jsx'
import SectionHeading from './SectionHeading.jsx'
import { pricing } from '../content/site.js'

export default function Pricing() {
  return (
    <section id="pricing" className="section" aria-labelledby="pricing-title">
      <div className="container">
        <SectionHeading
          id="pricing-title"
          eyebrow="Pricing"
          title="Simple introductory pricing"
          intro="One plan while we onboard our first businesses."
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
          <a href="#book-demo" className="btn btn-primary btn-lg btn-block">
            Book a Demo
          </a>
          <p className="price-fine">{pricing.excludes}</p>
        </div>
      </div>
    </section>
  )
}
