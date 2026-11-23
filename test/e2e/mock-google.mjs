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
const stripe = { customers: new Map(), sessions: new Map(), subs: new Map(), invoices: [], n: 0 }
// MOCK: the account-deletion business's subscription (seeded in D1 by serve.sh with the same ids).
stripe.customers.set('cus_E2EDEL', { id: 'cus_E2EDEL', metadata: { customer: 'e2e-delete' } })
stripe.subs.set('sub_E2EDEL', { id: 'sub_E2EDEL', customer: 'cus_E2EDEL', status: 'active', metadata: { customer: 'e2e-delete', plan: 'founding' }, price: 'price_e2e' })
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
  const one = p.match(/^\/v1\/subscriptions\/([^/]+)$/)
  if (one && (req.method === 'GET' || req.method === 'DELETE')) {
    const sub = stripe.subs.get(one[1])
    if (!sub) return send(res, 404, { error: { code: 'resource_missing', message: 'No such subscription' } })
    if (req.method === 'DELETE' && sub.status !== 'canceled') {
      sub.status = 'canceled' // canceled now (account deletion); Stripe then sends customer.subscription.deleted
      await sendEvent('customer.subscription.deleted', subObject(sub))
    }
    return send(res, 200, subObject(sub))
  }
  const cus = p.match(/^\/v1\/customers\/([^/]+)$/)
  if (cus && req.method === 'DELETE') {
    if (!stripe.customers.delete(cus[1])) return send(res, 404, { error: { code: 'resource_missing', message: 'No such customer' } })
    return send(res, 200, { id: cus[1], object: 'customer', deleted: true })
  }
  if (p === '/v1/subscriptions' && req.method === 'GET') {
    const cus = url.searchParams.get('customer')
    return send(res, 200, { data: [...stripe.subs.values()].filter((s) => !cus || s.customer === cus).map(subObject), has_more: false })
  }
  if (p === '/v1/invoices' && req.method === 'GET') {
    return send(res, 200, { data: stripe.invoices.filter((i) => i.created >= Number(url.searchParams.get('created[gte]') || 0)), has_more: false })
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
    const invoice = { id: nextId('in'), object: 'invoice', status: 'paid', created: Math.floor(Date.now() / 1000), customer: s.customer, amount_paid: 49900, currency: 'usd', parent: { type: 'subscription_details', subscription_details: { subscription: sub.id, metadata: sub.metadata } } }
    stripe.invoices.push(invoice)
    await sendEvent('invoice.paid', invoice)
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
  // An established advertiser (ads-existing sign-in): a test account that already holds campaigns of its own.
  8880000000: { name: 'MOCK established advertiser', manager: false },
}
// Campaigns that already exist in the established advertiser's account (MOCK DATA): read-only import tests.
const EXISTING = {
  8880000000: [
    {
      id: '70000000001', name: 'Pool Cleaning – Charleston', status: 'ENABLED', servingStatus: 'SERVING', channel: 'SEARCH', bidding: 'TARGET_SPEND', amountMicros: '25000000', startDate: '2026-03-01',
      locations: ['1015360', '1015362'], languages: 1, negatives: ['jobs', 'diy'], groups: [{ id: '80000000001', name: 'Weekly cleaning' }],
      keywords: [{ text: 'pool cleaning charleston', match: 'PHRASE', group: '80000000001' }, { text: 'pool service near me', match: 'PHRASE', group: '80000000001' }, { text: 'weekly pool cleaning', match: 'EXACT', group: '80000000001' }],
      ads: [{ id: '90000000001', group: '80000000001', headlines: ['Charleston Pool Cleaning', 'Weekly Pool Service', 'Book a Visit Online'], descriptions: ['Clear water every week. Pick a time that suits you.'], finalUrls: ['https://harborpool.example/book'] }],
      goals: [{ category: 'SUBMIT_LEAD_FORM', origin: 'WEBSITE' }],
      spendPerDayMicros: 21000000, clicksPerDay: 9, conversionsPerDay: 0.5,
    },
    { id: '70000000002', name: 'Service Area Leads', status: 'PAUSED', servingStatus: 'NONE', channel: 'LOCAL_SERVICES', bidding: 'MANUAL_CPA', amountMicros: '40000000', spendPerDayMicros: 0, clicksPerDay: 0, conversionsPerDay: 0 },
    { id: '70000000003', name: 'Old Spring Promo', status: 'REMOVED', channel: 'SEARCH', amountMicros: '10000000' },
  ],
}
const GEO_NAMES = { 1015360: 'Charleston, South Carolina, United States', 1015362: 'Mount Pleasant, South Carolina, United States' }
const existingRow = (acct, c) => ({
  campaign: { resourceName: `customers/${acct}/campaigns/${c.id}`, id: c.id, name: c.name, status: c.status, servingStatus: c.servingStatus, advertisingChannelType: c.channel, biddingStrategyType: c.bidding, startDate: c.startDate, networkSettings: { targetGoogleSearch: true, targetSearchNetwork: false, targetContentNetwork: false }, geoTargetTypeSetting: { positiveGeoTargetType: 'PRESENCE' } },
  campaignBudget: { amountMicros: c.amountMicros, explicitlyShared: false },
})
const ymdDaysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10)
let flakyListings = 0
const faults = { invalidGrant: new Set(), freeBusy: new Set() } // /__faults (Control Center demo)
const adsCampaigns = new Map() // account id → [{ id, name, status, budget, amountMicros }]
let adsNextId = 900000001
// Our Cloud project has Google Ads TEST access only: Google lists a real account but refuses every
// request to it (CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION), as the real API does.
const PROD_REFUSAL = { error: { code: 403, status: 'PERMISSION_DENIED', message: 'mock', details: [{ '@type': 'type.googleapis.com/google.ads.googleads.v26.errors.GoogleAdsFailure', errors: [{ errorCode: { authorizationError: 'CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION' }, message: 'mock' }] }] } }
function adsRoute(path, raw, auth = '') {
  if (String(auth).includes('mock-ads-prod-access') && path.startsWith('/v26/')) {
    return path === '/v26/customers:listAccessibleCustomers' ? [200, { resourceNames: ['customers/9220000000'] }] : [403, PROD_REFUSAL]
  }
  // ads-one: the Google sign-in reaches exactly ONE test account. ads-flaky: same, but Google's first listing
  // fails (503, plus our one retry), as a brief outage during connect would.
  // ads-none: a Google sign-in with no Google Ads account at all.
  if (path === '/v26/customers:listAccessibleCustomers' && String(auth).includes('mock-ads-none-access')) return [200, { resourceNames: [] }]
  // ads-existing: an established advertiser whose one test account already holds campaigns.
  if (path === '/v26/customers:listAccessibleCustomers' && String(auth).includes('mock-ads-existing-access')) return [200, { resourceNames: ['customers/8880000000'] }]
  if (path === '/v26/customers:listAccessibleCustomers' && /mock-ads-(one|flaky)-access/.test(String(auth))) {
    if (String(auth).includes('mock-ads-flaky-access') && flakyListings++ < 2) return [503, { error: { code: 503, status: 'UNAVAILABLE', message: 'mock' } }]
    return [200, { resourceNames: ['customers/6660000000'] }] // the MOCK test client, reached directly
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
  if (op === 'googleAds:searchStream') {
    const q = body.query || ''
    // Import of the account's own campaigns (readAccountCampaigns / fetchAccountMetrics): list, details by id set,
    // daily metrics. Our created campaigns are listed too (tagged [gsu:<id>], so GetShowUps skips them).
    const inIds = q.match(/campaign\.id IN \(([^)]*)\)/)?.[1]?.split(',').map((s) => s.trim())
    const ex = (EXISTING[acct] || []).filter((c) => c.status !== 'REMOVED')
    if (/FROM campaign WHERE campaign\.status != 'REMOVED' ORDER BY campaign\.id/.test(q)) {
      return [200, [{ results: [...ex.map((c) => existingRow(acct, c)), ...list.map((c) => ({ ...existingRow(acct, { ...c, channel: c.channel, servingStatus: c.status === 'ENABLED' ? 'SERVING' : 'NONE' }), campaignBudget: { amountMicros: c.amountMicros, explicitlyShared: false } }))] }]]
    }
    if (inIds && /segments\.date BETWEEN '(\d{4}-\d{2}-\d{2})' AND '(\d{4}-\d{2}-\d{2})'/.test(q)) {
      const [, since, until] = q.match(/segments\.date BETWEEN '(\d{4}-\d{2}-\d{2})' AND '(\d{4}-\d{2}-\d{2})'/)
      const results = []
      for (const c of ex.filter((x) => inIds.includes(x.id) && x.spendPerDayMicros)) {
        for (let n = 1; n <= 120; n++) {
          const date = ymdDaysAgo(n)
          if (date < since || date > until) continue
          results.push({ campaign: { id: c.id }, segments: { date }, metrics: { costMicros: String(c.spendPerDayMicros), impressions: String(c.clicksPerDay * 20), clicks: String(c.clicksPerDay), conversions: c.conversionsPerDay } })
        }
      }
      return [200, [{ results }]]
    }
    if (inIds && /FROM campaign_criterion/.test(q)) {
      return [200, [{ results: ex.filter((c) => inIds.includes(c.id)).flatMap((c) => [...(c.locations || []).map((g) => ({ campaign: { id: c.id }, campaignCriterion: { type: 'LOCATION', negative: false, location: { geoTargetConstant: `geoTargetConstants/${g}` } } })), ...(c.negatives || []).map((t) => ({ campaign: { id: c.id }, campaignCriterion: { type: 'KEYWORD', negative: true, keyword: { text: t } } })), ...Array.from({ length: c.languages || 0 }, () => ({ campaign: { id: c.id }, campaignCriterion: { type: 'LANGUAGE', negative: false, language: { languageConstant: 'languageConstants/1000' } } }))]) }]]
    }
    if (inIds && /FROM ad_group WHERE/.test(q)) return [200, [{ results: ex.filter((c) => inIds.includes(c.id)).flatMap((c) => (c.groups || []).map((g) => ({ campaign: { id: c.id }, adGroup: { id: g.id, name: g.name, status: 'ENABLED' } }))) }]]
    if (inIds && /FROM ad_group_criterion/.test(q)) return [200, [{ results: ex.filter((c) => inIds.includes(c.id)).flatMap((c) => (c.keywords || []).map((k) => ({ campaign: { id: c.id }, adGroup: { id: k.group }, adGroupCriterion: { keyword: { text: k.text, matchType: k.match }, status: 'ENABLED' } }))) }]]
    if (inIds && /FROM ad_group_ad/.test(q)) return [200, [{ results: ex.filter((c) => inIds.includes(c.id)).flatMap((c) => (c.ads || []).map((a) => ({ campaign: { id: c.id }, adGroup: { id: a.group }, adGroupAd: { status: 'ENABLED', policySummary: { approvalStatus: 'APPROVED' }, ad: { id: a.id, type: 'RESPONSIVE_SEARCH_AD', finalUrls: a.finalUrls, responsiveSearchAd: { headlines: a.headlines.map((text) => ({ text })), descriptions: a.descriptions.map((text) => ({ text })) } } } }))) }]]
    if (inIds && /FROM campaign_conversion_goal/.test(q)) return [200, [{ results: ex.filter((c) => inIds.includes(c.id)).flatMap((c) => (c.goals || []).map((g) => ({ campaign: { id: c.id }, campaignConversionGoal: { category: g.category, origin: g.origin, biddable: true } }))) }]]
    if (/FROM geo_target_constant/.test(q)) {
      const ids = q.match(/geo_target_constant\.id IN \(([^)]*)\)/)?.[1]?.split(',').map((s) => s.trim()) || []
      return [200, [{ results: ids.filter((g) => GEO_NAMES[g]).map((g) => ({ geoTargetConstant: { id: g, name: GEO_NAMES[g].split(',')[0], canonicalName: GEO_NAMES[g], targetType: 'City' } })) }]]
    }
    // Read-back of one created campaign (verifyCampaign).
    const byId = q.match(/WHERE campaign\.id = (\d+)/)?.[1]
    const c = byId && list.find((x) => x.id === byId)
    if (byId && !c) return [200, [{ results: [] }]]
    if (c && /FROM campaign_criterion/.test(body.query))
      return [200, [{ results: [...Array.from({ length: c.locations }, () => ({ campaignCriterion: { type: 'LOCATION', negative: false } })), ...c.negatives.map((text) => ({ campaignCriterion: { type: 'KEYWORD', negative: true, keyword: { text } } }))] }]]
    if (c && /FROM ad_group_criterion/.test(body.query)) return [200, [{ results: c.keywords.map((k) => ({ adGroup: { id: c.id }, adGroupCriterion: { keyword: k } })) }]]
    if (c && /FROM ad_group_ad/.test(body.query)) return [200, [{ results: [{ adGroup: { id: c.id }, adGroupAd: { status: 'ENABLED', ad: c.ad, policySummary: { approvalStatus: 'APPROVED' } } }] }]]
    if (c && /FROM campaign /.test(body.query))
      return [200, [{ results: [{ campaign: { id: c.id, status: c.status, advertisingChannelType: c.channel, biddingStrategyType: c.bidding, networkSettings: c.network, geoTargetTypeSetting: { positiveGeoTargetType: c.geoType } }, campaignBudget: { amountMicros: c.amountMicros } }] }]]
    return [200, [{ results: list.map(row) }]]
  }
  if (op === 'googleAds:mutate') {
    if (body.validateOnly) return [200, {}]
    const ops = body.mutateOperations || []
    const budget = ops.find((o) => o.campaignBudgetOperation)?.campaignBudgetOperation.create
    const camp = ops.find((o) => o.campaignOperation)?.campaignOperation.create
    const id = String(adsNextId++)
    const budgetRn = `customers/${acct}/campaignBudgets/${id}`
    // Keep everything that was created, so read-back queries answer like Google would (MOCK DATA).
    const crit = ops.filter((o) => o.campaignCriterionOperation).map((o) => o.campaignCriterionOperation.create)
    const kws = ops.filter((o) => o.adGroupCriterionOperation).map((o) => o.adGroupCriterionOperation.create.keyword)
    const ad = ops.find((o) => o.adGroupAdOperation)?.adGroupAdOperation.create.ad
    list.push({
      id, name: camp.name, status: camp.status, budget: budgetRn, amountMicros: budget.amountMicros,
      channel: camp.advertisingChannelType, network: camp.networkSettings, geoType: camp.geoTargetTypeSetting?.positiveGeoTargetType, bidding: camp.targetSpend ? 'TARGET_SPEND' : 'OTHER',
      locations: crit.filter((c) => c.location).length, negatives: crit.filter((c) => c.negative && c.keyword).map((c) => c.keyword.text), keywords: kws, ad,
    })
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

// Retell stand-in: the voice catalog (shape of GET /list-voices), web calls (never connected in e2e) and preview
// samples (a short silent WAV; previews are the provider's own public samples in production).
const RETELL_VOICES = [
  { voice_id: 'retell-Cimo', voice_name: 'Cimo', provider: 'elevenlabs', gender: 'male', accent: 'American', age: 'Middle Aged' },
  { voice_id: '11labs-Adrian', voice_name: 'Adrian', provider: 'elevenlabs', gender: 'male', accent: 'American', age: 'Young' },
  { voice_id: '11labs-Myra', voice_name: 'Myra', provider: 'elevenlabs', gender: 'female', accent: 'American', age: 'Young' },
  { voice_id: 'cartesia-Cleo', voice_name: 'Cleo', provider: 'cartesia', gender: 'female', accent: 'British', age: 'Middle Aged' },
]
const silentWav = () => {
  const samples = 8000 // 0.5 s at 16 kHz, 16-bit mono
  const buf = Buffer.alloc(44 + samples * 2)
  buf.write('RIFF', 0)
  buf.writeUInt32LE(36 + samples * 2, 4)
  buf.write('WAVEfmt ', 8)
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20)
  buf.writeUInt16LE(1, 22)
  buf.writeUInt32LE(16000, 24)
  buf.writeUInt32LE(32000, 28)
  buf.writeUInt16LE(2, 32)
  buf.writeUInt16LE(16, 34)
  buf.write('data', 36)
  buf.writeUInt32LE(samples * 2, 40)
  return buf
}
const send = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(body === undefined ? '' : JSON.stringify(body))
}

// ---------- Meta Marketing API stand-in (META_API_MOCK_ORIGIN, test only; MOCK DATA) ----------
// The Graph API shapes server/ads/meta.js relies on: OAuth code → short-lived token → long-lived exchange, ONE sandbox
// ad account + ONE Page (auto-selected), object creation (everything the app sends is kept and read back as Meta
// would return it), status changes, empty insights (no spend), and the Lead Ads Testing API: POST /{form}/test_leads
// creates a lead and this stand-in DELIVERS it to the app's webhook signed with the app secret, like Meta does.
const META_SECRET = process.env.E2E_META_APP_SECRET || ''
const META_SHORT = 'EAAmock-short-lived-not-a-secret'
const META_LONG = 'EAAmock-long-lived-not-a-secret'
const META_PAGE_TOKEN = 'PAGEmock-not-a-secret'
const META_ACCOUNTS = [{ id: 'act_111', name: 'MOCK Meta sandbox ad account', currency: 'USD', account_status: 1 }]
const META_PAGES = [{ id: '222', name: 'MOCK Pools Page' }]
const metaState = { seq: 500, objects: {}, leads: {}, testLeads: {} }
async function deliverMetaLead(leadgenId, pageId, formId) {
  const body = JSON.stringify({ object: 'page', entry: [{ id: pageId, time: Date.now(), changes: [{ field: 'leadgen', value: { leadgen_id: leadgenId, page_id: pageId, form_id: formId, created_time: Math.floor(Date.now() / 1000) } }] }] })
  const sig = `sha256=${createHmac('sha256', META_SECRET).update(body).digest('hex')}`
  try {
    const r = await fetch(`${APP}/api/ads/meta/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': sig }, body })
    events.push({ type: 'meta.webhook', leadgenId, status: r.status, body: await r.json().catch(() => null) })
  } catch (e) {
    events.push({ type: 'meta.webhook', leadgenId, error: String(e?.message || e).slice(0, 80) })
  }
}
function metaRoute(method, path, params) {
  const m = metaState
  if (method === 'GET' && path === '/oauth/access_token') {
    if (params.grant_type === 'fb_exchange_token') return [params.fb_exchange_token === META_SHORT || params.fb_exchange_token === META_LONG, { access_token: META_LONG, token_type: 'bearer', expires_in: 5183944 }]
    return [params.code === 'meta-ok', { access_token: META_SHORT, expires_in: 3600 }]
  }
  if (params.access_token !== META_LONG && params.access_token !== META_PAGE_TOKEN) return [false, { error: { code: 190, message: 'mock: invalid token' } }]
  if (method === 'GET' && path === '/me/adaccounts') return [true, { data: META_ACCOUNTS }]
  if (method === 'GET' && path === '/me/accounts') return [true, { data: META_PAGES }]
  const list = /^\/([\w]+)\/(campaigns|adsets|ads)$/.exec(path)
  if (method === 'GET' && list) return [true, { data: Object.values(m.objects).filter((o) => o.edge === list[2] && o.parent === list[1]) }]
  const create = /^\/(act_\d+|\d+)\/(campaigns|adsets|ads|adcreatives|adimages|leadgen_forms)$/.exec(path)
  if (method === 'POST' && create) {
    const edge = create[2]
    if (edge === 'adimages') return [true, { images: { 'upload.png': { hash: `hash${++m.seq}` } } }]
    const id = String(++m.seq)
    m.objects[id] = { id, edge, parent: edge === 'adsets' ? params.campaign_id : edge === 'ads' ? params.adset_id : create[1], ...params }
    return [true, { id }]
  }
  if (method === 'GET' && /^\/\d+\/test_leads$/.test(path)) return [true, { data: Object.values(m.testLeads).filter((l) => l.form_id === path.split('/')[1]).map((l) => ({ id: l.id })) }]
  if (method === 'POST' && /^\/\d+\/test_leads$/.test(path)) {
    const formId = path.split('/')[1]
    if (Object.values(m.testLeads).some((l) => l.form_id === formId)) return [false, { error: { code: 100, message: 'mock: a test lead already exists for this form' } }]
    const id = String(++m.seq)
    m.testLeads[id] = { id, form_id: formId }
    m.leads[id] = { id, form_id: formId, created_time: new Date().toISOString(), field_data: params.field_data }
    setTimeout(() => deliverMetaLead(id, META_PAGES[0].id, formId), 50)
    return [true, { id }]
  }
  if (method === 'DELETE' && /^\/\d+$/.test(path)) {
    const id = path.slice(1)
    const had = m.testLeads[id] || m.objects[id]
    delete m.testLeads[id]
    delete m.leads[id]
    delete m.objects[id]
    return [had, had ? { success: true } : { error: { code: 100 } }]
  }
  if (method === 'GET' && /^\/\d+$/.test(path) && m.leads[path.slice(1)]) return [true, m.leads[path.slice(1)]]
  if (method === 'GET' && /^\/\d+$/.test(path) && params.fields === 'access_token') return [true, { access_token: META_PAGE_TOKEN, id: path.slice(1) }]
  if (method === 'GET' && /^\/\d+$/.test(path) && params.fields) {
    const o = m.objects[path.slice(1)]
    if (!o) return [false, { error: { code: 100, error_subcode: 33, message: 'Unsupported get request. Object with ID does not exist' } }]
    const out = { id: o.id }
    for (const f of String(params.fields).split(',')) if (o[f] !== undefined) out[f] = o[f]
    return [true, out]
  }
  if (method === 'POST' && /^\/\d+$/.test(path)) {
    const o = m.objects[path.slice(1)]
    if (!o) return [false, { error: { code: 100 } }]
    Object.assign(o, params)
    return [true, { success: true }]
  }
  if (method === 'GET' && /^\/\d+\/insights$/.test(path)) return [true, { data: [] }]
  return [false, { error: { code: 803, message: 'mock: unknown edge' } }]
}

createServer(async (req, res) => {
  let raw = ''
  for await (const chunk of req) raw += chunk
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`)

  if (url.pathname === '/__health') return send(res, 200, { ok: true })
  if (url.pathname === '/__events') return send(res, 200, events)
  if (/^\/v\d{1,3}\.0\//.test(url.pathname)) {
    const params = req.method === 'POST' ? Object.fromEntries(new URLSearchParams(raw)) : Object.fromEntries(url.searchParams)
    for (const [k, v] of Object.entries(params)) {
      if (/^[[{]/.test(v)) {
        try {
          params[k] = JSON.parse(v)
        } catch {}
      }
    }
    const [ok, body] = metaRoute(req.method, url.pathname.replace(/^\/v\d{1,3}\.0/, ''), params)
    return send(res, ok ? 200 : 400, body)
  }
  // Workers AI stand-in (AI_API_MOCK_ORIGIN): deterministic website copy built from the facts it is given.
  // The about text deliberately contains an unapproved claim, so the app's filter must drop it.
  // Twilio stand-in (TWILIO_API_MOCK_ORIGIN): accepts texts and records them for the tests (/__events).
  const tw = url.pathname.match(/^\/2010-04-01\/Accounts\/([^/]+)\/Messages\.json$/)
  if (tw && req.method === 'POST') {
    const p = new URLSearchParams(raw)
    const sid = `SMe2e${events.length}${Date.now()}`
    events.push({ type: 'twilio.message', sid, to: p.get('To'), from: p.get('From'), body: p.get('Body') })
    return send(res, 201, { sid })
  }
  if (url.pathname.startsWith('/ai/run/') && req.method === 'POST') {
    // Follow-up assistant: a short answer that uses no numbers (the app adds the booking link).
    if (/^You answer text messages/.test(JSON.parse(raw).messages[0].content)) {
      return send(res, 200, { response: { intent: 'question', answerable: true, reply: 'Yes, we can help with that in Charleston.' }, usage: { prompt_tokens: 500, completion_tokens: 20 } })
    }
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
  if (url.pathname === '/dns-query' || url.pathname === '/resolve') {
    // Two public resolvers (Cloudflare /dns-query, Google /resolve): the same seeded records unless a test seeds a
    // resolver-specific answer (key "google:TYPE:name") to simulate a half-propagated change.
    const type = url.searchParams.get('type')
    const name = url.searchParams.get('name')
    const code = { TXT: 16, CNAME: 5, A: 1, NS: 2 }[type] || 5
    const values = (url.pathname === '/resolve' && dnsRecords.get(`google:${type}:${name}`)) || dnsRecords.get(`${type}:${name}`) || []
    return send(res, 200, { Status: 0, Answer: values.map((data) => ({ type: code, data: type === 'TXT' ? `"${data}"` : type === 'A' ? data : `${data}.` })) })
  }
  // Root-domain forwarding probe (server/domains.js apexStatus): /__apex/<scheme>/<apex>/... → what a test seeded for
  // that apex ("apex:<apex>" → { status, location }) or a plain 200.
  if (url.pathname.startsWith('/__apex/')) {
    const [, , , apex] = url.pathname.split('/')
    const f = dnsRecords.get(`apex:${apex}`)
    if (f && f.location) {
      res.writeHead(f.status || 301, { Location: f.location.replace('{path}', url.pathname.split(apex)[1] || '/').replace('{query}', url.search) })
      return res.end()
    }
    return send(res, 200, { ok: true })
  }
  // AI designer (Claude, streamed): a first design, or a darker revision when the prompt carries CURRENT_SITE.
  if (url.pathname === '/anthropic/v1/messages' && req.method === 'POST' && JSON.parse(raw).tools?.some((t) => t.name === 'find_available_times')) {
    // AI receptionist stand-in: calls the real server-side tools (availability from the mocked Google calendar,
    // hand-off), then answers from their results. Non-streaming JSON like the Messages API.
    const body = JSON.parse(raw)
    const last = body.messages.at(-1)
    const userText = [...body.messages].reverse().find((m) => m.role === 'user' && typeof m.content === 'string')?.content || ''
    const reply = (content, stop) => send(res, 200, { id: `msg_r${events.length}`, type: 'message', role: 'assistant', model: body.model, content, stop_reason: stop, stop_sequence: null, usage: { input_tokens: 900, output_tokens: 40, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } })
    const results = Array.isArray(last.content) ? last.content.filter((b) => b.type === 'tool_result').map((b) => JSON.parse(b.content)) : []
    if (results.length) {
      const times = results.find((r) => r.options)?.options
      if (times) return reply([{ type: 'text', text: times.length ? `I can do ${times[0].time}. Would that work?` : 'No open times right now.' }], 'end_turn')
      if (results.some((r) => r.recorded)) return reply([{ type: 'text', text: 'I’ve recorded your callback request for the team with your number.' }], 'end_turn')
      if (results.some((r) => r.error === 'name_needed' || r.error === 'phone_needed')) return reply([{ type: 'text', text: 'I can’t transfer you, but I can take a callback request. What’s your name and best number?' }], 'end_turn')
    }
    // "Name, phone" typed → saved, then the callback request is recorded (the real tools run on the server).
    const contact = userText.match(/^([A-Za-z]+ [A-Za-z]+),\s*([\d() .-]{10,})$/)
    if (contact) return reply([
      { type: 'tool_use', id: 'toolu_d1', name: 'save_customer_details', input: { name: contact[1], phone: contact[2], email: '', zip: '', street: '', city: '', state: '', need: '' } },
      { type: 'tool_use', id: 'toolu_h2', name: 'request_callback', input: { reason: 'Customer asked for a person.', urgent: false } },
    ], 'tool_use')
    if (/person|human/i.test(userText)) return reply([{ type: 'tool_use', id: 'toolu_h1', name: 'request_callback', input: { reason: 'Customer asked for a person.', urgent: false } }], 'tool_use')
    if (/time|available|when/i.test(userText)) return reply([{ type: 'tool_use', id: 'toolu_t1', name: 'find_available_times', input: { date: '', part_of_day: 'any' } }], 'tool_use')
    return reply([{ type: 'text', text: 'Weekly pool care is $280. Want me to find a time?' }], 'end_turn')
  }
  if (url.pathname === '/anthropic/v1/messages' && req.method === 'POST') {
    const prompt = JSON.parse(raw).messages?.[0]?.content || ''
    const revise = prompt.includes('CURRENT_SITE')
    const theme = revise
      ? { colors: { bg: '#0b1620', surface: '#13232f', ink: '#eef6f8', muted: '#a3b8c2', accent: '#5fd4d0', onAccent: '#062023', line: '#223746' }, headingFont: 'cormorant-garamond', bodyFont: 'manrope', headingWeight: 600, headingCase: 'none', headingTracking: -0.01, baseSize: 17, scale: 1.3, lineHeight: 1.6, radius: 4, density: 'airy', maxWidth: 1200, buttons: 'outline', motion: 'subtle' }
      : { colors: { bg: '#f4f8f7', surface: '#e3eeec', ink: '#10292b', muted: '#4b6466', accent: '#0f5c63', onAccent: '#ffffff', line: '#cfdedb' }, headingFont: 'syne', bodyFont: 'manrope', headingWeight: 700, headingCase: 'none', headingTracking: -0.03, baseSize: 17, scale: 1.3, lineHeight: 1.6, radius: 18, density: 'comfortable', maxWidth: 1200, buttons: 'pill', motion: 'subtle' }
    // Compact answers carry the design idea in `name` (no `direction` field in Claude's schema).
    const site = { name: revise ? 'Dark premium: serif headline, deep teal' : 'Fresh coastal: grotesk headline beside a pool photo', theme, nav: { layout: 'left', sticky: true, showBook: true }, footer: { layout: 'simple', text: null }, pages: [{ slug: '', navLabel: 'Home', seoTitle: 'Pools', seoDescription: 'Pools', sections: [
      // Claude answers in the compact section shape (server/ai-designer.js COMPACT_DESIGN_SCHEMA).
      { type: 'hero', id: 'top', style: 'bg l left normal none', eyebrow: '', layout: 'split', heading: revise ? 'Quietly perfect pools.' : 'Clear water, every week.', text: 'Pool care, booked online.', body: '', images: ['stock:pool-water'], imageAlt: '', options: 'side-right height-tall', buttons: [{ label: 'Book a visit', target: 'book' }], items: [] },
      { type: 'area', id: 'area', style: 'surface m left normal none', eyebrow: '', layout: '', heading: 'Where we work', text: '', body: '', images: [], imageAlt: '', options: '', buttons: [], items: [] },
    ] }] }
    // "Show me a different direction": a typographic composition (a different first screen, type pairing and palette).
    const blank = { eyebrow: '', heading: '', text: '', body: '', layout: '', images: [], imageAlt: '', buttons: [], items: [] }
    const away = prompt.includes('MOVE AWAY FROM') ? { name: 'Bold typographic poster: the headline is the hero', theme: { ...theme, headingFont: 'bricolage-grotesque', colors: { ...theme.colors, bg: '#ffffff' } }, nav: { layout: 'split', sticky: true, showBook: true }, footer: { layout: 'statement', text: 'Pool care, booked online.' }, pages: [{ slug: '', navLabel: 'Home', seoTitle: 'Pools', seoDescription: 'Pools', sections: [
      { type: 'composition', id: 'top', style: 'bg m left wide none', options: 'height-tall', ...blank, items: [{ serviceIndex: -1, icon: '', title: 'heading c1/10 r1/1 z0 display', text: 'Pool care, booked in a minute.', image: '' }, { serviceIndex: -1, icon: '', title: 'button c1/4 r2/1 z0 m', text: 'Book a visit', image: 'book' }] },
      { type: 'area', id: 'area', style: 'surface m left normal none', options: '', ...blank, heading: 'Where we work' },
    ] }] } : null
    const text = JSON.stringify(away ? { reply: 'A bold typographic direction.', site: away } : { reply: revise ? 'Darker and more premium, with a serif headline.' : 'A fresh coastal design with booking up front.', site })
    const ev = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    return res.end(ev('message_start', { message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } }) + ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }) + ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text } }) + ev('content_block_stop', { index: 0 }) + ev('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 900 } }) + ev('message_stop', {}))
  }
  // Own-key AI providers (AI_API_MOCK_ORIGIN): key check only; a key containing BAD is refused.
  if (url.pathname === '/list-voices') return send(res, 200, RETELL_VOICES.map((v) => ({ ...v, preview_audio_url: `http://127.0.0.1:${PORT}/retell-preview/${v.voice_id}.wav` })))
  if (url.pathname.startsWith('/retell-preview/')) {
    const wav = silentWav()
    res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': wav.length, 'Access-Control-Allow-Origin': '*' })
    return res.end(wav)
  }
  if (url.pathname === '/v3/create-web-call' && req.method === 'POST') return send(res, 201, { call_id: `call_e2e${Date.now()}`, access_token: 'e2e_web_access_token', transport: 'gateway', ice_servers: [] })
  if (url.pathname === '/anthropic/v1/models' || url.pathname === '/openai/v1/models') {
    const auth = req.headers['x-api-key'] || String(req.headers.authorization || '')
    if (auth.includes('BAD')) return send(res, 401, { type: 'error', error: { type: 'authentication_error', message: 'invalid' } })
    // What a connected account offers: Anthropic reports capabilities; OpenAI ids only (one non-text model to filter out).
    const caps = { structured_outputs: { supported: true }, effort: { supported: true } }
    const data = url.pathname.startsWith('/anthropic')
      ? ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'].map((id) => ({ id, type: 'model', display_name: id, max_tokens: 128000, capabilities: caps }))
      : ['gpt-4o-mini', 'gpt-4.1', 'text-embedding-3-small'].map((id) => ({ id, object: 'model', owned_by: 'openai' }))
    return send(res, 200, { data, has_more: false, first_id: data[0].id, last_id: data.at(-1).id })
  }
  // Website import stand-in (SITE_IMPORT_MOCK_ORIGIN): /__site/<host><path> serves a small Squarespace-style site.
  if (url.pathname.startsWith('/__site/')) {
    const [, , host, ...rest] = url.pathname.split('/')
    const path = '/' + rest.join('/')
    // Each mock site has its own description (the importer uses a site's meta description).
    const description = host === 'www.northwindair.example' ? 'Heating and cooling service in Minneapolis, booked online.' : 'Weekly pool care in Charleston, booked online.'
    const html = (title, body) => `<!doctype html><html><head><title>${title}</title><meta name="description" content="${description}"></head><body>${body}</body></html>`
    const pages = {
      '/robots.txt': ['text/plain', 'User-agent: *\nDisallow: /config\nSitemap: https://www.harborpools.example/sitemap.xml'],
      '/sitemap.xml': ['application/xml', '<urlset><url><loc>https://www.harborpools.example/services</loc></url><url><loc>https://www.harborpools.example/about</loc></url></urlset>'],
      '/': ['text/html', html('Harbor Pools', '<h1>Clear Pools in Charleston</h1><p>Weekly pool care from a small local team.</p><img data-src="https://img.harborcdn.example/pool.jpg" data-image-dimensions="1600x1000" alt="Pool">')],
      '/services': ['text/html', html('Services — Harbor Pools', '<h1>Services</h1><h3>Weekly Pool Care</h3><p>$180+</p><p>Skimming, brushing and balanced water every week.</p><h3>Green Pool Cleanup</h3><p>$400+</p><p>We bring green water back to clear in a few visits.</p><h3>Spring Opening</h3><p>$250+</p><p>Experience the joy of coming home to a spotless sanctuary, every corner of your house.</p>')],
      '/about': ['text/html', html('About — Harbor Pools', '<h2>Who we are</h2><p>A small Charleston team focused on reliable weekly visits and clear communication.</p>')],
    }
    if (host === 'img.harborcdn.example') {
      res.writeHead(200, { 'Content-Type': 'image/png' })
      return res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1, 2, 3]))
    }
    // A second, non-pool business (HVAC) with its own privacy policy, contact and about-us pages.
    const hvacPolicy = '<h1>Privacy Policy</h1><h2>What we collect</h2><p>Your name, phone number and address when you request service.</p><h2>Reviews and offers</h2><p>We may ask for reviews. Asking us a question is always free.</p>'
    const hvac = {
      '/robots.txt': ['text/plain', 'User-agent: *\nAllow: /\nSitemap: https://www.northwindair.example/sitemap.xml'],
      '/sitemap.xml': ['application/xml', ['/services', '/about-us', '/contact-us', '/privacy-policy'].map((p) => `<url><loc>https://www.northwindair.example${p}</loc></url>`).join('').replace(/^/, '<urlset>').concat('</urlset>')],
      '/': ['text/html', html('Northwind Air', '<h1>Heating and cooling in Minneapolis</h1><p>Furnace and air conditioning service for Minneapolis homes, from tune-ups to repairs.</p>')],
      '/services': ['text/html', html('Services — Northwind Air', '<h1>What we do</h1><h3>AC Tune-Up</h3><p>$129</p><p>A full check of your air conditioner before summer, with a written report.</p><h3>Furnace Repair</h3><p>$95 diagnostic</p><p>We find the fault and quote the repair before any work starts.</p>')],
      '/about-us': ['text/html', html('About us — Northwind Air', '<h2>About Northwind Air</h2><p>Northwind Air is a family heating and cooling company working across Minneapolis and nearby towns.</p>')],
      '/contact-us': ['text/html', html('Contact us — Northwind Air', '<h1>Contact us</h1><p>Call or send a message.</p>')],
      '/privacy-policy': ['text/html', html('Privacy Policy — Northwind Air', hvacPolicy)],
    }
    const p = host === 'www.harborpools.example' ? pages[path] : host === 'www.northwindair.example' ? hvac[path] : null
    if (!p) return send(res, 404, { error: 'not found' })
    res.writeHead(200, { 'Content-Type': p[0] })
    return res.end(p[1])
  }
  if (url.pathname === '/__dns' && req.method === 'POST') {
    const body = JSON.parse(raw)
    dnsRecords.set(`${body.type}:${body.name}`, body.values)
    return send(res, 200, { ok: true })
  }
  if (url.pathname.startsWith('/v1/') || url.pathname.startsWith('/__stripe/')) {
    if ((await stripeMock(req, res, url, raw)) !== null || res.writableEnded) return
  }

  // Google OAuth token revocation (MOCK): always succeeds.
  if (url.pathname === '/revoke' && req.method === 'POST') return send(res, 200, {})

  // Reversible, deterministic fault injection (Control Center demo, test-only): POST /__faults
  // { customer, fault: 'invalid_grant' | 'freebusy_error' | 'clear' } for a seeded business (refresh token
  // mock-refresh-seeded-<customer>). invalid_grant: Google rejects the stored grant; freebusy_error: lookups fail (500).
  if (url.pathname === '/__faults' && req.method === 'POST') {
    const { customer, fault } = JSON.parse(raw || '{}')
    const refresh = `mock-refresh-seeded-${customer}`
    const access = `Bearer mock-access-${createHmac('sha256', 'cal').update(refresh).digest('hex').slice(0, 16)}`
    faults.invalidGrant.delete(refresh)
    faults.freeBusy.delete(access)
    if (fault === 'invalid_grant') faults.invalidGrant.add(refresh)
    if (fault === 'freebusy_error') faults.freeBusy.add(access)
    return send(res, 200, { ok: true })
  }

  if (url.pathname === '/token' && req.method === 'POST') {
    const p = new URLSearchParams(raw)
    if (p.get('grant_type') === 'refresh_token' && faults.invalidGrant.has(String(p.get('refresh_token')))) return send(res, 400, { error: 'invalid_grant' })
    // One calendar per connected Google account: the access token is derived from the refresh token.
    // A Google sign-in that reaches only REAL (production) Google Ads accounts keeps a recognisable token.
    if (p.get('grant_type') === 'refresh_token' && String(p.get('refresh_token')).startsWith('mock-ads-prod-')) return send(res, 200, { access_token: 'mock-ads-prod-access', expires_in: 3600, scope: 'https://www.googleapis.com/auth/adwords' })
    // ads-revoked: the sign-in worked once, then Google rejects the stored refresh token (expired/revoked access).
    if (p.get('grant_type') === 'refresh_token' && String(p.get('refresh_token')).startsWith('mock-ads-revoked-')) return send(res, 400, { error: 'invalid_grant' })
    const variant = String(p.get('refresh_token')).match(/^mock-ads-(one|flaky|none|existing)-refresh-/)?.[1]
    if (p.get('grant_type') === 'refresh_token' && variant) return send(res, 200, { access_token: `mock-ads-${variant}-access`, expires_in: 3600, scope: 'https://www.googleapis.com/auth/adwords' })
    if (p.get('grant_type') === 'refresh_token') return send(res, 200, { access_token: `mock-access-${createHmac('sha256', 'cal').update(String(p.get('refresh_token'))).digest('hex').slice(0, 16)}`, expires_in: 3600, scope: SCOPE })
    const [kind, email] = String(p.get('code')).split(':')
    if (kind === 'login') return send(res, 200, { access_token: 'mock-login', id_token: idToken(email), scope: 'openid email' })
    if (kind === 'connect') return send(res, 200, { access_token: 'mock-access-token', refresh_token: `mock-refresh-${email}`, id_token: idToken(email), scope: SCOPE })
    if (kind === 'ads-prod') return send(res, 200, { access_token: 'mock-ads-prod-access', refresh_token: `mock-ads-prod-refresh-${email}`, scope: 'https://www.googleapis.com/auth/adwords' })
    if (kind === 'ads-revoked') return send(res, 200, { access_token: 'mock-ads-revoked-access', refresh_token: `mock-ads-revoked-refresh-${email}`, scope: 'https://www.googleapis.com/auth/adwords' })
    if (kind === 'ads-one' || kind === 'ads-flaky' || kind === 'ads-none' || kind === 'ads-existing') return send(res, 200, { access_token: `mock-${kind}-access`, refresh_token: `mock-${kind}-refresh-${email}`, scope: 'https://www.googleapis.com/auth/adwords' })
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
    if (faults.freeBusy.has(owner)) return send(res, 500, { error: { code: 500, status: 'INTERNAL', message: 'mock fault' } })
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
