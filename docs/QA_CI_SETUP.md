# Posting CI test runs to the Control Center (prepared, NOT applied)

Status: prepared. Nothing is configured: `/api/qa/runs` answers 503 (off) and the Control Center says "No automated
runs recorded". Every step below needs approval. Our GitHub token has no Workflows, Secrets or Administration
permission, so the GitHub steps are done by the owner in the browser.

## What is already in the code (this PR)

- `playwright.config.js` writes `qa-report.json` in CI (JSON reporter next to list + html). Locally nothing changes.
- `docs/ci-with-qa-report.yml`: the complete proposed `.github/workflows/ci.yml`. It is the current file plus two
  additions:
  - an artifact upload in `verify` (main pushes only);
  - a separate `qa-report` job.
- `scripts/qa-ingest-token.sh`: generates the token and stores it in both places without printing it. The default
  run is a dry plan; `--apply` changes things.

## Security model

1. **`verify` never sees the token.** It runs on every pull request, including forks, exactly as today. It has no
   secrets and only uploads the JSON report, and only on pushes to `main`.
2. **Only the `qa-report` job sees the token, and only on pushes to `main`.**
   - It runs after `verify` (`needs: verify`, condition `github.event_name == 'push' && github.ref == 'refs/heads/main'`).
   - It is never triggered by `pull_request`. There is no `pull_request_target` and no `workflow_run`.
   - Fork PRs get no secrets from GitHub in any case, and this job doesn't run for them.
3. **The token is an environment secret, not a repository secret.**
   - It lives in the environment `qa-ingest`, whose deployment-branch rule allows `main` only.
   - Even a workflow edited on another branch can't read it: GitHub refuses the environment for that ref.
4. **The token job runs only our script, at a pinned version.**
   - It installs nothing (no `npm ci`) and runs only `scripts/qa-report.mjs` (Node built-ins only) from the pushed
     `main` commit.
   - Third-party actions in that job are pinned to full commit SHAs, and checkout does not keep git credentials.
5. **The token is single-purpose.** It can only add bounded, redacted QA rows, and the server refuses:
   - more than 30 requests per 10 minutes per IP;
   - replays: `runKey = gh:<run id>:<attempt>`, plus a body-hash dedupe;
   - reports older than 7 days;
   - bodies over 2 MB.

   The token is unrelated to every other secret, and rotating it breaks nothing else.
6. **Results are labelled `provider: mocked`**, since the e2e suite uses fake providers.

A run is posted whether the tests pass or fail. If the browser tests never ran (an earlier step failed), the job
finds no report and posts nothing.

## Steps (each needs approval)

1. **GitHub environment** (owner, browser):
   1. Settings → Environments → New environment `qa-ingest`.
   2. Deployment branches and tags: **Selected branches** → add `main`.
   3. Environment variable `QA_INGEST_URL` = `https://getshowups.com`.
   4. No required reviewers: that would pause every push to main.
2. **Token** (owner runs it, or approves me running it):
   1. Run `scripts/qa-ingest-token.sh --apply`.
   2. It stores the Pages secret, then puts the same value on the clipboard.
   3. Paste it as the `qa-ingest` environment secret `QA_INGEST_TOKEN` and press Enter; the clipboard is cleared.
3. **Redeploy Pages** so the secret takes effect: merge any approved PR, e.g. the docs PR.
   - Check: `curl -s -X POST https://getshowups.com/api/qa/runs` answers **401** `unauthorized` (it was 503).
   - No data is written by this check.
4. **Workflow** (owner, Workflows permission):
   1. `cp docs/ci-with-qa-report.yml .github/workflows/ci.yml`, then delete the first three comment lines.
   2. Commit on a branch and open a PR. That PR's CI must not show a `qa-report` job (it is pull_request).
   3. Merge it.
5. **Verify on the merge push:**
   - The `qa-report` job logs `server answered 201`.
   - `/admin/control?view=qa&tab=runs` shows the run: revision, "Mocked providers", a link to the CI run, pass/fail per test.
   - Re-run the job: it logs `200 … "duplicate":true`, and no second run appears.

## Expected impact

- Production: one `qa_runs` row plus ≤ ~170 `qa_results` rows per main push.
- Retention: automated runs are purged after 90 days by the cron.
- No customer data. No effect on customer sites, messaging or billing.

## Rollback, rotation, revocation

- **Stop posting, keep the token:** remove the `qa-report` job, or delete the environment secret.
- **Revoke:**
  1. Run `npx wrangler pages secret delete QA_INGEST_TOKEN --project-name getshowups`.
  2. Redeploy. The endpoint answers 503 again, and history stays.
- **Rotate:** run `scripts/qa-ingest-token.sh --apply` again (both places get the new value), then redeploy. Runs
  in the meantime are refused with 401 and the job fails visibly; it is never silently lost.

# QA Command Center: starting runs from the console (prepared, NOT applied)

What works with no new credentials, once migration 0051 is applied:

- The inventory, per-test status, defects, backlog, guided manual QA and the report import (Admin → QA).
- **Production verification** (read-only checks run by the existing five-minute cron, queued automatically for every
  new deployment and on "Verify current production deployment"). It sends real GET requests (User-Agent GetShowUps-QA,
  5-second timeout) to the production origin (optional variable `QA_PRODUCTION_ORIGIN`, default the site origin), so
  routing, middleware headers and the deployed build.json are checked through the edge; only an admin-marked test
  business's public pages are requested (never PoolThru or getshowups, never a times lookup). Its only side effect is
  rate-limit counter rows (counted on the execution). If the origin can't be reached from the Function, the checks run
  in process instead and are labelled "in-process, not through the edge" (never counted as verified). Write refusals
  (POST) always run in process, labelled the same way.

What the steps below add: "Run" buttons for CI suites (all safe tests, smoke, a flow, one test, failed/stale tests) and,
optionally, paid evaluations. Until both tokens exist the console says which step is missing and refuses the run
(a run is never queued forever). Each step needs approval.

## What is already in the code

- `docs/qa-workflow.yml`: the proposed `.github/workflows/qa.yml` (workflow_dispatch only; never pull requests or
  pushes). Jobs: `started` and `report` (environment `qa-ingest`, Node built-ins only, post through the existing
  ingest), `run` (no secrets: npm ci + the selected node:test files/titles and Playwright specs/titles, mocked
  providers), `evals` (only when paid evaluations were dispatched; environment `qa-paid`). Inputs arrive as environment
  variables and are validated before use (no input is interpolated into shell code).
- `docs/ci-with-qa-report.yml` now also posts unit results (`scripts/qa-node-reporter.mjs` → `qa-unit.json`) and the
  build's change-impact hashes (`dist/qa-hashes.json`, written by `npm run build`).
- Server side: `server/ops/qa-dispatch.js` (GitHub REST `POST /repos/{owner}/{repo}/actions/workflows/qa.yml/dispatches`
  and run cancel; 8-second timeout; the token is server-only), `server/ops/qa-executions.js` (≤ 3 attempts for a run that
  never started; paid runs whose dispatch outcome is unknown are never re-sent; silent runs expire after 90 minutes).

## Steps (each needs approval)

6. **Dispatch token** (owner, GitHub → Settings → Developer settings → Fine-grained tokens):
   1. Resource owner: the account that owns the repository; Repository access: **Only select repositories** → this
      repository.
   2. Permissions: **Actions: Read and write** (Metadata: read is added automatically). Nothing else.
   3. Store it only as a Cloudflare secret (never in GitHub, a file or the browser):
      `npx wrangler pages secret put QA_GITHUB_DISPATCH_TOKEN --project-name getshowups` (paste when asked).
   4. Redeploy (merge any approved PR). The console's setup checklist loses the "dispatch token" line.
7. **Workflow** (owner, Workflows permission):
   1. `cp docs/qa-workflow.yml .github/workflows/qa.yml`, delete the first three comment lines, PR, merge.
   2. The `qa-ingest` environment from step 1 already allows `main` (dispatched runs use `ref: main`).
8. **Paid evaluations** (optional; spends money; separate approval):
   1. GitHub → Settings → Environments → New environment `qa-paid`, deployment branches: **Selected** → `main`; secret
      `EVAL_ANTHROPIC_API_KEY` = a dedicated Anthropic key with a workspace spend limit.
   2. Cloudflare variable `QA_PAID_EVALS` = `true` (redeploy).
   3. Admin → QA → Settings: paid evaluations on, daily and monthly QA budget (e.g. monthly 3000000 = $3). Defaults are
      0 = refused. Every paid run reserves its worst case first (server/ai-budget.js entry `qa_eval` + the monthly
      ceiling) and is settled to the cost the run reports; the workflow's `--cap-usd` stops the evaluation before it.
9. **Verify** (after 6 + 7):
   - Admin → QA → Run quick smoke tests → the execution shows dispatched → running (with the GitHub run link) →
     passed/failed with per-test results. Close the browser in between: nothing is lost.
   - Cancel a second run while it is running: GitHub shows it cancelled; the console shows Cancelled.

## Rollback

- Stop console-started runs: delete the `QA_GITHUB_DISPATCH_TOKEN` secret (runs are then refused with that reason).
- Stop paid evaluations: set `QA_PAID_EVALS` to anything but `true`, or set the QA budget to 0 (instant, no deploy).
- History stays (append-only).

## Expected cost

GitHub Actions minutes on a public repository: $0. Production checks and the cron step: within the existing Workers
plan. D1 storage: one row per changed test result (large CI reports store only failures and changed passes). Paid
evaluations only within the QA budget (admin assistant: reserved at ≈ $0.05 per scenario, the full 31-scenario suite ≈ $1.55 worst case).
