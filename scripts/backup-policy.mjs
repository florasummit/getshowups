// Lists local database exports against the 90-day rule (docs/BACKUPS.md). Read-only: it never removes anything.
import { readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export function review(files, now = Date.now(), days = 90) {
  const rows = files.map((f) => ({ name: f.name, days: Math.floor((now - f.mtime) / 86_400_000) })).sort((a, b) => b.days - a.days)
  return { over: rows.filter((r) => r.days >= days), dueIn14: rows.filter((r) => r.days >= days - 14 && r.days < days), total: rows.length }
}
if (process.argv[1]?.endsWith('backup-policy.mjs')) {
  const dir = join(homedir(), 'getshowups-backups')
  const r = review(readdirSync(dir).map((name) => ({ name, mtime: statSync(join(dir, name)).mtimeMs })))
  console.log(`${r.total} items. Past 90 days: ${r.over.length}. Due within 14 days: ${r.dueIn14.length}.`)
  for (const x of [...r.over, ...r.dueIn14]) console.log(`${x.days} days  ${x.name}`)
  console.log(`Folder open to others: ${(statSync(dir).mode & 0o077) !== 0 ? 'YES, fix with chmod 700' : 'no'}`)
}
