// An owner's consequential change, in the permanent log: codes and counts only.
import { recordEvent } from './auditlog.js'
export const appendOwnerChange = (env, session, type, details = {}) => recordEvent(env.ONBOARDING_DB, { type, actorType: 'owner', actor: `owner:${session.email}`, customer: session.customer.id, capability: 'account.controls', resource: { type: 'customer', id: session.customer.id }, outcome: 'success', details })
