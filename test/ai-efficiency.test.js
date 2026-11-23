// Teach Your AI model use: the daily limit is asked only when the fixed patterns can't place the request, and refusing it
// falls back exactly like an unavailable model (nothing is sent).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { propose } from '../server/intelligence/teach.js'
import { defaultConfig } from '../server/intelligence/schema.js'

const records = { services: [], towns: [], zips: [] }
const draft = defaultConfig(records)
test('daily limit: asked only when the model is needed; refused → nothing is sent', async () => {
  const env = { RECEPTIONIST_ANTHROPIC_API_KEY: 'sk-ant-x' }
  const orig = globalThis.fetch
  globalThis.fetch = async () => assert.fail('no model call')
  try {
    let asked = 0
    const allowModel = async () => (asked++, false)
    assert.equal((await propose(env, 'Never quote prices.', draft, records, { allowModel })).source, 'rules')
    assert.equal(asked, 0)
    const p = await propose(env, 'Be like a lighthouse keeper in a storm.', draft, records, { allowModel })
    assert.deepEqual([asked, p.modelError, p.costMicros, p.notUnderstood.length], [1, 'model_limit', 0, 1])
  } finally {
    globalThis.fetch = orig
  }
})
