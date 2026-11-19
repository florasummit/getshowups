# Posting CI test runs to the Control Center: recommended setup (NOT applied)

Status: proposal. Our GitHub token has no Workflows permission, and creating secrets needs approval, so nothing here is
configured. Until it is, `/api/qa/runs` answers 503 (off) and the Control Center says "No automated runs recorded".

## Principles

1. **The `verify` job stays secret-free.** It runs on every pull request, including forks, and must never see the
   token. It only writes the Playwright JSON report as an artifact.
2. **Only `main` posts.** A separate job runs on `push` to `main`, after `verify`. Pull requests never post, so a PR
   can't fake history or reach the token.
3. **The token lives in a GitHub Environment** (`qa-ingest`) whose deployment-branch rule allows `main` only. It is
   not a repository secret. Optionally, require a reviewer.
4. **The token is single-purpose.** It can only add bounded, redacted QA rows. It is rate-limited (30 per 10 min per
   IP) and replay-protected (`runKey = gh:<run id>:<attempt>`, plus a body-hash dedupe; reports older than 7 days are
   refused). It is unrelated to every other secret, and rotating it breaks nothing else.
5. **Mocked results are labelled `provider: mocked`.** The e2e suite uses fake providers; real-provider checks would
   be a separate, explicitly labelled run.

## Steps (each needs approval)

1. **Generate a token locally** (never paste it into chat, commits or files):
   `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`
2. **Store it on Cloudflare Pages (production):**
   `npx wrangler pages secret put QA_INGEST_TOKEN --project-name getshowups` (paste at the prompt). It takes effect on
   the next deployment.
3. **Store it in GitHub:** Settings → Environments → New environment `qa-ingest` → Deployment branches: `main` only.
   Add the environment secret `QA_INGEST_TOKEN` (the same value) and the environment variable
   `QA_INGEST_URL=https://getshowups.com`.
4. **Workflow change** (`.github/workflows/ci.yml`; a person with Workflows permission commits it):

```yaml
      # in jobs.verify.steps — replace the "Browser smoke tests" step and add the artifact upload
      - name: Browser smoke tests (local workerd, fake credentials, mocked Google)
        run: npx playwright test --reporter=list,html,json
        env:
          PLAYWRIGHT_JSON_OUTPUT_NAME: qa-report.json

      - name: Keep the JSON report for the Control Center
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: qa-report
          path: qa-report.json
          retention-days: 14

  qa-report:
    # Posts the run to the Control Center. main only; never on pull requests; secret only in this job.
    needs: verify
    if: always() && github.event_name == 'push' && github.ref == 'refs/heads/main' && needs.verify.result != 'cancelled'
    runs-on: ubuntu-latest
    timeout-minutes: 5
    environment: qa-ingest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@v4
      - uses: actions/download-artifact@v4
        with:
          name: qa-report
      - uses: actions/setup-node@v4
        with:
          node-version: 24
      - run: node scripts/qa-report.mjs qa-report.json --source ci --provider mocked
        env:
          QA_INGEST_URL: ${{ vars.QA_INGEST_URL }}
          QA_INGEST_TOKEN: ${{ secrets.QA_INGEST_TOKEN }}
```

5. **Verify:**
   1. Push a docs-only commit to `main` (approval).
   2. Check that the `qa-report` job logs `server answered 201`.
   3. Check that `/admin/control?view=qa` shows the run: revision, "Mocked providers", and a link to the CI run.
   4. Re-run the job and check that it logs `200 … "duplicate":true`.

## Rotation and revocation

To rotate: set a new value in both places, then redeploy Pages. To revoke immediately: delete the Pages secret and
redeploy. The endpoint then answers 503, and existing history stays.
