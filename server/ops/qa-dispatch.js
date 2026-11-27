// CI executor: starts the prepared GitHub Actions workflow `qa.yml` (docs/qa-workflow.yml → .github/workflows/qa.yml,
// owner step) with workflow_dispatch, and cancels its run. Server-only credential QA_GITHUB_DISPATCH_TOKEN (fine-grained
// token: this repository only, Actions read/write); it is never returned, logged or sent to the browser. Every call has
// an 8-second timeout. GITHUB_API_MOCK_ORIGIN is a loopback-only test variable (like the other *_MOCK_ORIGIN).
// The workflow itself runs the SAME commands as ci.yml on the selected subset and posts results back through the
// existing ingest (POST /api/qa/runs, QA_INGEST_TOKEN): nothing executes inside a web request.
export const WORKFLOW = 'qa.yml'
export const DEFAULT_REPO = 'florasummit/getshowups'
const TIMEOUT_MS = 8000
const MAX_INPUT = 20_000

export const dispatchConfigured = (env) => typeof env.QA_GITHUB_DISPATCH_TOKEN === 'string' && env.QA_GITHUB_DISPATCH_TOKEN.length >= 20
export const ingestConfigured = (env) => typeof env.QA_INGEST_TOKEN === 'string' && env.QA_INGEST_TOKEN.length >= 32
const repo = (env) => (/^[\w.-]+\/[\w.-]+$/.test(String(env.QA_GITHUB_REPO || '')) ? env.QA_GITHUB_REPO : DEFAULT_REPO)
function apiOrigin(env) {
  const m = String(env.GITHUB_API_MOCK_ORIGIN || '')
  return /^http:\/\/127\.0\.0\.1:\d{2,5}$/.test(m) ? m : 'https://api.github.com'
}
async function gh(env, path, body) {
  try {
    const res = await fetch(`${apiOrigin(env)}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.QA_GITHUB_DISPATCH_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json', 'User-Agent': 'qa-command-center' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    return { status: res.status }
  } catch (err) {
    return { status: null, error: err?.name === 'TimeoutError' ? 'timeout' : 'network' }
  }
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
// What the workflow runs for a set of inventory tests: whole files when every test of a file is selected (or the
// pattern would be too long), else a title pattern.
export function workflowInputs(executionId, tests, allTestsList, { capUsd = 0 } = {}) {
  const byFile = (kind) => {
    const sel = tests.filter((t) => t.kind === kind)
    const files = [...new Set(sel.map((t) => t.file))].sort()
    const whole = files.every((f) => allTestsList.filter((t) => t.kind === kind && t.file === f).every((t) => sel.includes(t)))
    const pattern = whole ? '' : `^(${[...new Set(sel.map((t) => (t.pattern ? t.title.split(/\$\{[^}]*\}/).map(escapeRe).join('.*') : escapeRe(t.title))))].join('|')})$`
    return { files, pattern: pattern.length > MAX_INPUT ? '' : pattern }
  }
  const unit = byFile('unit')
  const e2e = byFile('e2e')
  const allUnit = allTestsList.filter((t) => t.kind === 'unit').every((t) => tests.includes(t))
  const allE2e = allTestsList.filter((t) => t.kind === 'e2e').every((t) => tests.includes(t))
  const admin = tests.filter((t) => t.suite === 'admin_eval').map((t) => t.id.split(':').pop())
  const evals = [admin.length ? `admin_eval:${admin.join(',')}` : null, tests.some((t) => t.suite === 'receptionist_eval') ? 'receptionist_eval' : null].filter(Boolean).join(' ')
  const files = (f, all) => (all ? 'all' : f.files.join(' '))
  const inputs = {
    execution_id: executionId,
    unit_files: unit.files.length ? files(unit, allUnit) : '',
    unit_pattern: allUnit ? '' : unit.pattern,
    e2e_files: e2e.files.length ? files(e2e, allE2e) : '',
    e2e_grep: allE2e ? '' : e2e.pattern.replace(/^\^|\$$/g, ''),
    evals,
    cap_usd: String(Math.max(0, Math.round(Number(capUsd) * 100) / 100)),
  }
  for (const k of ['unit_files', 'e2e_files']) if (inputs[k].length > MAX_INPUT) inputs[k] = 'all'
  return inputs
}

// → { ok: true } | { ok: false, code: 'not_configured' | 'refused' | 'not_found' | 'unknown', status }
export async function dispatchWorkflow(env, inputs) {
  if (!dispatchConfigured(env)) return { ok: false, code: 'not_configured' }
  const r = await gh(env, `/repos/${repo(env)}/actions/workflows/${WORKFLOW}/dispatches`, { ref: env.QA_GITHUB_REF || 'main', inputs })
  if (r.status === 204 || r.status === 200) return { ok: true }
  if (r.status === null) return { ok: false, code: 'unknown', error: r.error }
  return { ok: false, code: r.status === 404 ? 'not_found' : r.status === 401 || r.status === 403 ? 'refused' : r.status === 422 ? 'invalid_inputs' : 'refused', status: r.status }
}

export async function cancelWorkflowRun(env, ghRunId) {
  if (!dispatchConfigured(env) || !/^\d{1,20}$/.test(String(ghRunId || ''))) return { ok: false, code: 'not_configured' }
  const r = await gh(env, `/repos/${repo(env)}/actions/runs/${ghRunId}/cancel`)
  return r.status === 202 || r.status === 409 ? { ok: true, alreadyDone: r.status === 409 } : { ok: false, code: r.status === null ? 'unknown' : 'refused', status: r.status }
}
export const runUrlFor = (env, ghRunId) => `https://github.com/${repo(env)}/actions/runs/${ghRunId}`
