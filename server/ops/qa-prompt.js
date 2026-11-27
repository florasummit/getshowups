// A copyable engineering task / Claude Code prompt from an item's RECORDED evidence (deterministic template, no model).
// Only what is stored goes in: the item's fields, its linked tests (with the exact command to run each), their latest
// results, and redacted evidence excerpts. Nothing is inferred; missing parts say so.
import { getTest } from './qa-tests.js'
import { workflowCommand as cmd } from './qa-commands.js'

export function itemPrompt(item, { results = [], evidence = [] } = {}) {
  const tests = item.testIds.map((id) => ({ id, t: getTest(id), last: results.find((r) => r.testId === id) || null }))
  const L = []
  L.push(`${item.group === 'defects' ? 'Fix this GetShowUps defect' : 'Implement this GetShowUps improvement (approved by the founder before any work starts)'}: ${item.title}`)
  L.push('')
  L.push(`Kind: ${item.kind}${item.severity ? ` · severity ${item.severity}` : ''}${item.priority ? ` · priority ${item.priority}` : ''}${item.area ? ` · area ${item.area}` : ''}${item.feature ? ` · feature ${item.feature}` : ''}`)
  if (item.customerImpact) L.push(`Customer impact: ${item.customerImpact}`)
  if (item.description) L.push('', 'Description:', item.description)
  L.push('', `Expected: ${item.expected || '(not recorded)'}`, `Actual: ${item.actual || '(not recorded)'}`)
  if (item.steps) L.push('', 'Steps to reproduce:', item.steps)
  L.push('', 'Tests:')
  if (!tests.length) L.push('- none linked: add a test that fails before the fix and passes after it.')
  for (const { id, t, last } of tests) {
    L.push(`- ${t ? t.title : id} (${id})${last ? ` — latest: ${last.status} on ${last.environment} ${last.revision ? last.revision.slice(0, 7) : ''} at ${new Date(last.at).toISOString()}` : ' — no result recorded'}`)
    if (last?.actual) L.push(`  output: ${last.actual}`)
    const c = cmd(t)
    if (c) L.push(`  run: ${c}`)
  }
  const ex = evidence.filter((e) => e.text).slice(0, 5)
  if (ex.length) {
    L.push('', 'Evidence (redacted excerpts):')
    for (const e of ex) L.push(`- [${e.kind}${e.kind === 'ai_assessment' ? ', AI opinion, not verified' : ''}] ${e.text.slice(0, 600).replace(/\n/g, ' ')}`)
  }
  const shots = evidence.filter((e) => e.kind === 'screenshot' && !e.purged).length
  if (shots) L.push(`- ${shots} screenshot(s) in the QA Command Center (item ${item.id}).`)
  if (item.refs?.pr || item.refs?.commit) L.push('', `Earlier fix reference: ${item.refs.pr ? `PR #${item.refs.pr}` : ''}${item.refs.commit ? ` commit ${item.refs.commit}` : ''}`)
  L.push('', 'Acceptance:', '- Follow CLAUDE.md (security rules, conventions, definition of done).', `- ${tests.length ? 'Every test above passes' : 'A new test reproduces it and passes after the fix'}; npm run verify passes with zero warnings.`, `- Then mark the item “Fixed, waiting for QA” with the PR in the QA Command Center; it becomes Verified only when the linked tests pass again after the fix.`)
  return { prompt: L.join('\n'), basedOn: { results: results.length, evidence: evidence.length, tests: tests.length } }
}
