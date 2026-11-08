# How GetShowUps features get built

One lead orchestrator (the main Claude Code session) owns every feature end to end: it plans,
integrates, and does final verification. Subagents are optional helpers, not owners.

## The loop

| Step | What happens | Output |
| --- | --- | --- |
| **PLAN** | Restate the goal; check what already exists (code, Cloudflare, GHL) before assuming | Feature card (below) |
| **DECOMPOSE** | Split into slices that each ship and test on their own; order by dependency | Ordered slice list |
| **DELEGATE** | Only when it saves real time: read-only research/exploration in parallel, or independent files with no shared edits. Never two agents editing the same file | Subagent briefs |
| **BUILD** | Smallest implementation that meets the criteria; follow CLAUDE.md conventions | Code + tests |
| **TEST** | `npm run verify` after each slice; `npm run verify:all` at the end | Green run |
| **FIX** | Diagnose root cause from the first failure; fix code, not tests (unless the test is wrong, and say so) | Green run |
| **VERIFY** | Re-read the diff; check security rules; separate mocked results from live checks | Verified diff |
| **DELIVER** | Summary + approval request; update docs/STATUS.md | Approval gate |

## Feature card template

Copy into docs/STATUS.md under "In progress" when starting a feature.

```md
### <Feature name>
- Goal: <one sentence, user-visible outcome>
- Acceptance criteria:
  - [ ] <observable behaviour 1>
  - [ ] <observable behaviour 2>
  - [ ] Tests: <unit cases> / <Playwright flow>
- Depends on: <bindings, migrations, external services, approvals>
- Smallest viable implementation: <files/routes; what is explicitly NOT built yet>
- Live verification needed: <what can only be proven in production, and who approves it>
```

## When to use subagents

Use them when a task has **independent, parallel** parts and the result is a conclusion you can check:
- `Explore` to map unfamiliar code or search widely.
- `web-fetch` to read vendor docs (Google, Cloudflare, GHL) instead of answering from memory.
- A worktree-isolated agent for a self-contained slice that touches files nobody else is editing.

Do **not** use them for small edits, sequential work, or anything touching security-critical files
in parallel (`server/google-oauth.js`, `functions/api/**`). The orchestrator integrates and runs `verify:all`.

## Database migrations

1. Add `migrations/NNNN_description.sql` (idempotent: `IF NOT EXISTS`).
2. `test/e2e/serve.sh` applies every file in `migrations/` in order; unit tests load the migration files they need by name.
3. Production (needs approval):
   `npx wrangler d1 execute <prod-db-name> --remote --file=migrations/NNNN_description.sql`
   then verify with a read-only `SELECT … FROM sqlite_master`.

## Release path

`npm run verify:all` → human approves → commit to `main` (or PR) → GitHub Actions CI →
Cloudflare Pages builds and deploys automatically → live check (e.g. `/api/admin/google-health`) when approved.
Pull requests also get a Cloudflare **preview** URL; it has no secrets/bindings, so it is safe for UI review
but backend routes return 503 there.
