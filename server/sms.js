// Text messages through Twilio. Inactive unless TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN are configured AND the
// business has its own approved sender (server/followups/settings.js smsReadiness). US carriers require an approved
// A2P 10DLC campaign before messages are delivered; nothing here assumes one.
// Twilio handles STOP/HELP replies on the sender; a send to an opted-out number fails with 21610.

// The provider account is configured (credentials). Each business texts from its OWN sender (sms_registrations, set by a
// platform admin once provisioned): no platform-wide number is needed or used for customer texts.
export const smsConfigured = (env) => Boolean(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN)

// US/Canada numbers to E.164 (+1XXXXXXXXXX); explicit "+<country>" numbers are kept. Otherwise null.
export function toE164(phone) {
  const raw = String(phone ?? '').trim()
  const digits = raw.replace(/\D/g, '')
  if (raw.startsWith('+')) return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null
  if (digits.length === 10) return `+1${digits}`
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`
  return null
}

// Sending lives in server/followups/transport.js (sendTwilio): always from the business's own subaccount and sender.
