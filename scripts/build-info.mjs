// Writes dist/build.json after the Vite build: the commit being deployed and which tables each migration creates.
// Business Review reads it (env.ASSETS) to show the release and which migrations production still lacks. No secrets:
// the repository is public; this is the same information.
import { execSync } from 'node:child_process'
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'

let commit = process.env.CF_PAGES_COMMIT_SHA || null
if (!commit) {
  try {
    commit = execSync('git rev-parse HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
  } catch {}
}
const migrations = readdirSync('migrations')
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((file) => ({ file, tables: [...readFileSync(`migrations/${file}`, 'utf8').matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map((m) => m[1]) }))
const out = process.argv[2] || 'dist'
if (!existsSync(out)) throw new Error(`${out}/ missing: run after vite build`)
writeFileSync(`${out}/build.json`, JSON.stringify({ commit, branch: process.env.CF_PAGES_BRANCH || null, builtAt: new Date().toISOString(), migrations }))
console.log(`build.json: ${commit?.slice(0, 7) ?? 'unknown commit'}, ${migrations.length} migrations`)
