import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { HELP } from '../src/content/help.js'

test('every help topic is complete, short, honest, and every place that asks for one exists', () => {
  for (const [id, t] of Object.entries(HELP)) {
    for (const f of ['title', 'what', 'why', 'example', 'next']) assert.ok(t[f]?.length > 3 && t[f].length <= 320, `${id}.${f}`)
    assert.ok(t.kind === undefined || ['measured', 'estimated'].includes(t.kind), id)
    assert.doesNotMatch(JSON.stringify(t), /guarantee|always get more|will increase|double your/i, id)
  }
  const used = new Set()
  for (const f of readdirSync('src/dashboard').filter((x) => x.endsWith('.jsx'))) for (const m of readFileSync(`src/dashboard/${f}`, 'utf8').matchAll(/(?:HelpTip id|TitleHelp help)="([a-z_]+)"/g)) used.add(m[1])
  for (const id of used) assert.ok(HELP[id], id)
})

test('opening help can never reach the network: its code makes no request', () => {
  assert.doesNotMatch(readFileSync('src/content/help.js', 'utf8'), /fetch\(|api\(/)
})
