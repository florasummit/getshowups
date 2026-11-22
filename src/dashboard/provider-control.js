// Constants and the two API bindings of the AI voice provider control (ProviderControl.jsx): the dashboard route (a
// platform admin who is a member of the business) and the Admin Console route (any business, platform admins only).
import { api } from '../lib/api.js'

export const traits = (v) => [v?.gender, v?.accent, v?.age, v?.language && v.language !== 'en' ? v.language : null].filter(Boolean)
export const STATE = { active: ['ok', 'Active for customers'], ready: ['ok', 'Ready for production'], needs_test: ['warn', 'Needs a test'], not_configured: ['neutral', 'Not configured'], disabled: ['bad', 'Switched off'], no_customer_path: ['neutral', 'Test only'] }
export const BLOCKER = {
  not_configured: 'not configured',
  disabled: 'switched off',
  no_customer_path: 'no customer path',
  needs_test: 'no verified test session yet',
  test_only: 'test only (no customer path)',
  business_not_eligible: 'business not eligible',
  tools_missing: 'tools missing',
  voice_replacement_required: 'a voice must be chosen',
  booking_not_ready: 'booking not ready',
  test_session_required: 'no finished test session',
  no_change: 'nothing would change',
  voice_unknown: 'voice not in the catalog',
  catalog_unavailable: 'voice list unavailable',
  invalid_voice_id: 'invalid voice',
  provider_not_configured: 'provider not configured',
}
// The dashboard route (session business; admin-only actions checked server-side).
export const dashboardOps = {
  catalog: (provider) => api(`/api/dashboard/receptionist/voices?provider=${encodeURIComponent(provider)}`),
  check: (input) => api('/api/dashboard/receptionist', { method: 'POST', body: { action: 'provider_check', ...input } }),
  switch: (input) => api('/api/dashboard/receptionist', { method: 'POST', body: { action: 'provider_switch', ...input } }),
  rollback: (input) => api('/api/dashboard/receptionist', { method: 'POST', body: { action: 'provider_rollback', ...input } }),
}
// The Admin Console route for one named business (platform admins only; membership not needed).
export const consoleOps = (customer) => ({
  catalog: (provider) => api(`/api/platform/voice-provider?customer=${encodeURIComponent(customer)}&catalog=${encodeURIComponent(provider)}`),
  check: (input) => api('/api/platform/voice-provider', { method: 'POST', body: { action: 'check', customer, ...input } }),
  switch: (input) => api('/api/platform/voice-provider', { method: 'POST', body: { action: 'switch', customer, ...input } }),
  rollback: (input) => api('/api/platform/voice-provider', { method: 'POST', body: { action: 'rollback', customer, ...input } }),
})
