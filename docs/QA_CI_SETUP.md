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
   - `/admin/control?view=qa` shows the run: revision, "Mocked providers", a link to the CI run, pass/fail per test.
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
