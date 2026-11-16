// Three art directions for the SAME business with IDENTICAL information and photos (PoolThru's reviewed copy and its 6
// photos), written as the designer would answer: a composition for the first screen (and one signature moment), the
// existing v2 sections for the rest. Used by tests and by the visual comparison. `photos`: 6 image refs.
const C = {
  kicker: 'Pool service · Charleston, SC',
  h1: 'Clear water. Calm weekends.',
  intro: 'Dependable pool care for homes, apartment communities and commercial properties across the Lowcountry.',
  aboutH: 'Pool care for the Lowcountry, handled.',
  about: 'We provide reliable residential and commercial pool maintenance throughout Charleston and the surrounding Lowcountry.',
  svcH: 'Three ways to keep your pool at its best',
  svc: ['A single visit to clean and refresh your pool, so the water is clean and inviting.', 'Routine cleaning, water balancing and equipment upkeep on a regular schedule.', 'An expert closing covering water levels, chemicals and a secure cover.'],
  steps: [{ title: 'Book online', text: 'Pick the service you need on our booking page.' }, { title: 'We visit you', text: 'We come to your home or property and take care of the pool.' }, { title: 'Dive in', text: 'Enjoy clean, inviting water without the work.' }],
  areaH: 'Proudly serving Charleston and the Lowcountry',
  ctaH: 'Ready for a pool you don’t have to think about?',
}
export const DIRECTION_COPY = C
const services = (layout, extra = {}) => ({ type: 'services', id: 'services', layout, heading: C.svcH, showPrices: true, items: C.svc.map((text, serviceIndex) => ({ serviceIndex, text })), ...extra })
const page = (sections) => [{ slug: '', navLabel: 'Home', seoTitle: 'Pool care in Charleston', seoDescription: 'Pool care across the Lowcountry, booked online.', sections }]
const T = (o) => ({ headingCase: 'none', baseSize: 17, scale: 1.3, lineHeight: 1.6, maxWidth: 1240, motion: 'none', ...o })
const book = (x = {}) => ({ kind: 'button', label: 'Book a visit', target: 'book', ...x })

export const directions = (P) => ({
  // EDITORIAL: an oversized serif headline that overlaps a large square photo (card), a numbered index of services,
  // an arched photo; sand and deep teal.
  editorial: {
    name: 'Editorial',
    direction: 'Quiet coastal editorial: oversized serif headline overlapping a large photo, sand and deep teal, generous calm space.',
    theme: T({ colors: { bg: '#f4efe6', surface: '#e9e1d2', ink: '#1c1a17', muted: '#5d564b', accent: '#14524f', onAccent: '#f4efe6', line: '#d6cbb7' }, headingFont: 'fraunces', bodyFont: 'dm-sans', headingWeight: 500, headingTracking: -0.03, radius: 2, density: 'comfortable', buttons: 'solid' }),
    nav: { layout: 'left', sticky: true, showBook: true },
    footer: { layout: 'simple', text: '' },
    pages: page([
      { type: 'composition', id: 'top', height: 'tall', spacing: 'l', width: 'wide', blocks: [
        { kind: 'media', image: P[0], alt: 'A pool in Charleston', aspect: '1x1', col: [6, 7], row: [1, 4], z: 0, m: { order: 2 } },
        { kind: 'text', size: 's', text: C.kicker, col: [1, 5], row: [1, 1], m: { order: 0 } },
        { kind: 'heading', size: 'display', text: C.h1, col: [1, 7], row: [2, 1], z: 1, m: { order: 1 } },
        { kind: 'text', size: 'm', text: C.intro, col: [1, 4], row: [3, 1], m: { order: 3 } },
        book({ col: [1, 4], row: [4, 1], m: { order: 4 } }),
      ] },
      services('rows', { width: 'wide' }),
      { type: 'imageText', id: 'about', imageSide: 'left', imageShape: 'arch', image: P[1], heading: C.aboutH, body: C.about, background: 'surface' },
      { type: 'steps', id: 'how', layout: 'numbered', heading: 'Booking is the only thing you need to do', items: C.steps },
      { type: 'area', id: 'area', heading: C.areaH },
      { type: 'cta', id: 'book', layout: 'band', heading: C.ctaH, cta: { label: 'Book a visit', target: 'book' }, background: 'ink' },
    ]),
  },
  // POSTER: typography is the first screen (no photo), a giant numeral, then a full-bleed duotone photo band as the
  // signature moment; loud grotesk, electric blue, pill buttons.
  poster: {
    name: 'Poster',
    direction: 'Bold typographic poster: the headline is the hero, electric blue, a duotone photo band, pill buttons.',
    theme: T({ colors: { bg: '#ffffff', surface: '#f2f2f2', ink: '#0b0b0b', muted: '#4a4a4a', accent: '#0047d6', onAccent: '#ffffff', line: '#e2e2e2' }, headingFont: 'bricolage-grotesque', bodyFont: 'inter', headingWeight: 800, headingTracking: -0.04, radius: 20, density: 'compact', buttons: 'pill' }),
    nav: { layout: 'split', sticky: true, showBook: true },
    footer: { layout: 'statement', text: 'Clear water. Calm weekends.' },
    pages: page([
      { type: 'composition', id: 'top', height: 'screen', spacing: 'm', width: 'wide', blocks: [
        { kind: 'mark', text: '03', col: [10, 3], row: [1, 1], x: 'end', m: { hide: true } },
        { kind: 'text', size: 's', text: C.kicker, col: [1, 6], row: [1, 1] },
        { kind: 'heading', size: 'display', text: C.h1, col: [1, 11], row: [2, 1] },
        book({ col: [1, 4], row: [3, 1] }),
        { kind: 'text', size: 'm', text: C.intro, col: [8, 5], row: [3, 1] },
      ] },
      services('tiles', { columns: 3, background: 'accent', width: 'wide' }),
      { type: 'composition', id: 'photos', spacing: 's', width: 'full', blocks: [
        { kind: 'media', image: P[2], alt: 'Pool', aspect: '3x4', treat: 'duo', col: [1, 4], row: [1, 1] },
        { kind: 'media', image: P[3], alt: 'Pool', aspect: '3x4', treat: 'duo', col: [5, 4], row: [1, 1], m: { span: 2 } },
        { kind: 'media', image: P[4], alt: 'Pool', aspect: '3x4', treat: 'duo', col: [9, 4], row: [1, 1], m: { span: 2 } },
      ] },
      { type: 'steps', id: 'how', layout: 'timeline', heading: 'Booking is the only thing you need to do', items: C.steps, background: 'ink' },
      { type: 'area', id: 'area', heading: C.areaH },
      { type: 'cta', id: 'book', layout: 'split', heading: C.ctaH, cta: { label: 'Book a visit', target: 'book' }, image: P[5] },
    ]),
  },
  // COLLAGE: three photos at different sizes with the headline card overlapping them, rounded and warm; services as
  // alternating photo rows; a circular photo for the story.
  collage: {
    name: 'Collage',
    direction: 'Warm magazine collage: overlapping rounded photos with a headline card, terracotta and cream, friendly serif.',
    theme: T({ colors: { bg: '#fff8ef', surface: '#ffe9d1', ink: '#2a1d12', muted: '#6d5948', accent: '#b23a0b', onAccent: '#ffffff', line: '#f0d9bf' }, headingFont: 'playfair-display', bodyFont: 'manrope', headingWeight: 700, headingTracking: -0.01, radius: 16, density: 'comfortable', buttons: 'solid' }),
    nav: { layout: 'center', sticky: false, showBook: true },
    footer: { layout: 'simple', text: '' },
    pages: page([
      { type: 'composition', id: 'top', spacing: 'm', width: 'wide', blocks: [
        { kind: 'media', image: P[0], alt: 'Pool', aspect: '4x5', shape: 'rounded', col: [1, 5], row: [1, 3], m: { order: 0, span: 2 } },
        { kind: 'media', image: P[5], alt: 'Pool', aspect: '1x1', shape: 'rounded', col: [6, 3], row: [1, 1], m: { span: 2, order: 1 } },
        { kind: 'media', image: P[1], alt: 'Pool', aspect: '3x4', shape: 'rounded', col: [9, 4], row: [2, 2], m: { span: 2, order: 2, hide: true } },
        { kind: 'heading', size: 'xl', text: C.h1, col: [5, 5], row: [2, 1], z: 2, y: 'center', m: { order: 3 } },
        { kind: 'text', size: 'm', text: C.intro, col: [6, 3], row: [3, 1], z: 2, m: { order: 4 } },
        book({ col: [1, 4], row: [4, 1], z: 2, m: { order: 5 } }),
      ] },
      services('alternating', { items: C.svc.map((text, serviceIndex) => ({ serviceIndex, text, image: [P[2], P[3], P[4]][serviceIndex] })) }),
      { type: 'imageText', id: 'about', imageSide: 'right', imageShape: 'circle', image: P[2], heading: C.aboutH, body: C.about, background: 'surface' },
      { type: 'area', id: 'area', heading: C.areaH, align: 'center' },
      { type: 'cta', id: 'book', layout: 'card', heading: C.ctaH, cta: { label: 'Book a visit', target: 'book' }, align: 'center', background: 'accent' },
    ]),
  },
})
