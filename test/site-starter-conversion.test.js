// Phase 1 conversion-first starter (server/site-starter.js) + the Call action and booking hours (server/site-spec.js,
// server/site-render-v2.js). Records only: nothing invented; missing records → section left out and reported.
// Existing published sites are covered byte-for-byte by test/render-golden.test.js.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { starterSite, bookingSteps, faqFromPolicies } from '../server/site-starter.js'
import { validateSpec } from '../server/site-spec.js'
import { renderV2, hoursText } from '../server/site-render-v2.js'

const content = (extra = {}) => ({
  headline: 'Electrical repairs in Charleston',
  intro: 'Panels, outlets and lighting.',
  about: '',
  area: 'Charleston, Mount Pleasant',
  services: [
    { id: 'svc_a', name: 'Panel upgrade', price: '', description: 'Replace an old fuse box with a modern panel.' },
    { id: 'svc_b', name: 'Outlet repair', price: '$129', description: '' },
  ],
  hero: null,
  logo: null,
  ...extra,
})
const FULL = {
  name: 'Bright Electric',
  industry: 'Electrician',
  phone: '(843) 555-0100',
  visit: true,
  chat: false,
  cities: ['Charleston', 'Mount Pleasant'],
  hoursConfirmed: true,
  policies: { beforeVisit: 'Please make sure we can reach the breaker panel.', cancellation: 'Cancel or move your visit up to a day before at no charge.' },
}
const NONE = { name: 'Ledger & Co', industry: 'Accounting', phone: '', visit: false, chat: false, cities: [], hoursConfirmed: false, policies: { beforeVisit: '', cancellation: '' } }
const home = (site) => site.pages[0].sections
const validated = (site, c) => {
  const r = validateSpec(site, { services: c.services, factsText: '' })
  assert.ok(r.ok !== false, 'starter site validates')
  return r.spec || r
}
const renderBiz = (b, extra = {}) => ({ id: 'x', name: b.name, phone: b.phone, cities: b.cities, appointmentMode: b.visit ? 'at_customer' : 'at_business', services: content().services, hours: b.hoursConfirmed ? { dayStart: '09:00', dayEnd: '17:00', workdays: [1, 2, 3, 4, 5] } : null, ...extra })
const render = (b, site) => renderV2(renderBiz(b), site, { bookUrl: 'https://getshowups.com/book/x', pageBase: '/p/x', year: 2026 })

test('full records: hero with area + Book + Call, services, 3 booking steps, hours and area, owner FAQ, final CTA', () => {
  const c = content()
  const { site, missing } = starterSite(c, FULL)
  assert.deepEqual(home(site).map((s) => s.type), ['hero', 'services', 'steps', 'area', 'faq', 'cta'])
  const hero = home(site)[0]
  assert.equal(hero.eyebrow, 'Serving Charleston, Mount Pleasant')
  assert.deepEqual(hero.primaryCta, { label: 'Book online', target: 'book' })
  assert.deepEqual(hero.secondaryCta, { label: 'Call', target: 'call' }, 'the number is not copied into the spec')
  assert.equal(home(site).find((s) => s.type === 'area').showHours, true)
  assert.deepEqual(missing, [])
  // FAQ answers are the owner's words, unchanged.
  const faq = home(site).find((s) => s.type === 'faq').items.map((x) => x.answer)
  assert.ok(faq.includes(FULL.policies.beforeVisit) && faq.includes(FULL.policies.cancellation))
})

test('missing records: sections left out, never invented; reported so the owner is asked', () => {
  const c = content({ services: [], area: '' })
  const { site, missing } = starterSite(c, NONE)
  // Call and hours/area are bound to the records at render time, so they appear once the owner adds them.
  assert.deepEqual(home(site).map((s) => s.type), ['hero', 'steps', 'area', 'cta'])
  assert.equal(home(site)[0].eyebrow, '')
  assert.deepEqual(missing, ['phone', 'services', 'hours', 'area', 'policies'])
  const spec = validated(site, c)
  const html = render(NONE, spec)
  assert.ok(!html.includes('tel:') && !html.includes('btn-call'), 'no phone on record → no Call button (never a dead link)')
  assert.ok(!html.includes('id="area"') && !html.includes('Booking hours'), 'no towns or hours → no empty section')
  assert.ok(!html.includes('<details'), 'no FAQ without the owner’s own notes')
  // The owner's editor still shows the empty section (with a note) so it can be found.
  assert.match(renderV2(renderBiz(NONE), spec, { bookUrl: '/book/x', year: 2026, editing: true }), /id="area"[^]*appear here once they’re in Business details/)
  // Later the owner adds a phone and confirms hours: both appear without a new draft.
  const later = renderV2(renderBiz(NONE, { phone: '(512) 555-0100', hours: { dayStart: '10:00', dayEnd: '16:00', workdays: [2, 3, 4] } }), spec, { bookUrl: '/book/x', year: 2026 })
  assert.ok(later.includes('href="tel:5125550100"'))
  assert.match(later, /<h2 id="h-area">Hours and service area<\/h2><\/div><p class="hours"><strong>Booking hours<\/strong> Tue–Thu · 10:00 AM – 4:00 PM/)
})

test('a long town list is never cut into the first-screen line (left out; the area section lists every town)', () => {
  const area = 'Charleston, Mount Pleasant, Summerville, Goose Creek, James Island'
  const { site } = starterSite(content({ area }), FULL)
  assert.equal(home(site)[0].eyebrow, '')
})

test('booking steps describe only what production does: no email/text/reminder promises, no "coming soon"', () => {
  for (const visit of [true, false]) {
    const s = bookingSteps(visit)
    assert.equal(s.items.length, 3)
    const words = [s.heading, ...s.items.flatMap((x) => [x.title, x.text])].join(' ').toLowerCase()
    for (const banned of ['email', 'e-mail', 'text message', 'texts', 'sms', 'remind', 'confirmation', 'coming soon', 'notify', 'call you']) assert.ok(!words.includes(banned), `${banned} not promised`)
  }
  assert.deepEqual(faqFromPolicies({ beforeVisit: '', cancellation: '' }, true), [], 'appointment-mode answer only alongside owner notes')
})

test('validator: call allowed on regular buttons only; showHours stored only when on (older content validates identically)', () => {
  const c = content()
  const { site } = starterSite(c, FULL)
  const spec = validated(site, c)
  assert.equal(spec.pages[0].sections[0].secondaryCta.target, 'call')
  // A composition button can't be a call (→ booking, reported).
  const comp = {
    ...site,
    pages: [{ ...site.pages[0], sections: [{ type: 'composition', id: 'c1', blocks: [{ kind: 'heading', text: 'Hi', col: [1, 6], row: [1, 1] }, { kind: 'button', label: 'Call', target: 'call', col: [1, 4], row: [2, 1] }] }, ...site.pages[0].sections.slice(1)] }],
  }
  const r = validateSpec(comp, { services: c.services })
  assert.ok(r.warnings.some((w) => /blocks\.1\.target$/.test(w.where) && w.reason === 'link'), 'reported, not silently accepted')
  const block = r.spec.pages[0].sections.find((s) => s.type === 'composition')?.blocks.find((b) => b.kind === 'button')
  assert.equal(block?.target ?? 'book', 'book', 'never a composition call link')
  // Area without showHours: no new key at all.
  const plain = validateSpec({ ...site, pages: [{ ...site.pages[0], sections: [{ type: 'area', id: 'area', heading: 'Where we work' }] }] }, { services: c.services })
  assert.ok(!('showHours' in (plain.spec || plain).pages[0].sections.find((s) => s.type === 'area')))
})

test('renderer: Call dials the CURRENT phone on record; CSS only on pages that use the new parts', () => {
  const c = content()
  const spec = validated(starterSite(c, FULL).site, c)
  const html = render(FULL, spec)
  assert.match(html, /<a class="btn ghost btn-call" href="tel:8435550100">Call <span class="tel">\(843\) 555-0100<\/span><\/a>/)
  assert.match(html, /<strong>Booking hours<\/strong> Mon–Fri · 9:00 AM – 5:00 PM/)
  assert.ok(html.includes('.btn-call .tel{') && html.includes('.hours{'))
  // The owner changes the phone in Business details → the site follows without a new draft.
  const changed = renderV2(renderBiz(FULL, { phone: '843-555-0199' }), spec, { bookUrl: '/book/x', year: 2026 })
  assert.ok(changed.includes('href="tel:8435550199"') && changed.includes('843-555-0199') && !changed.includes('0100'))
  // Phone removed later → the Call button disappears (never a dead link).
  const gone = renderV2(renderBiz(FULL, { phone: '' }), spec, { bookUrl: '/book/x', year: 2026 })
  assert.ok(!gone.includes('tel:') && !gone.includes('.btn-call'))
  // Hours no longer confirmed → no hours line.
  assert.ok(!renderV2(renderBiz(FULL, { hours: null }), spec, { bookUrl: '/book/x', year: 2026 }).includes('Booking hours'))
})

test('hoursText: consecutive days joined, HH:MM or minutes', () => {
  assert.equal(hoursText({ workdays: [1, 2, 3, 4, 5], dayStart: '09:00', dayEnd: '17:30' }), 'Mon–Fri · 9:00 AM – 5:30 PM')
  assert.equal(hoursText({ workdays: [6, 1, 3, 2], dayStart: 480, dayEnd: 720 }), 'Mon–Wed, Sat · 8:00 AM – 12:00 PM')
  assert.equal(hoursText({ workdays: [0, 6], dayStart: '00:00', dayEnd: '23:59' }), 'Sun, Sat · 12:00 AM – 11:59 PM')
})
