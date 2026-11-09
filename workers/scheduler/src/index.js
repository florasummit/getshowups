// Cron-triggered Worker. Holds no data access of its own: it only calls POST /api/cron/run on the
// Pages app with the shared CRON_SECRET. Logs status codes and counts only.
export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(run(env))
  },
}

async function run(env) {
  if (!env.CRON_SECRET) return console.error('scheduler: CRON_SECRET not set')
  try {
    const res = await fetch(`${env.SITE_URL}/api/cron/run`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.CRON_SECRET}` },
      signal: AbortSignal.timeout(25000),
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) console.error('scheduler: run failed:', res.status, body?.error)
    else console.log('scheduler: ok', JSON.stringify(body.messages))
  } catch (err) {
    console.error('scheduler: request failed:', err?.name)
  }
}
