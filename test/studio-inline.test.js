// Website Studio in-place editing: the renderer marks editable text, buttons and photos ONLY in the editor preview
// (public pages never carry them), and AI designs that open a page twice are flagged for a revision.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { validateSpec } from '../server/site-spec.js'
import { renderV2 } from '../server/site-render-v2.js'
import { checkDesign } from '../server/design-checks.js'

const draft = JSON.parse(readFileSync(new URL('./e2e/editor-draft.json', import.meta.url), 'utf8'))
const spec = validateSpec(draft.site, { services: draft.services, assetIds: new Set(), claims: [] }).spec
const biz = { name: 'Editor Pools', cities: [], services: draft.services }

test('editor preview marks text, buttons and photos with field paths; public pages carry no marks', () => {
  const editor = renderV2(biz, spec, { editing: true })
  const marks = [...editor.matchAll(/data-(edit|btn|img)="([^"]+)"/g)].map((m) => `${m[1]}:${m[2]}`)
  assert.ok(marks.includes('edit:top|heading'))
  assert.ok(marks.includes('btn:top|primaryCta'))
  assert.ok(marks.includes('img:top|image'))
  assert.ok(marks.some((m) => /^edit:svc\|[^.]+\.price$/.test(m)), 'service prices edit the shared service record')
  for (const m of marks) assert.match(m, /^(edit|btn|img):[a-z0-9-]+\|[A-Za-z0-9.]+$/, 'only ids and field paths, nothing else')
  const pub = renderV2(biz, spec, {})
  assert.doesNotMatch(pub, /data-(edit|btn|img)=/)
  assert.doesNotMatch(pub, /contenteditable/)
})

test('design checks: a second opening further down a page is flagged (repeated_opening)', () => {
  const twice = structuredClone(spec)
  twice.pages[0].sections.push({ ...structuredClone(twice.pages[0].sections[0]), id: 'top-2' })
  const raw = { pages: [{ sections: twice.pages[0].sections }] }
  assert.ok(checkDesign({ raw, spec: twice }).soft.includes('repeated_opening'))
  assert.ok(!checkDesign({ raw: { pages: [{ sections: spec.pages[0].sections }] }, spec }).soft.includes('repeated_opening'))
})
