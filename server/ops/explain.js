// Plain-English titles and next steps for incidents (read side only; the register itself is unchanged).
// Fixed text keyed by rule kind / recorded action. Unknown actions fall back to "<feature>: <action> failed".
// Platform-wide incidents (no business) never point the founder at an account that doesn't exist.

const KIND_TITLE = {
  calendar: 'Google Calendar connection broken',
  availability: 'Booking page can’t load open times',
  comms: 'Messages failing to deliver',
}
const ACTION_TITLE = {
  'sms.webhook_rejected': 'Text-message webhook refused a request',
  'sms.inbound_unrouted': 'Incoming text couldn’t be matched to a business',
  'sms.inbound_spike': 'Unusual burst of incoming texts',
  'booking.failed': 'A booking failed',
  'booking.event_cleanup': 'Calendar event cleanup failed',
  'booking.cancel': 'A cancellation failed',
  'ads.budget': 'Ad budget change failed',
  'followups.ai_fallback': 'Follow-up assistant fell back to a fixed reply',
  'billing.payment_failed': 'A payment failed',
  'account.deletion_step_failed': 'An account deletion step failed',
}
// What to do next for a PLATFORM-WIDE failure (no business linked).
const PLATFORM_NEXT = {
  'sms.webhook_rejected':
    'Check whether the request came from Twilio: Twilio Console → Monitor → Errors around the first-seen time. No matching entry means it did not come from Twilio (a probe or a manual test) and nothing needs changing. Matching entries mean a number’s webhook URL or account is misconfigured. While no business has a live texting number, no customer is affected.',
  'sms.inbound_unrouted': 'An incoming text arrived for a number no business owns. Check the number’s configuration in Twilio. No customer reply was lost unless a business uses that number.',
}
const PLATFORM_DEFAULT = 'Check this feature’s recent events in Business Review to see whether it has succeeded since. The incident closes when a later success is recorded, or as “no new failures” after 14 days.'
const ACCOUNT_DEFAULT = 'Open the account to see the failed step, then look at the event in Business Review. Retry the action once the cause is fixed.'

// Features that record events but aren't registered capabilities of their own.
const FEATURE_LABEL = { 'followups.sms_inbound': 'Incoming text messages', 'followups.sms': 'Text messages', 'followups.email': 'Follow-up emails', 'followups.assistant': 'Follow-up assistant', 'platform.incidents': 'Incident register', 'platform.alerts': 'Founder alerts', 'platform.admin': 'Admin console' }
export const featureLabel = (id) => FEATURE_LABEL[id] || null
const humanize = (s) => String(s || '').replace(/[._]/g, ' ').trim()

export function incidentTitle(i, featureName = null) {
  if (KIND_TITLE[i.kind]) return KIND_TITLE[i.kind]
  if (ACTION_TITLE[i.step]) return ACTION_TITLE[i.step]
  return `${featureName || humanize(i.feature) || 'Operation'}: ${humanize(i.step) || 'operation'} failed`
}

export function incidentNext(i, ruleRecovery) {
  if (i.customer) return i.kind === 'failure' ? ACCOUNT_DEFAULT : ruleRecovery
  if (i.kind !== 'failure') return ruleRecovery.replace(/for this account|this business’s?/g, 'each affected business')
  return PLATFORM_NEXT[i.step] || PLATFORM_DEFAULT
}
