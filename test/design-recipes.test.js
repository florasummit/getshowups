// The first-screen recipes the designer prompt teaches (server/design-blocks.js RECIPES) must be things the validator,
// the renderer and the quality checks accept: valid with no repairs, balanced, not the "conventional" template, Book in
// the first screen, and different from each other. Plus the balance check on hand-built showcases vs known-bad layouts,
// the public brand name and the footer.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateSpec } from '../server/site-spec.js'
import { renderV2 } from '../server/site-render-v2.js'
import { renderSite } from '../server/site-render.js'
import { RECIPES, parseBlock, recipesText } from '../server/design-blocks.js'
import { checkDesign, compositionBalance, conventionalFirstScreen, firstScreenStructure } from '../server/design-checks.js'
import { displayBrand, validateContent } from '../server/website.js'
import { directions } from './fixtures/design-directions.js'

const IDS = ['a', 'b', 'c', 'd'].map((x) => x.repeat(32))
const SERVICES = [{ name: 'One Time Service', price: '$150+' }, { name: 'Weekly Pool Care', price: '$280+' }, { name: 'Pool Winterization', price: '$350+' }]
const CTX = { assetIds: new Set(IDS), services: SERVICES, claims: [] }
const FILL = { '<eyebrow: what + where>': 'Pool care · Charleston', '<4-7 word headline>': 'Clear water. Calm weekends.', '<one or two sentences>': 'Dependable pool care for homes across the Lowcountry.', '<one sentence>': 'Dependable pool care across the Lowcountry.', '<Book …>': 'Book a visit', '<alt>': 'A pool', '<number of services, e.g. 03>': '03' }
export const recipeSpec = (r) => {
  let photo = 0
  const blocks = r.blocks.map((b) => parseBlock({ ...b, text: FILL[b.text] ?? b.text, image: b.kind === 'media' ? `asset:${IDS[photo++]}` : '', target: b.target || '' }))
  return { direction: r.name, pages: [{ slug: '', navLabel: 'Home', sections: [{ type: 'composition', id: 'top', height: 'tall', blocks }, { type: 'services', id: 'svc', layout: 'list', items: [] }, { type: 'area', id: 'area' }] }] }
}

test('every first-screen recipe validates with no repairs, is balanced, is not the conventional template, and renders with Book', () => {
  const shapes = new Set()
  for (const r of RECIPES) {
    const { spec, warnings } = validateSpec(recipeSpec(r), CTX)
    assert.deepEqual(warnings, [], r.name)
    assert.deepEqual(compositionBalance(spec.pages[0].sections[0]), [], `${r.name}: balanced`)
    assert.equal(conventionalFirstScreen(spec), false, `${r.name}: not the template`)
    const report = checkDesign({ raw: recipeSpec(r), spec, warnings, fresh: true })
    assert.deepEqual([report.hard, report.soft], [[], []], r.name)
    const html = renderV2({ id: 'pools', name: 'Pools', cities: ['Charleston'], phone: '', services: SERVICES }, spec, { bookUrl: '/book/pools', year: 2026 })
    assert.match(html, /<section[^>]*class="[^"]*comp[^>]*>[\s\S]*?<a class="btn[^"]*" href="\/book\/pools"/, `${r.name}: Book in the first screen`)
    shapes.add(firstScreenStructure(spec))
  }
  assert.equal(shapes.size, RECIPES.length, 'the recipes are structurally different from each other')
  assert.equal(recipesText().split('\n').filter((l) => /^[A-D]\. /.test(l)).length, 4)
})

test('balance check: the hand-built showcases pass; a stranded one-column-off photo and a mostly empty section are flagged', () => {
  for (const [k, d] of Object.entries(directions(IDS.map((i) => `asset:${i}`)))) assert.deepEqual(compositionBalance(validateSpec(d, CTX).spec.pages[0].sections[0]), [], k)
  // The live GPT "signature" section (2026-11-16): photo at column 7, the text under it at column 8.
  const offset = [
    { kind: 'text', col: [1, 4], row: [1, 1], z: 1, y: 'end', size: 's', text: 'A different kind of to-do list' },
    { kind: 'heading', col: [1, 5], row: [2, 2], z: 1, y: 'start', size: 'xl', text: 'Keep the pool. Lose the chore.' },
    { kind: 'media', col: [7, 6], row: [1, 4], z: 0, y: 'start', aspect: '4x3', image: `asset:${IDS[0]}`, alt: 'A pool' },
    { kind: 'media', col: [2, 4], row: [4, 3], z: 0, y: 'start', aspect: '1x1', image: `asset:${IDS[1]}`, alt: 'A pool' },
    { kind: 'text', col: [8, 4], row: [5, 2], z: 1, y: 'center', size: 'm', text: 'Your pool has a place in everyday life.' },
  ]
  assert.ok(compositionBalance({ type: 'composition', blocks: offset }).includes('misaligned'))
  const sparse = [
    { kind: 'heading', col: [1, 3], row: [1, 1], z: 0, size: 's', text: 'Hi' },
    { kind: 'media', col: [10, 3], row: [1, 6], z: 0, y: 'start', aspect: '3x4', image: `asset:${IDS[0]}`, alt: 'A pool' },
  ]
  assert.ok(compositionBalance({ type: 'composition', blocks: sparse }).includes('mostly_empty'))
  // An intentional open side (a type poster with nothing on the right) is not flagged: no photo, nothing to balance.
  assert.deepEqual(compositionBalance({ type: 'composition', blocks: [sparse[0], { kind: 'button', col: [1, 3], row: [2, 1], z: 0, label: 'Book', target: 'book' }] }), [])
})

test('the conventional first screen (one photo beside the text) is a soft issue for new designs only, never for owner revisions', () => {
  const split = { pages: [{ slug: '', sections: [{ type: 'composition', id: 'top', blocks: [
    { kind: 'heading', col: [1, 6], row: [1, 2], z: 1, size: 'xl', text: 'Less upkeep. More pool.' },
    { kind: 'button', col: [1, 3], row: [3, 1], z: 1, label: 'Book a visit', target: 'book' },
    { kind: 'media', col: [8, 5], row: [1, 3], z: 0, y: 'stretch', aspect: '3x4', image: `asset:${IDS[0]}`, alt: 'A pool' },
  ] }, { type: 'area', id: 'area' }, { type: 'services', id: 'svc', layout: 'list', items: [] }] }] }
  const { spec, warnings } = validateSpec(split, CTX)
  assert.ok(checkDesign({ raw: split, spec, warnings, fresh: true }).soft.includes('conventional_first_screen'))
  assert.ok(!checkDesign({ raw: split, spec, warnings, fresh: false }).soft.includes('conventional_first_screen'))
})

test('brand: AI-designed sites show the public brand in the owner\'s spelling, the footer names it once; older sites are unchanged', () => {
  const content = { intro: 'PoolThru provides reliable pool care.', seoTitle: 'PoolThru Pool Care', seoDescription: 'Poolthru LLC comes to you.' }
  assert.equal(displayBrand('Poolthru LLC', content), 'PoolThru')
  assert.equal(displayBrand('Poolthru LLC', {}), 'Poolthru')
  assert.equal(displayBrand('Acme Pools, Inc.', { intro: 'ACME POOLS. ACME POOLS.' }), 'Acme Pools', 'capitals are styling, not the spelling')
  assert.equal(displayBrand('Acme Pools, Inc.', { intro: 'Acme Poolside' }), 'Acme Pools', 'never a partial word')
  const site = validateSpec({ ...recipeSpec(RECIPES[0]), footer: { layout: 'simple', text: 'Poolthru LLC · Pool care for the Lowcountry.' } }, CTX).spec
  const biz = { id: 'poolthru-llc', name: 'Poolthru LLC', cities: ['Charleston'], phone: '', appointmentMode: 'at_customer' }
  const html = renderSite(biz, { ...content, services: SERVICES, site }, { bookUrl: '/book/x', year: 2026 })
  assert.match(html, /<a class="brand"[^>]*>PoolThru<\/a>/)
  assert.match(html, /© 2026 PoolThru · Pool care for the Lowcountry\.<\/span>/)
  assert.doesNotMatch(html.replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/, ''), /Poolthru LLC/, 'the legal name is not shown')
  const v = validateContent({ ...content, headline: 'Pool care', services: SERVICES, template: 'clean', color: 'ocean' })
  const legacy = renderSite(biz, v[1], { bookUrl: '/book/x', year: 2026 })
  assert.match(legacy, /Poolthru LLC/, 'sites without an AI design render exactly as before')
})

test('footer: a tagline that repeats the brand (any separator) loses it and starts with a capital', () => {
  const biz = { id: 'poolthru-llc', name: 'PoolThru', legalName: 'Poolthru LLC', cities: ['Charleston'], phone: '', services: SERVICES }
  const foot = (layout, text) => renderV2(biz, validateSpec({ ...recipeSpec(RECIPES[0]), footer: { layout, text } }, CTX).spec, { bookUrl: '/book/x', year: 2026 }).match(/<footer[\s\S]*<\/footer>/)[0]
  assert.match(foot('statement', 'PoolThru: pool cleaning and maintenance for Charleston.'), /<p class="big">Pool cleaning and maintenance for Charleston\.<\/p>/)
  const simple = foot('simple', 'PoolThru. Pool care for life in the Lowcountry.')
  assert.match(simple, /© 2026 PoolThru · Pool care for life in the Lowcountry\.<\/span>/)
  assert.equal(simple.match(/PoolThru/g).length, 1, 'the brand once')
})
