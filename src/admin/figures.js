// The three figures the admin Overview AND Growth → Measure both show: MRR, Paying customers, Retention.
// ONE function turns the same API facts (server/metrics.js growth(): `billing` and `retention30`, returned by
// /api/platform/overview as metrics.* and by /api/platform/growth as measure.*) into the value and the status word
// both pages print, so they can never disagree (finding ADM-02). Pure: no DOM, used by test/admin-figures.test.js.
//   status words: Measured (from real records) · Test mode (billing is in test mode: nothing is revenue) ·
//                 Unavailable (nothing to measure yet)
// Nothing here computes a metric: it only words what the server reported.
import { money, plural } from '../lib/format.js'

const STATUS = { measured: ['Measured', 'ok'], test: ['Test mode', 'warn'], unavailable: ['Unavailable', 'neutral'] }
const figure = (value, kind, note = '') => ({ value, kind, status: STATUS[kind][0], tone: STATUS[kind][1], note })

export function sharedFigures(billing, retention30) {
  const test = billing?.mode === 'test'
  const testNote = test ? `Billing is in test mode: ${plural(billing.testSubscriptions, 'active test subscription')}, none of it revenue.` : ''
  const live = billing && !test ? billing : null
  const none = !billing ? 'No subscriptions yet.' : ''
  const billed = (v, text) => (test ? figure('—', 'test', testNote) : live && v != null ? figure(text(v), 'measured') : figure('—', 'unavailable', none))
  return {
    mrr: billed(live?.mrrCents, (v) => money(v, { cents: true })),
    payingCustomers: billed(live?.payingCustomers, (v) => String(v)),
    retention: retention30 == null ? figure('—', 'unavailable', 'No customer has been set up for 30 days yet.') : figure(`${Math.round(retention30)}%`, 'measured'),
  }
}
