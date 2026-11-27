// Deterministic answers that never need the model (and must never depend on it): a request for a consequential action
// the admin assistant may not prepare, and a request for owners' or their customers' details or conversations.
// Prepared actions (resend an invitation, mark an enrollment abandoned, run reconciliation, record a code status,
// mark/unmark a test business) go to the model, which can only prepare them for an explicit Approve.

const POLITE = /^\s*(?:hey|hi|ok|okay|so|please|pls|now|then|can you|could you|would you|will you|can we|go ahead and|i want you to|i need you to|i'd like you to|let's|lets|just)[\s,]+/i
const lead = (q) => {
  let s = String(q || '').trim()
  for (let i = 0; i < 4; i++) s = s.replace(POLITE, '')
  return s.toLowerCase()
}
const ALLOWED = /\b(re-?send|send)\b[^.?!]*\binvit|\bmark\b[^.?!]*\b(abandon|test)|\b(run|start|do)\b[^.?!]*\breconcil|\brecord\b[^.?!]*\b(code|status|sent|replied|approved|declined|followed)|\bunmark\b/i

const WHERE = [
  [/^(suspend|unsuspend|reinstate|lock|block|ban)\b/, 'Suspension is a manual, audited step on the business page: Overview → the business → Controls.'],
  [/^(delete|erase|wipe|remove (the |their |this )?(account|business|data))\b/, 'Deletion is done on the business page under Delete account, with the business id typed to confirm.'],
  [/^(refund|charge|bill|invoice|pay|payout|credit|comp|discount|waive)\b|^(give|offer|apply|grant|add)\b[^.?!]*\b(discount|credit|refund|coupon|free (month|week|trial)|money back|\d+ ?%( off)?)/, 'Money only moves in Stripe: refunds, charges, discounts, credits and partner payouts are done there. Here I can only show what is recorded.'],
  [/^(cancel|downgrade|upgrade|change (the |their )?(plan|price|subscription)|switch (them|it) to)\b/, 'Subscriptions change in Stripe or on the owner’s Billing page; plans are under Overview → Plans.'],
  [/^((write|draft|compose)( and)? )?(email|text|sms|message|call|notify|remind|send (an? |the )?(email|text|sms|message|reminder|note|announcement|newsletter))\b/, 'I don’t send or draft messages, and the console has no bulk email: write to owners from your own email.'],
  [/^(launch|pause|resume|start|stop|boost|raise|lower|increase|decrease)\b[^.?!]*\b(ads?|campaigns?|budget|spend)\b/, 'Ads are changed on the business’s Ads page, or paused from the Control Center.'],
  [/^(turn|switch|flip|enable|disable|activate|deactivate)\b/, 'Switches are Cloudflare settings that need your approval; nothing here changes them.'],
  [/^(grant|revoke|give|add|remove)\b[^.?!]*\b(role|access|admin|sales rep|permission)/, 'Roles are granted and revoked under Sales → Team.'],
  [/^(approve|set|change|edit|update)\b[^.?!]*\b(terms|commission|price|prices|plan|budget|switch|role)/, 'That is changed on its own page (partners and terms under Growth → Partners, plans under Overview → Plans); I can’t change it.'],
]

// "yes", "do it", "go ahead": nothing in chat does anything; the card's Approve button does.
const CONFIRM = /^\s*(yes|yep|yeah|sure|ok(ay)?|do it|go( ahead)?|please do|confirm(ed)?|approved?|send it|run it|go for it|that one)\b[\s\w,.!']{0,30}$/i
export function confirmAsk(question) {
  return CONFIRM.test(String(question || '')) ? { kind: 'not_here', answer: 'Nothing happens from the chat: press Approve on the card above to do it. If there’s no card, tell me what to prepare.' } : null
}

export const PREPARABLE = 'I can prepare only: resending an invitation, marking an unpaid enrollment abandoned, running billing reconciliation, recording a tracking code’s status, and marking or unmarking a test business.'

// → { answer, kind: 'not_here' } | null
export function consequentialAsk(question) {
  const q = lead(question)
  if (ALLOWED.test(q)) return null
  for (const [re, where] of WHERE) if (re.test(q)) return { kind: 'not_here', answer: `I can’t do that from here, and I don’t prepare it either. ${where} ${PREPARABLE}` }
  return null
}

// Owners' or their customers' details, messages or conversations.
const OWNER_DATA = /\b(phone numbers?|(their|his|her|owner['’]?s?|customer['’]?s?) phone|e-?mail (address(es)?|of)|emails? of|(owner|their|his|her|customer)['’]?s? e-?mails?|contact (details?|info\w*)|home address|street address|addresses of|transcripts?|recordings?|what (did|does|do) [^?]{1,60}\b(say|said|write|wrote|ask|asked|type|typed)\b|read (me )?(the |their |his |her )?(messages?|chats?|conversations?|texts?)|show (me )?(the |their |his |her )?(messages?|chats?|conversations?|texts?|leads?|customer list|customers['’]? names)|names? of (their|its|the business['’]?s?) (customers|leads|clients)|(customer|client|lead)['’]?s? names|who (are|were) (their|its) (customers|leads|clients))\b/i

export function ownerDataAsk(question) {
  if (!OWNER_DATA.test(String(question || ''))) return null
  return { kind: 'private', answer: 'I can’t show that: the admin views show counts and statuses only, never owners’ or their customers’ contact details, messages or conversations. The owner sees their own records in their dashboard.' }
}
