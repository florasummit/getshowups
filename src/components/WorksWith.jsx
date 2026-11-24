import { integrations } from '../content/site.js'

// "Works with": one still row of names in our own type, one colour (never logos: Google's and Anthropic's marks need
// permission), only what customers can use in production today (content/site.js).
export default function WorksWith() {
  return (
    <section className="ww" aria-labelledby="ww-title" data-works-with>
      <div className="container">
        <h2 id="ww-title" className="ww-title">
          {integrations.title}
        </h2>
        <ul className="ww-names">
          {integrations.names.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
        <p className="ww-note">{integrations.note}</p>
      </div>
    </section>
  )
}
