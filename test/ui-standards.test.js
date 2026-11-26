// Static guards for the product quality standards (docs/DESIGN_SYSTEM.md). They read source files only.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'

const root = new URL('../', import.meta.url)
const read = (p) => readFileSync(new URL(p, root), 'utf8')
const filesUnder = (dir) =>
  readdirSync(new URL(dir, root), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? filesUnder(`${dir}${e.name}/`) : /\.(jsx|js)$/.test(e.name) ? [`${dir}${e.name}`] : []))
const withoutComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

// Native confirm() dialogs still in the signed-in product, with the finding that retires them. This list can only
// shrink: converting a file to ConfirmInline (src/dashboard/ui.jsx) means lowering or removing its number here; a new
// call anywhere fails the test.
const NATIVE_CONFIRMS = {
  'src/dashboard/Home.jsx': 1, // SET-05 (leaving a tab with unsaved changes)
  'src/dashboard/ProviderControl.jsx': 2, // ADM-02 batch (admin voice provider switch / rollback)
  'src/admin/Admin.jsx': 7, // ADM-02 batch
}

test('no new native confirm() dialogs in the dashboard or the admin console (the allowlist only shrinks)', () => {
  const found = {}
  for (const file of [...filesUnder('src/dashboard/'), ...filesUnder('src/admin/')]) {
    const n = (withoutComments(read(file)).match(/(?<![.\w])(?:window\.)?confirm\(/g) || []).length
    if (n) found[file] = n
  }
  for (const [file, n] of Object.entries(found)) {
    assert.ok(file in NATIVE_CONFIRMS, `${file} calls confirm(): use <ConfirmInline> from src/dashboard/ui.jsx`)
    assert.ok(n <= NATIVE_CONFIRMS[file], `${file} has ${n} confirm() calls, more than the ${NATIVE_CONFIRMS[file]} recorded: use <ConfirmInline>`)
  }
  for (const [file, n] of Object.entries(NATIVE_CONFIRMS)) {
    assert.equal(found[file] || 0, n, `${file} now has ${found[file] || 0} confirm() calls: lower its number in NATIVE_CONFIRMS (currently ${n}) so it cannot grow back`)
  }
})

// Native alert() / prompt() still in place (same rule: the list only shrinks). The prompt() ones are the fallback of a
// Copy button when the clipboard is refused; show the value selected in the page instead.
const NATIVE_ALERTS = {
}

test('no new native alert() or prompt() in the dashboard or the admin console (the allowlist only shrinks)', () => {
  const found = {}
  for (const file of [...filesUnder('src/dashboard/'), ...filesUnder('src/admin/')]) {
    const n = (withoutComments(read(file)).match(/(?<![.\w])(?:window\.)?(?:alert|prompt)\(/g) || []).length
    if (n) found[file] = n
  }
  assert.deepEqual(found, NATIVE_ALERTS, 'show the message in the page; when you remove one, remove it from NATIVE_ALERTS too')
})

test('the shared kit exports the primitives the standard names', () => {
  const ui = read('src/dashboard/ui.jsx')
  for (const name of ['Pill', 'PageHeader', 'Section', 'LoadError', 'TabBar', 'SaveBar', 'SaveButton', 'SaveStatus', 'ConfirmInline', 'Loading', 'EmptyState']) {
    assert.match(ui, new RegExp(`export function ${name}\\(`), `ui.jsx exports ${name}`)
  }
  const hooks = read('src/dashboard/ui-hooks.js')
  for (const name of ['useSaveState', 'usePageTitle']) assert.match(hooks, new RegExp(`export function ${name}\\(`), `ui-hooks.js exports ${name}`)
  const doc = read('docs/DESIGN_SYSTEM.md')
  for (const name of ['TabBar', 'SaveBar', 'SaveStatus', 'ConfirmInline', 'Loading', 'EmptyState', 'useSaveState', 'usePageTitle', 'plural', 'humanDate', 'money']) {
    assert.ok(doc.includes(name), `docs/DESIGN_SYSTEM.md explains ${name}`)
  }
})

test('one shell: the dashboard and the admin console both use the shared tab row and name the browser tab in one place', () => {
  for (const file of ['src/dashboard/Home.jsx', 'src/admin/Admin.jsx']) {
    const src = read(file)
    assert.match(src, /<TabBar /, `${file} renders the shared TabBar`)
    assert.match(src, /usePageTitle\(/, `${file} sets the browser title with usePageTitle`)
    assert.doesNotMatch(src, /<nav className="tabs"/, `${file} must not hand-build the tab row`)
  }
  // Admin sections must not set their own title (it went stale after in-app navigation: finding ADM-03).
  for (const file of filesUnder('src/admin/')) {
    if (file === 'src/admin/Admin.jsx') continue
    assert.doesNotMatch(read(file), /document\.title\s*=/, `${file}: the admin shell names the browser tab`)
  }
})

test('the page frame and the touch-target floor are defined once, in src/app.css', () => {
  const css = read('src/app.css')
  assert.match(css, /--frame: 1400px/)
  assert.match(css, /\.app > \.app-header,\s*\.app > \.tabs-wrap \{\s*max-width: var\(--frame\)/)
  assert.match(css, /@media \(pointer: coarse\), \(max-width: 640px\) \{[\s\S]*?min-height: 44px/)
  assert.equal((css.match(/--frame:/g) || []).length, 1, 'one definition of the frame width')
})
