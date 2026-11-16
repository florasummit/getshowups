// Composition sections (server/site-spec.js + server/site-render-v2.js), the model's token form (server/design-blocks.js)
// and the design-quality checks (server/design-checks.js). Pure functions: no network, no database.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateSpec, specImages } from '../server/site-spec.js'
import { renderV2 } from '../server/site-render-v2.js'
import { parseBlock, blockToModel } from '../server/design-blocks.js'
import { checkDesign, firstScreenSignature, redactRaw } from '../server/design-checks.js'
import { fromCompact, fromStrict, toCompact, toStandard } from '../server/ai-designer.js'
import { directions } from './fixtures/design-directions.js'

const IDS = ['a', 'b', 'c', 'd', 'e', 'f'].map((x) => x.repeat(32))
const PHOTOS = IDS.map((id) => `asset:${id}`)
const SERVICES = [{ name: 'One Time Service', price: '$150+' }, { name: 'Weekly Pool Care', price: '$280+' }, { name: 'Pool Winterization', price: '$350+' }]
const CTX = { assetIds: new Set(IDS), services: SERVICES, claims: [] }
const BIZ = { id: 'pools', name: 'Pools', cities: ['Charleston'], phone: '', services: SERVICES, appointmentMode: 'at_customer' }
const render = (spec) => renderV2(BIZ, spec, { page: '', pageBase: '/p/pools', bookUrl: 'https://getshowups.com/book/pools', year: 2026 })
const comp = (blocks, extra = {}) => ({ pages: [{ sections: [{ type: 'composition', id: 'top', blocks, ...extra }, { type: 'area', id: 'area' }] }] })

test('three directions: identical business info and photos, valid with no repairs, genuinely different first screens', () => {
  const sigs = new Set()
  for (const [name, d] of Object.entries(directions(PHOTOS))) {
    const { spec, warnings } = validateSpec(d, CTX)
    assert.deepEqual(warnings, [], name)
    assert.equal(spec.pages[0].sections[0].type, 'composition', name)
    assert.ok(spec.direction.length > 20, `${name} states its art direction`)
    sigs.add(firstScreenSignature(spec))
    const html = render(spec)
    assert.equal((html.match(/<h1[ >]/g) || []).length, 1, `${name}: exactly one h1`)
    assert.match(html, /href="https:\/\/getshowups\.com\/book\/pools"/, `${name}: booking link`)
    assert.ok(!/<script(?![^>]*application\/ld\+json)/i.test(html), `${name}: no scripts`)
  }
  assert.equal(sigs.size, 3, 'three different first-screen signatures')
})

test('composition validation: numbers clamped to the grid, choices from lists (invalid ones REPORTED), gates on every text', () => {
  const { spec, warnings } = validateSpec(comp([
    { kind: 'heading', text: 'Clear water', col: [10, 9], row: [6, 4], z: 7, size: 'giant' },
    { kind: 'text', text: 'Rated 5 stars by 200 neighbours', col: [1, 6] },
    { kind: 'script', text: 'alert(1)' },
    { kind: 'button', label: 'Pay', target: 'https://evil.example' },
    { kind: 'button', label: 'Go', target: 'javascript:alert(1)' },
    { kind: 'media', image: 'https://evil.example/x.jpg' },
    { kind: 'media', image: PHOTOS[0], aspect: '7x9', treat: 'blur', shape: 'star', focus: [500, -3], m: { span: 9, order: 99, hide: true } },
    { kind: 'mark', text: '1999' },
    { kind: 'mark', text: '03' },
  ]), { ...CTX, factsText: 'Pools One Time Service $150+' })
  const blocks = spec.pages[0].sections[0].blocks
  assert.deepEqual(blocks.map((b) => b.kind), ['heading', 'button', 'button', 'media', 'mark'], 'claim text, unknown kind, foreign image and a non-fact number removed')
  assert.deepEqual([blocks[0].col, blocks[0].row, blocks[0].z, blocks[0].size], [[10, 3], [6, 1], 0, 'xl'], 'clamped to the grid; invalid size → default')
  assert.deepEqual(blocks.filter((b) => b.kind === 'button').map((b) => b.target), ['book', 'book'], 'external and javascript links become the booking link')
  const media = blocks.find((b) => b.kind === 'media')
  assert.deepEqual([media.aspect, media.treat, media.shape, media.focus, media.m], ['4x5', 'none', 'rect', [100, 0], { order: 6, span: 4, hide: true }], 'invalid phone order → the block position')
  assert.equal(blocks.find((b) => b.kind === 'mark').text, '03', 'a mark may be the number of services')
  for (const where of ['blocks.0.col', 'blocks.0.row', 'blocks.0.z', 'blocks.0.size', 'blocks.2', 'blocks.6.aspect', 'blocks.6.treat', 'blocks.6.shape', 'blocks.6.m.span', 'blocks.6.m.order']) assert.ok(warnings.some((w) => w.where.endsWith(where) && w.reason === 'invalid_choice'), where)
  assert.ok(warnings.some((w) => w.reason === 'claim'))
  assert.equal(spec.nav.showBook, true, 'the navigation always offers booking')
  assert.deepEqual([...specImages(spec)], [IDS[0]], 'block photos count as used (published → served)')
})

test('the home page always opens with a first screen: a composition needs a heading, otherwise a hero is added (and reported)', () => {
  const r = validateSpec(comp([{ kind: 'media', image: PHOTOS[0] }]), CTX)
  assert.equal(r.spec.pages[0].sections[0].type, 'hero')
  assert.ok(r.warnings.some((w) => w.reason === 'first_screen_added'))
  const ok = validateSpec(comp([{ kind: 'heading', text: 'Hello' }]), CTX)
  assert.equal(ok.spec.pages[0].sections[0].type, 'composition')
  assert.ok(!ok.warnings.some((w) => w.reason === 'first_screen_added'))
})

test('rendering is safe: hostile text is escaped, placement CSS holds only validated numbers and keywords', () => {
  const hostile = comp([
    { kind: 'heading', text: '<img src=x onerror=alert(1)></style><script>alert(2)</script>' },
    { kind: 'text', text: '"><svg onload=alert(3)>' },
    { kind: 'media', image: PHOTOS[1], alt: '" onerror="alert(4)', aspect: '1x1;}*{display:none}', focus: ['50%;}x{', 1] },
    { kind: 'button', label: '</a><script>', target: 'section:x"><script>' },
  ], { id: 'x"><script>', height: 'screen;}' })
  const { spec } = validateSpec(hostile, CTX)
  const html = render(spec)
  const body = html.slice(html.indexOf('<body'))
  // Attribute VALUES removed first: an escaped value like alt="&quot; onerror=…" is text, not an attribute.
  const tags = (body.replace(/"[^"]*"/g, '""').match(/<[^>]*>/g) || []).join('') // real tags only (escaped text has no '<')
  assert.doesNotMatch(tags, /<script|<svg|\son[a-z]+=/i)
  assert.match(body, /&lt;img src=x onerror=alert\(1\)&gt;/)
  const css = html.slice(html.indexOf('<style>') + 7, html.indexOf('</style>'))
  assert.doesNotMatch(css.replace(/@font-face\{[^}]*\}/g, ''), /\*\{display:none\}|javascript|url\(/, 'only our own font files are loaded')
  for (const rule of css.match(/#[a-z0-9-]+ \.cg>\.cb:nth-child\(\d+\)[^{]*\{[^}]*\}/g)) assert.match(rule, /^#[a-z0-9-]+ \.cg>\.cb:nth-child\(\d+\)( \.cm| img)?\{([a-z-]+:[a-z0-9 /.%-]+;?)+\}$/, rule)
  assert.equal((html.match(/<\/style>/g) || []).length, 1)
})

test('readable overlaps on desktop: text fully on a photo → white over a darkening layer; partly over → a raised card; phones never overlap', () => {
  const { spec } = validateSpec(comp([
    { kind: 'media', image: PHOTOS[0], col: [1, 12], row: [1, 3] },
    { kind: 'heading', text: 'Inside', col: [2, 6], row: [2, 1], z: 1 },
    { kind: 'media', image: PHOTOS[1], col: [7, 6], row: [4, 2] },
    { kind: 'text', text: 'Half over the second photo', col: [4, 6], row: [4, 1], z: 2 },
    { kind: 'text', text: 'Not over anything', col: [1, 3], row: [6, 1] },
  ]), CTX)
  const html = render(spec)
  assert.match(html, /<div class="cb over"><h1[^>]*>Inside<\/h1>/)
  assert.match(html, /<div class="cb raised"><p class="zs-m muted">Half over the second photo/)
  assert.match(html, /<div class="cb"><p class="zs-m muted">Not over anything/)
  assert.match(html, /<div class="cm shape-rect tr-none under">/, 'the photo under the white text gets the darkening layer')
  assert.match(html, /@media\(min-width:861px\)\{\.cb\.over\{color:#fff/, 'overlap styling is desktop-only')
  assert.match(html, /@media\(max-width:860px\)\{#top \.cg>\.cb:nth-child\(1\)\{grid-column:span 4;grid-row:auto;order:0/, 'phones: derived single column in reading order')
})

test('model token form: parse and print are inverses for every direction (both answer shapes), unknown tokens are reported', () => {
  for (const d of Object.values(directions(PHOTOS))) {
    const { spec } = validateSpec(d, CTX)
    const viaCompact = validateSpec(fromCompact(JSON.parse(JSON.stringify(toCompact(spec)))), CTX).spec
    const viaStandard = validateSpec(fromStrict(JSON.parse(JSON.stringify(toStandard(spec)))), CTX).spec
    // Regression (browser test 2026-11-16): the designer's Claude path converts twice — fromStrict(fromCompact(answer)).
    // Parsing already-parsed blocks lost their placement and button labels, and the label-less button was dropped.
    const viaDesignerPath = validateSpec(fromStrict(fromCompact(JSON.parse(JSON.stringify(toCompact(spec))))), CTX).spec
    for (const back of [viaCompact, viaStandard, viaDesignerPath]) assert.deepEqual(back.pages[0].sections[0], spec.pages[0].sections[0])
  }
  // A block dropped for missing content is reported, never silently.
  const dropped = validateSpec(comp([{ kind: 'heading', text: 'Hi' }, { kind: 'button', target: 'book' }, { kind: 'media' }]), CTX)
  assert.equal(dropped.warnings.filter((w) => w.reason === 'empty_block').length, 2)
  const b = parseBlock({ kind: 'media', place: 'c3/4 r1/2 z1 y-end wobble', look: 'aspect-3x4 focus-20-80 duo shape-arch m-span-2 m-hide glitter', text: 'Alt', image: PHOTOS[0] })
  assert.deepEqual(b, { kind: 'media', col: [3, 4], row: [1, 2], z: 1, y: 'end', aspect: '3x4', focus: [20, 80], treat: 'duo', shape: 'arch', m: { span: 2, hide: true }, image: PHOTOS[0], alt: 'Alt', invalid: ['wobble', 'glitter'] })
  assert.ok(validateSpec(comp([{ kind: 'heading', text: 'x' }, b]), CTX).warnings.filter((w) => w.reason === 'invalid_choice').length >= 2)
  assert.deepEqual(blockToModel({ kind: 'button', col: [1, 4], row: [3, 1], z: 0, x: 'start', y: 'start', size: 'm', label: 'Book', target: 'book', secondary: true, m: { order: 2, span: 4, hide: false } }), { kind: 'button', place: 'c1/4 r3/1 z0', look: 'm secondary m-order-2', text: 'Book', image: '', target: 'book' })
})

test('design checks: unusable answers are hard failures; generic or repeated choices are soft; "different" must differ', () => {
  const ok = directions(PHOTOS).editorial
  const v = validateSpec(ok, CTX)
  assert.deepEqual(checkDesign({ raw: ok, ...v }).hard, [])
  assert.deepEqual(checkDesign({ raw: ok, ...v }).soft, [])
  // One section only + a first screen the validator had to invent.
  const thin = { pages: [{ sections: [{ type: 'area', id: 'a' }] }] }
  assert.deepEqual(checkDesign({ raw: thin, ...validateSpec(thin, CTX) }).hard.sort(), ['first_screen_missing', 'too_few_sections'])
  // Many invalid choices.
  const garbled = { theme: { headingFont: 'comic', bodyFont: 'x', density: 'y', buttons: 'z', motion: 'w' }, nav: { layout: 'q' }, footer: { layout: 'r' }, pages: [{ sections: [{ type: 'hero', layout: 'zigzag', height: 'huge', imageSide: 'top', heading: 'Hi' }, { type: 'area', id: 'a', background: 'plaid', spacing: 'xxl' }] }] }
  assert.ok(checkDesign({ raw: garbled, ...validateSpec(garbled, CTX) }).hard.includes('invalid_choices'))
  // A first screen left to the default layout; two identical sections in a row.
  const generic = { pages: [{ sections: [{ type: 'hero', heading: 'Hi' }, { type: 'services', layout: 'cards' }, { type: 'services', layout: 'cards' }] }] }
  assert.deepEqual(checkDesign({ raw: generic, ...validateSpec(generic, CTX) }).soft.sort(), ['default_first_screen', 'repeated_sections'])
  // "Different direction" that only changed words.
  const prev = v.spec
  const same = { ...ok, direction: 'Something else' }
  assert.deepEqual(checkDesign({ raw: same, ...validateSpec(same, CTX), previous: prev, mode: 'different' }).soft, ['same_direction'])
  // The showcase fixtures share one placeholder headline; a real different direction writes its own.
  const posterRaw = structuredClone(directions(PHOTOS).poster)
  for (const b of posterRaw.pages[0].sections[0].blocks) if (b.kind === 'heading') b.text = 'Pools, handled.'
  const poster = validateSpec(posterRaw, CTX)
  assert.deepEqual(checkDesign({ raw: posterRaw, ...poster, previous: prev, mode: 'different' }).soft, [])
  // A new structure that keeps the previous headline (any punctuation/case) is still the same site.
  const heading = (spec) => spec.pages[0].sections[0].blocks.find((b) => b.kind === 'heading')
  const copied = structuredClone(poster.spec)
  heading(copied).text = heading(prev).text.toUpperCase() + '!'
  assert.deepEqual(checkDesign({ raw: copied, spec: copied, warnings: [], previous: prev, mode: 'different' }).soft, ['same_lead'])
  assert.deepEqual(checkDesign({ raw: copied, spec: copied, warnings: [], previous: prev, mode: 'design' }).soft, [], 'only for "different"')
})

test('raw model answers are redacted before they are kept', () => {
  const r = redactRaw({ reply: 'Mail owner@pools.example, call (843) 555-0142, see https://pools.example/x, key sk-ant-api03-ABCDEFGHIJKLMNOP', site: { name: 'Pools' } })
  assert.doesNotMatch(r, /owner@pools|555-0142|https:\/\/|sk-ant/)
  assert.match(r, /\[email\].*\[number\].*\[url\].*\[secret\]/)
  assert.equal(redactRaw({ x: 'y'.repeat(100) }, 40).length, 40)
})

test('regression: the centered navigation keeps Book on the same line (desktop: logo centred, Book right, links below; phones: logo left, Book right)', () => {
  const two = { ...directions(PHOTOS).collage }
  two.pages = [...two.pages, { slug: 'services', navLabel: 'Services', sections: [{ type: 'services', id: 'svc', layout: 'list', items: [] }] }]
  const html = render(validateSpec(two, CTX).spec)
  assert.match(html, /<header class="nav nav-center[^"]*"><div class="wrap"><a class="brand"[^>]*>Pools<\/a><ul>.*<\/ul><a class="btn"/)
  const css = html.slice(html.indexOf('<style>'), html.indexOf('</style>'))
  assert.match(css, /\.nav-center \.wrap\{display:grid;grid-template-columns:1fr auto 1fr;/)
  assert.match(css, /\.nav-center \.brand\{grid-column:2;grid-row:1;text-align:center\}\.nav-center \.btn\{grid-column:3;grid-row:1;justify-self:end\}\.nav-center ul\{grid-column:1\/-1;grid-row:2;justify-content:center\}/)
  assert.doesNotMatch(css, /\.nav-center \.brand\{width:100%/, 'the logo no longer takes the whole row (which pushed Book below it)')
  assert.match(css, /@media\(max-width:820px\)\{[^@]*\.nav-center \.wrap\{grid-template-columns:1fr auto;padding-block:0\}\.nav-center \.brand\{grid-column:1;text-align:left\}\.nav-center \.btn\{grid-column:2\}/)
})

test('Claude compact encoding: composition blocks ride in items and survive the round trip; tolerant size tokens', async () => {
  const { toCompact, fromCompact } = await import('../server/ai-designer.js')
  const spec = validateSpec(directions(PHOTOS).collage, CTX).spec
  const compact = toCompact(spec)
  const sec = compact.pages[0].sections[0]
  assert.ok(!('blocks' in sec) && sec.items.length === spec.pages[0].sections[0].blocks.length)
  assert.equal(compact.name, spec.direction)
  const back = validateSpec(fromCompact(compact), CTX)
  assert.deepEqual(back.spec.pages[0].sections[0].blocks, spec.pages[0].sections[0].blocks)
  assert.equal(back.spec.direction, spec.direction)
  const { parseBlock } = await import('../server/design-blocks.js')
  for (const look of ['size display', 'size-display', 'display']) assert.deepEqual([parseBlock({ kind: 'heading', place: 'c1/6', look, text: 'x' }).size, parseBlock({ kind: 'heading', place: 'c1/6', look, text: 'x' }).invalid], ['display', undefined])
})

test('a different direction must change the first-screen structure: a mirrored, recoloured copy is still the same direction', async () => {
  const { firstScreenStructure } = await import('../server/design-checks.js')
  const a = validateSpec(directions(PHOTOS).editorial, CTX).spec
  const mirror = structuredClone(a)
  for (const b of mirror.pages[0].sections[0].blocks) b.col = [13 - b.col[0] - b.col[1] + 1, b.col[1]]
  mirror.theme.headingFont = a.theme.headingFont === 'fraunces' ? 'syne' : 'fraunces'
  assert.equal(firstScreenStructure(mirror), firstScreenStructure(a))
  assert.notEqual(firstScreenStructure(validateSpec(directions(PHOTOS).poster, CTX).spec), firstScreenStructure(a))
  assert.notEqual(firstScreenStructure(validateSpec(directions(PHOTOS).collage, CTX).spec), firstScreenStructure(a))
})

// Live designs, 2026-11-16: a full-width photo with words over it kept its 21:9 proportion as a grid item, so taller
// type made it grow past the page edge (desktop) and it sat inside the page margins on a dark band; a photo beside a
// stack of words spread its extra height between the rows (a button far below its text); on phones a photo box sized
// from its height overflowed the screen.
test('composition roles: a full-width photo under words is a backdrop; a full-height photo centres the stack beside it', async () => {
  const { compositionRoles, parseBlock } = await import('../server/design-blocks.js')
  const { renderV2 } = await import('../server/site-render-v2.js')
  const { validateSpec } = await import('../server/site-spec.js')
  const P = (place, look, kind, text = 'Words here', image = '') => parseBlock({ kind, place, look, text, image: image && `asset:${image}`, target: kind === 'button' ? 'book' : '' })
  const A = 'a'.repeat(32)
  const immersive = [P('c1/12 r1/5 z0 y-stretch', 'aspect-21x9 scrim m-order-4', 'media', 'A pool', A), P('c2/8 r2/2 z1 y-end', 'display m-order-1', 'heading', 'A pool that is ready'), P('c2/5 r4/1 z1', 'm m-order-2', 'text'), P('c2/3 r5/1 z1', 'm-order-3', 'button', 'Book a visit')]
  const beside = [P('c1/5 r1/4 z0', 'aspect-4x5 m-order-4', 'media', 'A pool', A), P('c7/6 r1/2 z1', 'xl m-order-1', 'heading', 'Clear water'), P('c7/5 r3/1 z1', 'm m-order-2', 'text'), P('c7/3 r4/1 z1', 'm-order-3', 'button', 'Book a visit')]
  const one = compositionRoles(immersive)
  assert.equal(one.backdrop, immersive[0])
  assert.equal(one.centred.size, 0)
  const two = compositionRoles(beside)
  assert.equal(two.backdrop, null)
  assert.deepEqual([...two.centred], [beside[0]])
  assert.equal(compositionRoles([P('c1/6 r1/1 z0', 'aspect-4x3', 'media', 'A', A), P('c7/6 r1/1 z0', 'xl', 'heading', 'One row')]).centred.size, 0, 'a single row keeps its own alignment')

  const ctx = { assetIds: new Set([A]), services: [], claims: [] }
  const page = (blocks, width) => renderV2({ id: 'p', name: 'Pools', cities: [], phone: '', services: [] }, validateSpec({ pages: [{ slug: '', navLabel: 'Home', sections: [{ type: 'composition', id: 'top', width, height: 'screen', background: 'ink', blocks }] }] }, ctx).spec, { bookUrl: '/book/p', year: 2026 })
  const full = page(immersive, 'full')
  assert.match(full, /<section id="top" class="[^"]*w-full[^"]*has-bd"/)
  assert.match(full, /<div class="cb bd">/)
  assert.match(full, /@media\(max-width:860px\)\{#top \.cg>\.cb:nth-child\(1\) \.cm\{aspect-ratio:21\/9\}\}/, 'the backdrop keeps its proportion only on phones')
  assert.match(full, /@media\(min-width:861px\)\{#top\{min-height:min\(calc\(100vw \* 9 \/ 21\),85vh\)\}\}/)
  assert.match(page(immersive, 'wide'), /#top \.cg\{min-height:/, 'not full width: the backdrop fills the content area')
  const side = page(beside, 'wide')
  assert.match(side, /#top \.cg\{grid-template-rows:minmax\(0,1fr\) repeat\(4,auto\) minmax\(0,1fr\)/)
  assert.match(side, /#top \.cg>\.cb:nth-child\(1\)\{grid-column:1 \/ span 5;grid-row:1 \/ 7;/, 'the photo spans both spacer rows')
  assert.match(side, /#top \.cg>\.cb:nth-child\(2\)\{grid-column:7 \/ span 6;grid-row:2 \/ span 2;/, 'the stack moves down one line')
  assert.match(side, /\.cm\{position:relative;overflow:hidden;width:100%;/, 'photo boxes take their width from the column, never from their height')
})

test('balance: a ragged text stack is not a hole; a photo mostly hidden under a layered card is flagged', async () => {
  const { parseBlock } = await import('../server/design-blocks.js')
  const { compositionBalance } = await import('../server/design-checks.js')
  const P = (place, look, kind, text = 'Words here and a few more words') => parseBlock({ kind, place, look, text, image: kind === 'media' ? `asset:${'a'.repeat(32)}` : '', target: kind === 'button' ? 'book' : '' })
  // Claude's "different" spread (2026-11-16): wide headline, narrower text, short button, sharing a left edge.
  assert.deepEqual(compositionBalance({ type: 'composition', blocks: [P('c1/5 r1/4 z0', 'aspect-4x5', 'media'), P('c7/6 r1/2 z1', 'xl', 'heading', 'Clear water, clear communication'), P('c7/5 r3/1 z1', 'm', 'text'), P('c7/3 r4/1 z1', '', 'button', 'Book a visit')] }), [])
  // GPT's revision (2026-11-16): a 4-column photo with the display headline card over most of it.
  const buried = [P('c1/5 r1/5 z0 y-stretch', 'aspect-4x5', 'media'), P('c9/4 r1/2 z0 y-stretch', 'aspect-4x3', 'media'), P('c6/3 r1/1 z1 y-center', 's', 'text', 'Pool care / Charleston, SC'), P('c6/7 r2/2 z2 y-center', 'display', 'heading', 'Less upkeep. More pool time.'), P('c6/6 r4/1 z1', 'm', 'text'), P('c6/4 r5/1 z1 y-end', '', 'button', 'Book a pool visit')]
  assert.ok(compositionBalance({ type: 'composition', blocks: buried }).includes('buried_photo'))
})
