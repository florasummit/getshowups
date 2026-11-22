// Voice Lab provider readiness (server/voice/providers.js providerReadiness / labSettings): the owner's questions
// answered from configuration only, missing settings by NAME only, no provider call; a per-session OpenAI voice is
// allowlisted, stored on the Lab conversation and used when the client secret is minted.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { providerReadiness, labSettings, OPENAI_VOICES, PROVIDERS } from '../server/voice/providers.js'
import { mintClientSecret } from '../server/voice/openai.js'

const SECRET = 'sk-proj-SECRETVALUE0123456789'
test('readiness: nothing configured → every provider built, not configured (names of the missing settings), cannot run; no secret values anywhere', () => {
  const r = providerReadiness({})
  assert.deepEqual(r.map((x) => x.id), PROVIDERS)
  for (const x of r) {
    assert.equal(x.integration.built, true)
    assert.equal(x.credentials.configured, false)
    assert.ok(x.credentials.missing.length > 0)
    assert.equal(x.session.canRun, false)
    assert.ok(x.blockers.some((b) => /VOICE_LAB_ENABLED/.test(b)) && x.blockers.some((b) => /Not configured/.test(b)))
    assert.deepEqual(x.records, { transcripts: true, latency: true, toolOutcomes: true })
    assert.ok(typeof x.smallestTest === 'string' && /dry-run session/.test(x.smallestTest))
  }
  assert.deepEqual(r.find((x) => x.id === 'elevenlabs').credentials.missing, ['ELEVENLABS_API_KEY', 'ELEVENLABS_AGENT_ID'])
  assert.equal(r.find((x) => x.id === 'retell').cost.perMinuteMicros, null)
  assert.equal(r.find((x) => x.id === 'openai').cost.perMinuteMicros, 80_000)
})
test('readiness: Lab on + Retell configured → Retell can run now, the others say what is missing; OpenAI with a key can run', () => {
  const env = { VOICE_LAB_ENABLED: 'true', RETELL_API_KEY: 'retell_SECRET_0123456789', RETELL_AGENT_ID: 'agent_abc123def', RETELL_WS_SECRET: 'w'.repeat(40), ELEVENLABS_API_KEY: 'el_SECRET_0123456789abcdef' }
  const r = providerReadiness(env)
  const by = Object.fromEntries(r.map((x) => [x.id, x]))
  assert.deepEqual([by.retell.session.canRun, by.retell.blockers], [true, []])
  assert.deepEqual([by.openai.session.canRun, by.openai.credentials.missing], [false, ['OPENAI_API_KEY']])
  assert.deepEqual([by.elevenlabs.session.canRun, by.elevenlabs.credentials.missing], [false, ['ELEVENLABS_AGENT_ID']])
  assert.equal(providerReadiness({ ...env, OPENAI_API_KEY: SECRET }).find((x) => x.id === 'openai').session.canRun, true)
  const text = JSON.stringify(providerReadiness({ ...env, OPENAI_API_KEY: SECRET }))
  assert.ok(!text.includes(SECRET) && !text.includes('retell_SECRET') && !text.includes('el_SECRET'))
})
test('per-session settings: only an allowlisted OpenAI voice is kept; other providers keep a well-formed candidate id for the catalog check; the minted session carries it', async () => {
  assert.deepEqual(labSettings('openai', { voice: 'cedar', model: 'gpt-x' }), { voice: 'cedar' })
  assert.deepEqual(labSettings('openai', { voice: 'nope' }), {})
  // Retell / ElevenLabs: a well-formed candidate voice id is kept here; startLabSession checks it against the catalog.
  assert.deepEqual(labSettings('retell', { voice: 'retell-Cimo' }), { voice: 'retell-Cimo' })
  assert.deepEqual(labSettings('elevenlabs', { voice: 'bad id!' }), {})
  assert.ok(OPENAI_VOICES.includes('marin') && OPENAI_VOICES.length === 10)
  const sent = []
  const fakeFetch = async (url, init) => {
    sent.push(JSON.parse(init.body))
    return new Response(JSON.stringify({ value: 'ek_short_lived', expires_at: Math.floor(Date.now() / 1000) + 60, session: {} }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
  const env = { OPENAI_API_KEY: SECRET }
  const a = await mintClientSecret(env, { instructions: 'x', voice: 'cedar' }, fakeFetch)
  assert.equal(a.ok, true)
  assert.equal(sent[0].session.audio.output.voice, 'cedar')
  await mintClientSecret(env, { instructions: 'x' }, fakeFetch)
  assert.equal(sent[1].session.audio.output.voice, 'marin')
  assert.ok(!JSON.stringify(a).includes(SECRET))
})
