// Website data helpers shared by the Website tab and onboarding (no components here).
import { useEffect, useState } from 'react'
import { api } from '../lib/api.js'

const FIELD_LABELS = { headline: 'Headline', intro: 'Introduction', about: 'About', services: 'Services', area: 'Service area', highlights: 'Facts', seoTitle: 'Search title', seoDescription: 'Search description', images: 'Photos', photos: 'Photos' }
export function problemText(fields = []) {
  const claim = fields.find((f) => f.endsWith(':unapproved_claim'))
  if (claim) return `${FIELD_LABELS[claim.split(':')[0]]}: please remove promises like guarantees, discounts, ratings or credentials unless we’ve confirmed them with you.`
  return fields.length ? `Please check: ${[...new Set(fields.map((f) => FIELD_LABELS[f] || f))].join(', ')}.` : 'Couldn’t save. Please try again.'
}

// Loads the website state once (shared by the Website tab and onboarding steps).
export function useWebsite() {
  const [data, setData] = useState(null)
  useEffect(() => {
    api('/api/dashboard/website').then(({ status, data: d }) => setData(status === 200 ? d : { failed: true }))
  }, [])
  return [data, setData]
}
