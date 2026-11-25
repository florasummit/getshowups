// What closing this business would affect, as counts and states from its own records. A part that can't be read is null
// (shown as "couldn't be checked"), never zero.
import { hostingStatus } from './website.js'
import { billingSubscription } from './stripe.js'
import { listServices } from './integrations.js'

export async function closingImpact(env, customer, now = Date.now()) {
  const db = env.ONBOARDING_DB
  const n = (sql) => db.prepare(sql).bind(customer.id, now).first().then((r) => r.n, () => null)
  const [upcoming, customers, conversations, messages, site, domain, ads, members, images, sub, services, hosting] = await Promise.all([
    n("SELECT count(*) AS n FROM appointments WHERE customer = ?1 AND status = 'booked' AND start_at > ?2"),
    n('SELECT count(*) AS n FROM leads WHERE customer = ?1 AND ?2 > 0'),
    n('SELECT count(*) AS n FROM receptionist_conversations WHERE customer = ?1 AND ?2 > 0'),
    n("SELECT count(*) AS n FROM messages WHERE customer = ?1 AND status = 'scheduled' AND ?2 > 0"),
    db.prepare('SELECT live_version FROM websites WHERE customer = ?1').bind(customer.id).first().then((r) => Boolean(r?.live_version), () => null),
    db.prepare("SELECT hostname FROM website_domains WHERE customer = ?1 AND status <> 'removed'").bind(customer.id).first().then((r) => r?.hostname ?? false, () => null),
    db.prepare("SELECT platform, count(*) AS n FROM ad_campaigns WHERE customer = ?1 AND status = 'active' GROUP BY platform").bind(customer.id).all().then((r) => r.results, () => null),
    n('SELECT count(*) AS n FROM customer_users WHERE customer = ?1 AND ?2 > 0'),
    n('SELECT count(*) AS n FROM website_assets WHERE customer = ?1 AND ?2 > 0'),
    billingSubscription(env, customer.id).then((s) => (s && !s.sandbox ? { status: s.status, endsAt: s.currentPeriodEnd, ending: s.cancelAtPeriodEnd } : false), () => null),
    listServices(env, customer).then((l) => l.filter((x) => x.state === 'connected' || x.state === 'attention').map((x) => x.name), () => null),
    hostingStatus(db, customer.id, now, env).then((h) => h.status, () => null),
  ])
  return { members, customers, upcoming, conversations, messages, images, site, domain, ads, subscription: sub, services, hosting }
}
