// How to run one inventory test by hand (shown on the test page and in generated prompts). Browser tests and paid
// evaluations run in CI from the QA Command Center; the command is for reference.
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
export function workflowCommand(t) {
  if (!t) return null
  if (t.kind === 'unit') return `node --test --test-name-pattern=${JSON.stringify(`^${t.pattern ? t.title.split(/\$\{[^}]*\}/).map(esc).join('.*') : esc(t.title)}$`)} ${t.file}`
  if (t.kind === 'e2e') return `npx playwright test ${t.file} --grep ${JSON.stringify(esc(t.title))}${t.mobile ? ' --project mobile' : ' --project desktop'}   (runs in CI: QA → Run)`
  if (t.kind === 'eval' && t.suite === 'admin_eval') return `node scripts/admin-assistant-eval.mjs run --provider claude --only ${t.id.split(':').pop()} --qa-json <file>   (paid: QA budget)`
  if (t.kind === 'eval') return `node scripts/receptionist-eval.mjs --real --yes-spend   (paid: QA budget)`
  if (t.kind === 'production') return 'QA → Verify current production deployment'
  return 'QA → Manual: record the guided step'
}
