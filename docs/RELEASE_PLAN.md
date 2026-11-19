# Release plan: #80 → #81 → #82 (prepared 2026-11-19, NOT executed)

Every step below that touches production needs the owner's explicit approval of this plan. Nothing here enables live
billing, email, SMS, voice, ads or signup. Run from the main checkout (`/Users/florasummit/getshowups`), on `main`.

## 0. What was verified before this plan (evidence)

| Check | Result |
| --- | --- |
| PR heads / CI | #80 b7a7fad ✅ verify + Pages · #81 ec5e4f3 ✅ · #82 head at approval time ✅ (includes the 320 px header fix 657caa5) |
| Rehearsal of this exact order on main 425d311 | #80 clean; #81 and #82 conflict only in docs/STATUS.md (keep both; the PR being merged goes first) |
| Rehearsed tree `verify:all` | 634/634 unit (incl. 12 render goldens), Playwright 166 passed / 1 skipped (opt-in screenshot), lint clean |
| Customer sites (render through site-serve from the 2026-11-19 14:32Z backup) | PoolThru ×5 pages, bob-electrical, toys-for-us **byte-identical to main**, receptionist link on and off |
| Migration 0030 | `CREATE TABLE/INDEX IF NOT EXISTS` only; no existing table touched; code fails soft without it (Hide → `not_available`, lists unchanged); erased with the account |
| Pending outbox at backup time | none (so #81's 23 h expiry closes nothing at deploy) — re-check in step 1 |

## 1. Backup and pre-release capture (read-only toward production)

```sh
cd /Users/florasummit/getshowups && git checkout main && git pull --ff-only
TS=$(date -u +%Y%m%dT%H%M%SZ)
npx wrangler d1 export getshowups-onboarding --remote --output ~/getshowups-backups/prod-$TS-pre-pr80.sql
sqlite3 /tmp/verify-$TS.db < ~/getshowups-backups/prod-$TS-pre-pr80.sql && sqlite3 /tmp/verify-$TS.db 'PRAGMA integrity_check'   # → ok
# Counts to compare after the release (one SELECT; D1 rejects big UNION ALL):
Q="SELECT (SELECT count(*) FROM customers) c, (SELECT count(*) FROM websites) w, (SELECT count(*) FROM website_versions) v, (SELECT count(*) FROM website_assets) a, (SELECT count(*) FROM appointments) ap, (SELECT count(*) FROM leads) l, (SELECT count(*) FROM self_signups) s, (SELECT count(*) FROM email_outbox WHERE status='pending') p, (SELECT count(*) FROM receptionist_settings WHERE enabled=1) r"
npx wrangler d1 execute getshowups-onboarding --remote --command "$Q"; sqlite3 /tmp/verify-$TS.db "$Q"     # must match
# Current production deployment = rollback target (write the id down):
npx wrangler pages deployment list --project-name getshowups --environment production | head -5
# Live HTML of the protected sites (per-request form token and Cloudflare e-mail obfuscation normalised):
cap() { mkdir -p "$1"; for p in poolthru-llc poolthru-llc/services poolthru-llc/about poolthru-llc/contact poolthru-llc/privacy bob-electrical toys-for-us; do
  curl -s "https://getshowups.com/p/$p" | sed -E 's/name="t" value="[^"]*"/name="t" value=""/g; s/data-cfemail="[^"]*"//g; s/email-protection#[0-9a-f]+/email-protection#/g' > "$1/${p//\//_}.html"; done; }
cap ~/getshowups-backups/live-$TS-pre
# Voice today (decides step 3): every business with the receptionist on is offered voice on main.
npx wrangler d1 execute getshowups-onboarding --remote --command "SELECT customer FROM receptionist_settings WHERE enabled = 1"
```

Expected from the 14:32Z backup: `poolthru-llc`, `bob-electrical`. If the live query lists more, include them in step 3.

## 2. Migration 0030, then #80 (Studio)

```sh
npx wrangler d1 execute getshowups-onboarding --remote --file=migrations/0030_website_asset_hidden.sql   # file from the #80 branch
npx wrangler d1 execute getshowups-onboarding --remote --command "SELECT name FROM sqlite_master WHERE name LIKE 'website_asset_hidden%'"  # table + index
scripts/gh.sh pr ready 80 && scripts/gh.sh pr merge 80 --merge --match-head-commit b7a7fadba332f816de07791f8a0deabab2180efc
```

(`git show origin/feat/studio-ux-hardening:migrations/0030_website_asset_hidden.sql > /tmp/0030.sql` if main doesn't
have the file yet; apply that.) Wait for `https://getshowups.com/build.json` to show the merge commit (~45 s), then
the quick smoke (S1–S3 below).

## 3. Voice allowlist, then #81 (comms)

**Set before #81 deploys** (Pages env vars apply at the next deployment; #81's deploy picks it up). This value keeps
voice exactly where it is offered today; it changes nobody's access:

```
RECEPTIONIST_VOICE_BUSINESSES = poolthru-llc,bob-electrical      # plus any extra id from the step-1 query
```

Cloudflare dashboard → Pages → getshowups → Settings → Variables (Production) → add as plain text. (Empty/unset would
remove the voice button for both; chat unaffected.)

```sh
git fetch origin && git switch feat/comms-reliability && git pull --ff-only
git merge origin/main          # conflict: docs/STATUS.md only → keep both sections, "Comms reliability" first, no markers
git add docs/STATUS.md && git commit --no-edit && git push
scripts/gh.sh pr checks 81 --watch --fail-fast
scripts/gh.sh pr ready 81 && scripts/gh.sh pr merge 81 --merge --match-head-commit "$(git rev-parse HEAD)"
git switch main && git pull --ff-only
```

Smoke S1–S5.

## 4. #82 (enrollment notice, Help link, docs)

```sh
git switch docs/launch-readiness && git pull --ff-only && git merge origin/main   # resolve docs/STATUS.md the same way if it conflicts
git push && scripts/gh.sh pr checks 82 --watch --fail-fast
scripts/gh.sh pr ready 82 && scripts/gh.sh pr merge 82 --merge --match-head-commit "$(git rev-parse HEAD)"
git switch main && git pull --ff-only
```

Full smoke S1–S9, then the comparison in step 5.

## Smoke tests (all read-only; no booking, call, message or publish on a real business)

| # | Check | Pass |
| --- | --- | --- |
| S1 | `curl -s https://getshowups.com/build.json` | `commit` = the merge commit just made |
| S2 | `cap ~/getshowups-backups/live-$TS-post && diff -r ~/getshowups-backups/live-$TS-pre ~/getshowups-backups/live-$TS-post` | no output (byte-identical) |
| S3 | Owner sign-in (founder's own account) → /dashboard → Website → Studio photos | loads; "Used on" shown; no change made |
| S4 | `/admin/review` | 0030 applied; `receptionist.voice` = Sandbox "In testing for 2 business(es)"; no new open incidents |
| S5 | `/chat/bob-electrical` and `/chat/poolthru-llc` in a browser | voice button present (do **not** start a call); chat answers one typed question |
| S6 | `curl -s https://getshowups.com/api/enrollment` | `{"open":false}` (billing sandbox) |
| S7 | getshowups.com on desktop + phone width | Get started buttons read "Request early access" with the note; link lands on Book a call |
| S8 | `/dashboard?plan=founding` signed out | "Online enrollment isn't open yet" + Book a call; Continue with Google still present. `/dashboard` → "Welcome back" |
| S9 | `npx wrangler pages deployment tail <new id> --format json` across one cron run (≤ 5 min) | `/api/cron/run` 200; no `storage_error`, no `cron … failed` lines |

## 5. After the release

Re-run the step-1 count query (only owner activity may change counts: check `audit_log.actor_type` before attributing
a difference to the deploy). Record in docs/STATUS.md: merge commits, deployment id, backup file, smoke results.

## Rollback

| What | How | Effect |
| --- | --- | --- |
| Code (any step) | Cloudflare dashboard → Pages → getshowups → Deployments → the step-1 deployment → **Rollback** (instant). Permanent fix: revert PR (`git revert -m 1 <merge sha>`, own PR, approval) | Previous behaviour everywhere |
| Migration 0030 | **None needed.** Old code never reads `website_asset_hidden`; leave the table (dropping it would lose owners' Hide choices) | Hidden photos show in pickers again under old code |
| Voice | Edit `RECEPTIONIST_VOICE_BUSINESSES` (empty = nobody) and redeploy (env changes need a deployment: dashboard → Retry deployment) or roll back code (pre-#81 ignores the variable) | — |
| Data | Not expected (no destructive migration, no data rewrite). Restore from the step-1 backup only with separate approval | — |

## Production impact (what changes for real users)

- **Owners:** Studio photo usage/delete/hide/replace, Back/Escape behaviour, draft kept across reloads; phone-sized
  images only for sites that opt in (none today: renders identical). Help link on owner screens.
- **Visitors:** "Get started" reads "Request early access" with a note while enrollment is closed (it is today).
  Existing owners, invitations, admins and testers sign in as before.
- **Booking customers:** confirmation + owner notice dispatched right after booking (still only to
  MESSAGE_TEST_RECIPIENTS while MESSAGES_LIVE is off). Account mail queued > 23 h is closed instead of sent late.
- **Voice:** same two businesses as today (with the step-3 value); new businesses can't get voice until listed.
- **Unchanged:** billing (sandbox, signup closed), MESSAGES_LIVE/SMS_LIVE off, ads switches, Stripe, Google scopes.

## Risks

| Risk | Likelihood | Mitigation |
| --- | --- | --- |
| Voice disappears for PoolThru/bob-electrical | Only if step 3's variable is missed | Set it before merging #81; S5 checks |
| Duplicate owner notice if cron and immediate flush overlap | Low | Same outbox id = Resend Idempotency-Key (24 h); customer messages are claimed atomically |
| A renderer change reaches live sites | Very low (identical renders verified) | S2 diff right after each deploy; roll back on any diff |
| Deploy before migration | Avoided by order; harmless anyway (fails soft) | — |
| Pages env var not picked up | If set after the #81 deploy | Retry deployment |
