# GetShowUps design system and product quality standard

The canonical standard for every screen of the signed-in product: dashboard, onboarding, admin console. Written for
engineers and AI agents; every rule is checkable. The marketing site follows the visual rules in CLAUDE.md
("Conventions"); the customer booking page, the public chat page and business websites have their own isolated styling
and are out of scope, except for sections 8 to 12, which apply to everything a person uses.

Guards: `test/e2e/quality.spec.js` (frame, titles, phone tab row, 44 px targets, copy), `test/ui-standards.test.js`
(no native dialogs, one shell, one frame), `test/format.test.js` (text helpers), `test/e2e/tour.spec.js` (one heading,
no sideways scroll, no error on load). Findings that led here: `docs/quality/USABILITY_FINDINGS.md`.

## 1. Tokens (src/index.css `:root`; the app scope `.app` in src/app.css adjusts a few)

Use tokens, never raw values. Do not add a token, a colour or a gradient without a design decision recorded here.

| Group | Tokens | Use |
| --- | --- | --- |
| Type scale | `--fs-xs` 0.78rem · `--fs-sm` 0.875rem · `--fs-md` 1rem · `--fs-lg` 1.125rem · `--fs-xl` 1.5rem | xs: pills, table meta · sm: hints, secondary text · md: body, inputs · lg: detail titles · page title: 1.55rem (1.35rem on phones), set once for every `h1` in `.app-main` |
| Fonts | `--font` (Inter) · `--font-label` (Space Grotesk) | Inter for everything; Space Grotesk only for small labels and numerals |
| Spacing | `--s-1` 4 · `--s-2` 8 · `--s-3` 12 · `--s-4` 16 · `--s-5` 24 · `--s-6` 32 · `--s-7` 48 (px) · `--gutter` | gaps and padding; cards are `--s-5` apart; page side padding is `--gutter` |
| Text | `--text` (ink-900) · `--text-muted` (ink-500) · `--ink-950…50` | muted text must still be AA on its background (ink-500 on white is) |
| Surfaces | `--surface` white · `--surface-sunken` · `--surface-muted` · `--cloud` (page canvas) · `--border` · `--border-strong` | cards are white on the cool canvas with a hairline |
| Status | `--ok-*` · `--warn-*` · `--bad-*` · `--info-*` · `--neutral-*` (each: `-text`, `-bg`, `-dot`) | meaning only, see section 7; never decoration |
| Brand | `--orange-500` (logo) · `--accent-text` (orange-700, AA on light) · `--focus-ring` | orange = the logo, focus, the current step. The logo (`src/components/Logo.jsx`) is the only brand mark |
| Radii | `--radius-sm` 8 · `--radius` 12 · `--radius-lg` 16 (px, app scope) | sm: inputs, small buttons, callouts · default: cards · lg: panels |
| Shadows | `--shadow-sm` · `--shadow-card` · `--shadow-float` (+ app `--shadow`, `--shadow-lg`) | resting cards use a hairline or `--shadow-sm`; `--shadow-float` only for things above the page (menus, panels) |
| Motion | `--ease`, 0.15–0.2 s | state changes only; everything honours `prefers-reduced-motion` |

`--beam` and the `--sky-*` / `--mint-*` / `--lav-*` tints belong to the marketing canvas and thin accent edges; app
screens do not add new uses.

## 2. Layout frame (ONE frame)

- Shell = `.app` > `header.app-header` (logo left, account controls right) > `TabBar` > `main.app-main`.
- The header and the tab row are `--frame` (1400 px) wide and sit at the same x on every dashboard tab and every admin
  section. Ordinary pages read at `--content` (880 px) and start at the logo's left edge; a page that needs room
  (website editor, inboxes, wide tables) adds `app--wide` to the shell, which widens only the content.
- Never set `max-width` or `margin: auto` on the header or tab row from a page, and never centre a page's content in a
  different column. `html:has(.app)` reserves the scrollbar gutter so short and long pages do not shift.
- One `h1` per page, the page title, same size everywhere (`.title.title--page`, `.ui-page-title` or `PageHeader`).
- The browser tab title is set by the shell with `usePageTitle()` on every navigation; pages never assign
  `document.title` themselves.
- Page order: title → what needs attention → the primary content → secondary and rarely used things last.

## 3. Buttons

- Primary = ink (`.btn.btn-primary`). One primary per view; a self-contained form card may have its own Save as the
  primary of that card. Secondary = `.btn.btn-quiet`. Destructive = `.btn.btn-danger`, only on the confirming step.
  Text action = `.link-btn`. Sizes: default, `.btn-sm` (dense rows), `.btn-lg.btn-block` (the one action of a step).
- A button says what it does ("Save hours", "Remove photo"), never "OK" or "Submit". Two adjacent buttons never differ
  only by punctuation ("Cancel" vs "Cancel…").
- A disabled button has a visible reason next to it, or is not rendered.
- A button that starts a request shows progress in its label ("Saving…") and is ALWAYS enabled again when the request
  settles: success, refusal, network failure, or nothing to do.

## 4. Forms

- Label above the field (`label.field > span + input`); placeholder is an example, never the label. Optional fields
  say `<em>optional</em>`; required is the default and is not marked.
- Validate on submit and show ALL problems at once, each next to its field (`.field-error`, linked with
  `aria-describedby`, field `aria-invalid`), plus focus on the first one. Never one error per submit, never an error
  naming a field that is not on the screen, never silent acceptance of malformed input (a refused value is not stored).
- A refused value stays in the field so it can be corrected. Typed text survives a failed save.
- Inputs use the right keyboard (`inputMode`, `type="tel"`, `autoComplete`). Website fields use `inputMode="url"`.
- Long choice lists are ordered for the person (likely choices first, at most about 20 visible before a search).
- Controls that save on change (switch, select, checkbox) say so by confirming (section 5); a page never mixes
  "saves instantly" and "needs Save" for the same kind of control without labelling it.

## 5. Feedback (ONE save pattern)

Nothing saves silently and nothing fails silently.

- Every save uses `useSaveState()` with `SaveBar` (or `SaveButton` + `SaveStatus`): "Saving…" while pending → the
  control is enabled again → "Saved." (`role="status"`) beside the control for about 2.5 s (longer for a sentence), or
  the error (`role="alert"`) which stays until the next attempt.
- The confirmation appears where the person is looking: next to the control that saved, inside the viewport. If the
  result is elsewhere on the page, scroll it into view or repeat it next to the control.
- After a destructive or state-changing action, say what happened with the specifics ("Cancelled Jamie Rivera,
  Thu 3:00 PM") and where the item went.
- A conflict (changed elsewhere) is an error with the next step, never a silent overwrite.

## 6. States

Every data view has four states, all designed:

- Loading: `<Loading what="your services" />` (or the page skeleton); never an empty form, never a bare "Loading…".
- Empty: `<EmptyState>` says what will appear here and offers the action that fills it.
- Error: `<LoadError what="…" onRetry={load} />`; an error always carries a recovery action (Retry, a link to the
  place that fixes it, or who to contact). A failed load never renders as "no data".
- Ready: the content.

Unavailable features say why and what happens next ("Not available yet: …"), and are not offered as working controls.

## 7. Status (ONE component)

`<Pill tone="…">` (`.ui-pill`) is the only status indicator; text + dot, never colour alone.

| Tone | Means | Examples |
| --- | --- | --- |
| `ok` | confirmed working, done | Connected, Live, Paid |
| `warn` | needs review, pending, test mode | Pending, Draft, Test |
| `bad` | failed, broken, urgent | Needs reconnecting, Payment failed |
| `info` | informational | New, Scheduled |
| `neutral` | off, not connected, completed, not available | Off, Not connected, Ended |

One word means one thing across the product ("Live" is not also "published" and "billing on"). The older `.tag`,
`.status` and admin chip styles are legacy: new work uses `Pill`, and touched screens convert.

## 8. Navigation

- Top level = `TabBar` (dashboard tabs, admin sections). One row; on narrow screens it scrolls inside itself, the
  current tab is brought into view, and a cut-off side fades and shows an arrow. No second navigation model.
- Every view that can be reached has an address: tabs, sub-views and selected items live in the URL so reload, Back
  and a shared link land in the same place.
- A link that names a place goes to that place and lands where the thing is visible (not at the top of a long page).
- One name per concept and one place per setting. If two places must show the same setting, each names the other and
  says which one applies.

## 9. Tables and lists

- Rows: `.ui-list` / `.rows`; the primary text left, numbers right-aligned with `tabular-nums`, one action per row
  visible without hover. More than about 20 rows gets search or filtering; long groups collapse.
- Numbers come from records; a missing number is "Unavailable" with the reason, never 0.

## 10. Copy

- Plain business language, sentence case, no exclamation marks. Say what happens to the customer.
- Never show internal names: environment switches (`STRIPE_LIVE_ENABLED`), table or migration names, error codes,
  "(approval)", "test recipients". Say the effect instead ("Live billing isn't on yet").
- No vendor names in owner-facing copy (voice, texting and AI providers), except where the owner must act in that
  vendor's product (Google Calendar, Google Ads, Stripe billing portal).
- Counts through `plural()`: "1 visit", "2 visits"; never "visit(s)", never "1 visits".
- Dates through `humanDate()` / `humanDateTime()`: "Thu, Nov 26"; never `2026-11-26`. Times carry a time zone label
  wherever the reader may be in another zone.
- Money through `money()`: "$1,234", "−$10,266"; estimates, invoices and payments are labelled as such.
- The same quantity has the same name and the same value on every screen that shows it.

## 11. Cognitive load

- Ask only what cannot be inferred from records or earlier answers; prefill and let the owner edit.
- Defaults are the common case and are always editable. Advanced settings sit behind a disclosure (`details`).
- One way to do each thing. Two entry points may exist only if they lead to the same tool.
- One decision per step in a flow; the first screen of an empty tool offers at most two starting choices.
- Progress is preserved: reload, Back, a failed request and a tab switch never lose typed or chosen values.
- What needs attention appears once, in one list, ordered by urgency, with the fixing action on the row.

## 12. AI interactions

- Answer from the business's records first; a fact that exists is returned, not paraphrased into advice.
- A non-answer states why and what to do next ("I can't change prices here because …. Open Services to edit them").
  "Nothing would change" is never the whole reply; an action that cannot run is not rendered as a greyed button.
- Changes are proposed, never applied: propose → show before and after → the owner approves → saved → confirmed. Every
  clause of a request is accounted for as changed, already true, or not changed with the reason.
- Offered examples and suggestion chips must work when clicked.
- No unnecessary model calls: opening a page, previewing, switching tabs and reading records never call a model.
  Limits and counters are spent only by results the owner actually received.

## 13. Accessibility

- WCAG 2.1 AA contrast for text and for the boundary of controls; status never by colour alone.
- Every control is reachable by keyboard and has a visible focus ring (`--focus-ring`); no hover-only controls.
- Touch targets: on touch screens and phone widths every control is at least 44 px tall (shared rule in
  `src/app.css`, `@media (pointer: coarse), (max-width: 640px)`). Exceptions are listed, with reasons, in
  `test/e2e/quality.spec.js` (`SMALL_ON_PURPOSE`): text links inside a sentence, and marks whose tap area is extended.
- Every input has a label; icon buttons have `aria-label`; one `h1` per page and headings in order.
- Confirmations use `role="status"`, errors `role="alert"`; loading regions set `aria-busy`.
- Motion respects `prefers-reduced-motion`. No native `confirm()`, `alert()` or `prompt()`: use `ConfirmInline`.

## 14. Responsive

- Two intentional layouts: desktop 1440 × 900 and phone 390 × 844. Check both for every UI change.
- No page-level sideways scrolling at any width from 320 px; wide content (tables, tab rows) scrolls inside itself
  and shows that it does.
- The primary action and the thing that needs attention are on the first screen at both sizes.
- Text never clips: fields and badges fit their longest realistic content or wrap.

## 15. How to use the shared primitives

Components: `src/dashboard/ui.jsx` · hooks: `src/dashboard/ui-hooks.js` · text: `src/lib/format.js` · styles: the
`.ui-*` rules and the "Product quality foundation" block at the end of `src/app.css`. Both the dashboard and the admin
console import from these files.

```jsx
import { ConfirmInline, EmptyState, LoadError, Loading, Pill, SaveBar, SaveButton, SaveStatus, TabBar } from '../dashboard/ui.jsx'
import { usePageTitle, useSaveState } from '../dashboard/ui-hooks.js'
import { humanDate, humanDateTime, money, plural } from '../lib/format.js'

// A form with a save button
const save = useSaveState()
const submit = (e) => {
  e.preventDefault()
  save.run(async () => {
    const { status, data } = await api('/api/dashboard/hours', { method: 'POST', body })
    if (status !== 200) return { error: errorText(data.error) } // shown as role=alert, stays
    return { saved: 'Saved. Customers see it now.' }            // or return nothing → "Saved."
  })                                                            // return false → nothing to save, no message
}
<form className="form" onSubmit={submit}> … <SaveBar save={save}>Save hours</SaveBar></form>

// A control that saves on change (switch, checkbox, select, field saved on blur or Enter)
const save = useSaveState()
<input type="checkbox" checked={on} disabled={save.pending} onChange={(e) => save.run(() => post(e.target.checked))} />
<SaveStatus save={save} />

// A button that is not a form submit
<SaveButton save={save} type="button" className="btn btn-sm btn-primary" onClick={() => save.run(publish)}>Publish</SaveButton>

// A destructive action
{asking ? (
  <ConfirmInline question="Remove this photo?" detail="It leaves your website when you publish." confirmLabel="Remove" busy={busy} onConfirm={remove} onCancel={() => setAsking(false)} />
) : (
  <button type="button" className="link-btn" onClick={() => setAsking(true)}>Remove</button>
)}

// States
if (data === undefined) return <Loading what="your services" />
if (data === null) return <LoadError what="your services" onRetry={load} />
if (!data.length) return <EmptyState title="No services yet" action={<button className="btn btn-primary" onClick={add}>Add a service</button>}>Customers see what you add here on your booking page.</EmptyState>

// Shell
usePageTitle(currentLabel)                                        // "Appointments · GetShowUps"
<TabBar label="Dashboard" tabs={[[id, label, href]]} current={view} onGo={(id, href) => …} />

// Text
plural(n, 'visit')                    // "1 visit" · "2 visits"      plural(n, 'person', 'people')
humanDate('2026-11-26')               // "Thu, Nov 26"               humanDateTime(ms, { timeZone })
money(cents)                          // "$1,234" · "−$10,266" · "—" when missing
<Pill tone="warn">Pending</Pill>
```

Reference usages: the six Settings saves and the "Other / Not sure" checkbox in `src/dashboard/forms.jsx`; the shells
in `src/dashboard/Home.jsx` and `src/admin/Admin.jsx`.

## 16. Usability acceptance checklist (every PR that changes UI)

1. Follows the frame: header and tab row untouched; one `h1`; title set by the shell.
2. One primary action per view; buttons say what they do; no disabled control without a visible reason.
3. Every save uses the save pattern; nothing saves or fails silently; the confirmation is in the viewport.
4. All four states exist (loading, empty, error with a recovery action, ready).
5. Errors appear next to their fields, all at once; refused input is not stored and stays editable.
6. Copy: plain words; no internal or vendor names; `plural()`, `humanDate()`, `money()`; sentence case.
7. Reload, Back and a failed request lose nothing the person typed or chose; the view has an address.
8. Keyboard: every control reachable, focus visible, no hover-only control; labels and roles present.
9. Phone 390 px and desktop 1440 px both checked: no sideways scroll, 44 px targets, nothing clipped, the primary
   action on the first screen.
10. No native dialogs; destructive actions confirm in the page with `ConfirmInline`.
11. AI replies: a fact when one exists; a non-answer explains itself and gives the next step; changes only after
    approval; no model call that the person did not ask for.
12. A Playwright check covers the new flow (`test/e2e/`, import `test` from `./test.js`); `quality.spec.js` still
    passes and the `SMALL_ON_PURPOSE` and `NATIVE_CONFIRMS` lists did not grow.
