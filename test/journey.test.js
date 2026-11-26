// The Website tab's "step by step" journey (src/dashboard/journey.js): derived only from real state, one current step,
// honest labels (never "connected" before the domain is; "recommended" import before moving a domain).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { journeySteps } from '../src/dashboard/journey.js'

const state = (s) => s.map((x) => [x.id, x.done, x.pill[1]])
const current = (s) => s.find((x) => !x.done)?.id ?? null

test('new business: nothing done; content is the next step (import offered when Studio is available)', () => {
  const s = journeySteps({ website: { generated: true, published: false, draft: null }, domain: null, studio: true }, null)
  assert.equal(current(s), 'content')
  assert.deepEqual(s[0].action, ['Import my current website', 'site-import'])
  assert.deepEqual(state(s).map((x) => x[1]), [false, false, false, false, false])
  const noStudio = journeySteps({ website: { generated: true, published: false, draft: null }, domain: null, studio: false }, null)
  assert.deepEqual(noStudio[0].action, ['Create my website', 'site-create'])
})

test('PoolThru today: published AI site, no import, domain waiting for the www change → domain is next, import recommended', () => {
  const s = journeySteps(
    { website: { generated: false, published: true, changed: false, draft: { site: {} } }, domain: { hostname: 'www.poolthru.com', status: 'securing', step: 'point', detail: 'waiting_for_cname' }, studio: true },
    null,
  )
  assert.deepEqual(state(s), [
    ['content', true, 'Ready'],
    ['edit', true, 'Reviewed'], // not "Draft ready" once it is live (WEB-12)
    ['publish', true, 'Live'],
    ['domain', false, 'Needs your DNS change'],
    ['verify', false, 'After the switch'],
  ])
  assert.equal(current(s), 'domain')
  assert.equal(s[0].recommend, true)
  assert.match(s[3].detail, /Change one DNS record so www\.poolthru\.com shows your new website/)
})

test('after an import with old addresses kept, nothing is "recommended"; unpublished changes are flagged; connected → verified', () => {
  const imp = { status: 'done', appliedAt: Date.UTC(2026, 10, 18), sourceUrl: 'https://www.poolthru.com/' }
  const w = { generated: false, published: true, changed: true, draft: { redirects: [{ from: '/services', to: '/#services' }] } }
  const s = journeySteps({ website: w, domain: { hostname: 'www.poolthru.com', status: 'securing', step: 'point', detail: 'waiting_for_cname' }, studio: true }, imp)
  assert.equal(s[0].detail, 'Imported from www.poolthru.com on Nov 18 · 1 old address kept.')
  assert.equal(s[0].recommend, false)
  assert.deepEqual([current(s), s[2].pill, s[2].action], ['publish', ['warn', 'Changes not published'], ['Publish changes', 'publish']])
  // Same guard as the status card: an unkept AI revision / unsaved edit / paused publishing → no Publish action here.
  assert.equal(journeySteps({ website: w, domain: null, studio: true }, imp, { canPublish: false })[2].action, null)
  const done = journeySteps({ website: { ...w, changed: false }, domain: { hostname: 'www.poolthru.com', status: 'connected', step: 'point', url: 'https://www.poolthru.com' }, studio: true }, imp)
  assert.equal(current(done), null)
  assert.deepEqual(done[4].action, ['Open my website', 'https://www.poolthru.com'])
})

test('domain states read honestly: verification, preparing, securing, needs attention', () => {
  const pill = (d) => journeySteps({ website: { generated: false, published: true, draft: {} }, domain: d, studio: true }, null)[3].pill
  assert.deepEqual(pill({ hostname: 'www.x.com', status: 'pending', step: 'verify' }), ['warn', 'Add the verification record'])
  assert.deepEqual(pill({ hostname: 'www.x.com', status: 'verifying', step: 'activate' }), ['info', 'Preparing hosting'])
  assert.deepEqual(pill({ hostname: 'www.x.com', status: 'securing', step: 'point', detail: 'certificate_pending' }), ['info', 'Securing (https)'])
  assert.deepEqual(pill({ hostname: 'www.x.com', status: 'needs_attention', step: 'point', detail: 'dns_changed' }), ['bad', 'Needs attention'])
  assert.deepEqual(pill(null), ['neutral', 'Optional'])
})
