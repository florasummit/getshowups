// Local stand-in for Google's token endpoint and Calendar API, used only by Playwright through the
// loopback-only GOOGLE_API_MOCK_ORIGIN binding. Holds calendar events in memory.
//   Authorization codes encode the scenario:  login:<email>  |  connect:<email>
import { createServer } from 'node:http'
import { createHmac } from 'node:crypto'

// ---------- Stripe stand-in (STRIPE_API_MOCK_ORIGIN, test only) ----------
// Hosted Checkout and the billing portal are tiny HTML pages here. Paying or cancelling sends REAL
// Stripe-format events to the app's webhook, signed with the e2e webhook secret (t=…,v1=HMAC-SHA256).
const APP = `http://127.0.0.1:${process.env.E2E_PORT || 8788}`
const WHSEC = process.env.E2E_STRIPE_WEBHOOK_SECRET || ''
const stripe = { customers: new Map(), sessions: new Map(), subs: new Map(), n: 0 }
const dnsRecords = new Map()
const nextId = (p) => `${p}_e2e${++stripe.n}`
async function sendEvent(type, object, { times = 1 } = {}) {
  const event = { id: nextId('evt'), type, created: Math.floor(Date.now() / 1000), livemode: false, data: { object } }
  const raw = JSON.stringify(event)
  for (let i = 0; i < times; i++) {
    const t = Math.floor(Date.now() / 1000)
    const sig = createHmac('sha256', WHSEC).update(`${t}.${raw}`).digest('hex')
    await fetch(`${APP}/api/stripe/webhook`, { method: 'POST', headers: { 'Stripe-Signature': `t=${t},v1=${sig}`, 'Content-Type': 'application/json' }, body: raw })
  }
}
const subObject = (s) => ({
  id: s.id,
  object: 'subscription',
  customer: s.customer,
  status: s.status,
  metadata: s.metadata,
  currency: 'usd',
  cancel_at_period_end: false,
  cancel_at: s.cancel_at ?? null,
  items: { data: [{ quantity: 1, current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400, price: { id: s.price, unit_amount: 49900, recurring: { interval: 'month', interval_count: 1 } } }] },
})
const page = (res, html) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
  res.end(`<!doctype html><meta name="viewport" content="width=device-width"><title>Stripe (test)</title><body style="font-family:sans-serif;max-width:420px;margin:40px auto">${html}</body>`)
}
async function stripeMock(req, res, url, raw) {
  const form = new URLSearchParams(raw)
  const p = url.pathname
  if (p === '/v1/customers' && req.method === 'POST') {
    const key = req.headers['idempotency-key']
    const existing = [...stripe.customers.values()].find((c) => c.key === key)
    const c = existing || { id: nextId('cus'), key, metadata: { customer: form.get('metadata[customer]') } }
    stripe.customers.set(c.id, c)
    return send(res, 200, { id: c.id, object: 'customer', livemode: false })
  }
  if (p === '/v1/subscriptions' && req.method === 'GET') {
    return send(res, 200, { data: [...stripe.subs.values()].filter((s) => s.customer === url.searchParams.get('customer')).map(subObject) })
  }
  if (p === '/v1/checkout/sessions' && req.method === 'GET') {
    const open = [...stripe.sessions.values()].filter((s) => s.customer === url.searchParams.get('customer') && s.status === 'open')
    return send(res, 200, { data: open.map((s) => ({ id: s.id, url: s.url, mode: 'subscription', metadata: s.metadata, status: s.status })) })
  }
  if (p === '/v1/checkout/sessions' && req.method === 'POST') {
    const id = nextId('cs')
    const s = { id, status: 'open', customer: form.get('customer'), client_reference_id: form.get('client_reference_id'), price: form.get('line_items[0][price]'), trial: form.get('subscription_data[trial_period_days]'), metadata: { customer: form.get('metadata[customer]'), plan: form.get('metadata[plan]') }, success_url: form.get('success_url'), cancel_url: form.get('cancel_url') }
    s.url = `http://127.0.0.1:${PORT}/__stripe/checkout/${id}`
    stripe.sessions.set(id, s)
    return send(res, 200, { id, url: s.url, livemode: false })
  }
  if (p === '/v1/billing_portal/sessions' && req.method === 'POST') {
    const id = nextId('bps')
    stripe.sessions.set(id, { id, customer: form.get('customer'), return_url: form.get('return_url') })
    return send(res, 200, { id, url: `http://127.0.0.1:${PORT}/__stripe/portal/${id}` })
  }
  const co = p.match(/^\/__stripe\/checkout\/([^/]+)(\/(pay|cancel))?$/)
  if (co) {
    const s = stripe.sessions.get(co[1])
    if (!s) return send(res, 404, {})
    if (!co[3]) {
      return page(res, `<p>Test mode</p><h1>Subscribe to GetShowUps</h1><p class="amount">$499.00 per month</p><p>${s.trial ? `Trial ${s.trial} days` : 'No trial'}</p>
        <form method="post" action="/__stripe/checkout/${s.id}/pay"><label>Card number <input name="card" value=""></label><button>Subscribe</button></form>
        <form method="post" action="/__stripe/checkout/${s.id}/cancel"><button>Back</button></form>`)
    }
    if (co[3] === 'cancel') {
      res.writeHead(303, { Location: s.cancel_url })
      return res.end()
    }
    if (form.get('card') !== '4242424242424242') return page(res, '<p role="alert">Your card was declined.</p>')
    s.status = 'complete'
    const sub = { id: nextId('sub'), customer: s.customer, status: 'active', metadata: { customer: s.metadata.customer, plan: s.metadata.plan }, price: s.price }
    stripe.subs.set(sub.id, sub)
    await sendEvent('checkout.session.completed', { id: s.id, object: 'checkout.session', customer: s.customer, subscription: sub.id, client_reference_id: s.client_reference_id, metadata: s.metadata, mode: 'subscription' })
    await sendEvent('customer.subscription.created', subObject(sub), { times: 2 }) // duplicate delivery on purpose
    await sendEvent('invoice.paid', { id: nextId('in'), object: 'invoice', customer: s.customer, amount_paid: 49900, currency: 'usd', parent: { type: 'subscription_details', subscription_details: { subscription: sub.id, metadata: sub.metadata } } })
    res.writeHead(303, { Location: s.success_url })
    return res.end()
  }
  const po = p.match(/^\/__stripe\/portal\/([^/]+)(\/cancel)?$/)
  if (po) {
    const s = stripe.sessions.get(po[1])
    if (!s) return send(res, 404, {})
    const sub = [...stripe.subs.values()].find((x) => x.customer === s.customer)
    if (!po[2]) return page(res, `<p>Test mode</p><h1>Billing</h1><p>GetShowUps $499.00 per month</p><p>${sub?.cancel_at ? 'Cancels at period end' : 'Active'}</p><form method="post" action="/__stripe/portal/${s.id}/cancel"><button>Cancel subscription</button></form><a href="${s.return_url}">Return</a>`)
    sub.cancel_at = Math.floor(Date.now() / 1000) + 30 * 86400 // current API: portal sets cancel_at
    await sendEvent('customer.subscription.updated', subObject(sub))
    res.writeHead(303, { Location: s.return_url })
    return res.end()
  }
  return null
}

const PORT = Number(process.env.E2E_GOOGLE_MOCK_PORT || 8790)
const CLIENT_ID = process.env.E2E_GOOGLE_CLIENT_ID
const SCOPE = 'openid email https://www.googleapis.com/auth/calendar.events.owned https://www.googleapis.com/auth/calendar.freebusy'
let events = []

const idToken = (email) =>
  `h.${Buffer.from(JSON.stringify({ iss: 'https://accounts.google.com', aud: CLIENT_ID, sub: `sub-${email}`, email, email_verified: true })).toString('base64url')}.sig`

// ---------- Google Ads stand-in (GOOGLE_ADS_API_MOCK_ORIGIN, test only; MOCK DATA) ----------
const ADS_ACCOUNTS = {
  1234567890: { name: 'MOCK Google Ads test account', manager: false },
  5550000000: { name: 'MOCK test manager', manager: true, clients: ['6660000000', '7770000000'] },
  6660000000: { name: 'MOCK test client', manager: false },
  // A NON-test account under the manager: never offered while ads are in testing (sandbox).
  7770000000: { name: 'MOCK non-test account', manager: false, test: false },
}
const adsCampaigns = new Map() // account id → [{ id, name, status, budget, amountMicros }]
let adsNextId = 900000001
// Our Cloud project has Google Ads TEST access only: Google lists a real account but refuses every
// request to it (CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION), as the real API does.
const PROD_REFUSAL = { error: { code: 403, status: 'PERMISSION_DENIED', message: 'mock', details: [{ '@type': 'type.googleapis.com/google.ads.googleads.v26.errors.GoogleAdsFailure', errors: [{ errorCode: { authorizationError: 'CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION' }, message: 'mock' }] }] } }
function adsRoute(path, raw, auth = '') {
  if (String(auth).includes('mock-ads-prod-access') && path.startsWith('/v26/')) {
    return path === '/v26/customers:listAccessibleCustomers' ? [200, { resourceNames: ['customers/9220000000'] }] : [403, PROD_REFUSAL]
  }
  if (path === '/v26/customers:listAccessibleCustomers') return [200, { resourceNames: ['customers/1234567890', 'customers/5550000000'] }]
  if (path === '/v26/geoTargetConstants:suggest') {
    const names = JSON.parse(raw || '{}').locationNames?.names || []
    return [200, { geoTargetConstantSuggestions: names.map((n, i) => ({ searchTerm: n, geoTargetConstant: { resourceName: `geoTargetConstants/90${i}`, targetType: 'Postal Code' } })) }]
  }
  const m = path.match(/^\/v26\/customers\/(\d{10})\/(googleAds:search|googleAds:searchStream|googleAds:mutate|campaigns:mutate|campaignBudgets:mutate)$/)
  if (!m) return null
  const [, acct, op] = m
  const list = adsCampaigns.get(acct) || []
  adsCampaigns.set(acct, list)
  const body = JSON.parse(raw || '{}')
  const row = (c) => ({ campaign: { resourceName: `customers/${acct}/campaigns/${c.id}`, id: c.id, name: c.name, status: c.status, campaignBudget: c.budget }, campaignBudget: { amountMicros: c.amountMicros }, metrics: {} })
  if (op === 'googleAds:search') {
    const q = body.query || ''
    const a = ADS_ACCOUNTS[acct]
    if (q.includes('FROM customer ')) return [200, { results: a ? [{ customer: { id: acct, descriptiveName: a.name, currencyCode: 'USD', testAccount: a.test !== false, manager: a.manager } }] : [] }]
    if (q.includes('FROM customer_client')) {
      // Account hierarchy: the account itself plus (for a manager) its clients.
      const client = (id) => ({ customerClient: { id, descriptiveName: ADS_ACCOUNTS[id].name, currencyCode: 'USD', manager: ADS_ACCOUNTS[id].manager, testAccount: ADS_ACCOUNTS[id].test !== false } })
      return [200, { results: a ? [acct, ...(a.clients || [])].map(client) : [] }]
    }
    const name = q.match(/campaign\.name = '((?:[^'\\]|\\.)*)'/)?.[1]?.replace(/\\(.)/g, '$1')
    return [200, { results: list.filter((c) => c.name === name).map(row) }]
  }
  if (op === 'googleAds:searchStream') return [200, [{ results: list.map(row) }]]
  if (op === 'googleAds:mutate') {
    if (body.validateOnly) return [200, {}]
    const ops = body.mutateOperations || []
    const budget = ops.find((o) => o.campaignBudgetOperation)?.campaignBudgetOperation.create
    const camp = ops.find((o) => o.campaignOperation)?.campaignOperation.create
    const id = String(adsNextId++)
    const budgetRn = `customers/${acct}/campaignBudgets/${id}`
    list.push({ id, name: camp.name, status: camp.status, budget: budgetRn, amountMicros: budget.amountMicros })
    return [200, { mutateOperationResponses: [{ campaignBudgetResult: { resourceName: budgetRn } }, { campaignResult: { resourceName: `customers/${acct}/campaigns/${id}` } }, { adGroupResult: { resourceName: `customers/${acct}/adGroups/${id}` } }, { adGroupAdResult: { resourceName: `customers/${acct}/adGroupAds/${id}~1` } }] }]
  }
  const u = body.operations?.[0]?.update || {}
  if (op === 'campaigns:mutate') {
    const c = list.find((x) => `customers/${acct}/campaigns/${x.id}` === u.resourceName)
    if (!c) return [404, { error: { code: 404, status: 'NOT_FOUND' } }]
    c.status = u.status
    return [200, { results: [{ resourceName: u.resourceName }] }]
  }
  const c = list.find((x) => x.budget === u.resourceName)
  if (!c) return [404, { error: { code: 404, status: 'NOT_FOUND' } }]
  c.amountMicros = u.amountMicros
  return [200, { results: [{ resourceName: u.resourceName }] }]
}

const send = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(body === undefined ? '' : JSON.stringify(body))
}

createServer(async (req, res) => {
  let raw = ''
  for await (const chunk of req) raw += chunk
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`)

  if (url.pathname === '/__health') return send(res, 200, { ok: true })
  if (url.pathname === '/__events') return send(res, 200, events)
  // Workers AI stand-in (AI_API_MOCK_ORIGIN): deterministic website copy built from the facts it is given.
  // The about text deliberately contains an unapproved claim, so the app's filter must drop it.
  if (url.pathname.startsWith('/ai/run/') && req.method === 'POST') {
    const prompt = JSON.parse(raw).messages.at(-1).content
    const facts = JSON.parse(prompt.match(/Facts \(JSON\):\n(\{.*\})/)[1])
    const revision = prompt.includes("Owner's request")
    const first = String(facts.services[0] || facts.whatTheyDo || 'Service').split(' (')[0]
    return send(res, 200, {
      response: {
        headline: `${facts.brandName}: dependable ${first.toLowerCase()} near you`,
        intro: `${facts.businessName} makes it easy to get ${first.toLowerCase()} on your schedule. Booking online takes about a minute.`,
        about: 'We are the best in town, satisfaction guaranteed.',
        services: facts.services.map((s) => ({ name: String(s).split(' (')[0], description: `What is included with ${String(s).split(' (')[0].toLowerCase()}, explained simply.` })),
        seoTitle: `${facts.businessName} | ${first}`,
        seoDescription: `Book ${first.toLowerCase()} with ${facts.businessName} online.`,
        ...(revision
          ? { headline: `Modern ${first.toLowerCase()} near you`, design: { name: 'Modern', palette: 'midnight', fonts: 'strong', hero: 'immersive', services: 'rows', about: 'statement', shape: 'sharp', sections: ['services', 'about', 'process'], heroImage: 'none', aboutImage: 'none' } }
          : {}),
      },
      usage: { prompt_tokens: 450, completion_tokens: 250 },
    })
  }
  // DNS-over-HTTPS stand-in (DNS_API_MOCK_ORIGIN): records set by tests via /__dns; empty otherwise.
  if (url.pathname === '/dns-query') {
    const type = url.searchParams.get('type')
    const values = dnsRecords.get(`${type}:${url.searchParams.get('name')}`) || []
    return send(res, 200, { Status: 0, Answer: values.map((data) => ({ type: type === 'TXT' ? 16 : 5, data: type === 'TXT' ? `"${data}"` : `${data}.` })) })
  }
  if (url.pathname === '/__dns' && req.method === 'POST') {
    const body = JSON.parse(raw)
    dnsRecords.set(`${body.type}:${body.name}`, body.values)
    return send(res, 200, { ok: true })
  }
  if (url.pathname.startsWith('/v1/') || url.pathname.startsWith('/__stripe/')) {
    if ((await stripeMock(req, res, url, raw)) !== null || res.writableEnded) return
  }

  if (url.pathname === '/token' && req.method === 'POST') {
    const p = new URLSearchParams(raw)
    // One calendar per connected Google account: the access token is derived from the refresh token.
    // A Google sign-in that reaches only REAL (production) Google Ads accounts keeps a recognisable token.
    if (p.get('grant_type') === 'refresh_token' && String(p.get('refresh_token')).startsWith('mock-ads-prod-')) return send(res, 200, { access_token: 'mock-ads-prod-access', expires_in: 3600, scope: 'https://www.googleapis.com/auth/adwords' })
    if (p.get('grant_type') === 'refresh_token') return send(res, 200, { access_token: `mock-access-${createHmac('sha256', 'cal').update(String(p.get('refresh_token'))).digest('hex').slice(0, 16)}`, expires_in: 3600, scope: SCOPE })
    const [kind, email] = String(p.get('code')).split(':')
    if (kind === 'login') return send(res, 200, { access_token: 'mock-login', id_token: idToken(email), scope: 'openid email' })
    if (kind === 'connect') return send(res, 200, { access_token: 'mock-access-token', refresh_token: `mock-refresh-${email}`, id_token: idToken(email), scope: SCOPE })
    if (kind === 'ads-prod') return send(res, 200, { access_token: 'mock-ads-prod-access', refresh_token: `mock-ads-prod-refresh-${email}`, scope: 'https://www.googleapis.com/auth/adwords' })
    if (kind === 'ads') return send(res, 200, { access_token: 'mock-ads-access', refresh_token: `mock-ads-refresh-${email}`, scope: 'https://www.googleapis.com/auth/adwords' })
    return send(res, 400, { error: 'invalid_grant' })
  }

  // Google Ads API stand-in (GOOGLE_ADS_API_MOCK_ORIGIN). MOCK DATA, never shown as real results: the
  // signed-in Google user reaches a MOCK test client (123-456-7890) directly and a MOCK test manager
  // (555-000-0000) with one client (666-000-0000). Campaigns live in memory per account; no metrics.
  const ads = adsRoute(url.pathname, raw, req.headers.authorization)
  if (ads) return send(res, ads[0], ads[1])

  if (url.pathname === '/calendar/v3/freeBusy' && req.method === 'POST') {
    const owner = req.headers.authorization
    return send(res, 200, { calendars: { primary: { busy: events.filter((e) => e.owner === owner).map((e) => ({ start: e.start.dateTime, end: e.end.dateTime })) } } })
  }

  if (url.pathname === '/calendar/v3/calendars/primary/events' && req.method === 'POST') {
    const body = JSON.parse(raw)
    if (body.id && events.some((e) => e.id === body.id)) return send(res, 409, { error: { status: 'ALREADY_EXISTS' } })
    const event = { id: body.id || `mock-event-${events.length + 1}`, ...body, owner: req.headers.authorization }
    events.push(event)
    return send(res, 200, { id: event.id })
  }

  const del = url.pathname.match(/^\/calendar\/v3\/calendars\/primary\/events\/(.+)$/)
  if (del && req.method === 'DELETE') {
    events = events.filter((e) => e.id !== decodeURIComponent(del[1]))
    return send(res, 204)
  }

  send(res, 404, { error: { status: 'NOT_FOUND' } })
}).listen(PORT, '127.0.0.1')
