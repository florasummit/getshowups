// Minimal feature + journey registry (Control Center). Stable ids link automated tests, human QA, incidents and the
// Journey Inspector. Rules: an id is never reused or renamed in place. Renaming = keep the id, change `title`. Replacing
// = add a new id and put the old one in RETIRED with `replacedBy`, so stored results/incidents keep their meaning.
// Features are the capability ids of server/ops/catalog.js (the existing registry); journeys reference them.
//
// Step fields: id (stable), title, action (what the person does), expected (what should happen), feature, and for
// human QA `ask` (context questions about clarity, trust, effort, accessibility, visual quality — not assertions
// automation already covers). Automated tests link by spec file + exact title prefix (`tests`).

export const STEP_STATES = ['completed', 'current', 'blocked', 'failed', 'skipped', 'unknown']
export const RESULT_STATES = ['pass', 'fail', 'blocked', 'not_tested']

const q = {
  clarity: 'Was it clear what to do here and why?',
  trust: 'Did anything make you hesitate or feel unsure about trusting GetShowUps?',
  effort: 'How much effort did this take (1 = none, 5 = a lot)? What slowed you down?',
  access: 'Could you read and operate everything (text size, contrast, buttons, keyboard/zoom)?',
  visual: 'Did anything look broken, cramped or out of place on your screen?',
}

export const JOURNEYS = [
  {
    id: 'activation',
    title: 'New owner activation (target ≤ 20 min)',
    purpose: 'Can a first-time owner go from the website to a live booking page and a confirmed test booking in 20 minutes, without help?',
    audience: 'new',
    timed: true,
    targetMinutes: 20,
    note: 'Authorized TEST onboarding only while public signup is closed: the tester is on the approved test list. Never reported as public signup.',
    steps: [
      { id: 'offer', title: 'Understand the offer', action: 'Open getshowups.com and read the first screen and pricing.', expected: 'You can say what GetShowUps does and what it costs.', feature: 'onboarding.selfserve', ask: [q.clarity, q.trust] },
      { id: 'start', title: 'Begin onboarding', action: 'Use the link you were given and sign in with Google.', expected: 'You are asked for your business name.', feature: 'auth.google_signin', ask: [q.clarity, q.trust] },
      { id: 'business', title: 'Business and plan', action: 'Name the business, choose the plan, pay with the test card.', expected: 'Payment accepted (test mode); you continue to your details.', feature: 'billing.stripe', ask: [q.trust, q.effort] },
      { id: 'details', title: 'Details, services, area', action: 'Enter industry, services with prices, and service ZIPs.', expected: 'Saved; the calendar step is next.', feature: 'onboarding.selfserve', ask: [q.effort, q.clarity] },
      { id: 'calendar', title: 'Connect Google Calendar', action: 'Connect the calendar you book on (Google may warn the app is unverified).', expected: 'Calendar connected.', feature: 'calendar.google', ask: [q.trust, q.clarity] },
      { id: 'hours', title: 'Configure availability', action: 'Set your booking hours.', expected: 'Hours confirmed.', feature: 'calendar.google', ask: [q.effort, q.access] },
      { id: 'website', title: 'Website and booking page', action: 'Start your website, preview it, choose the address, publish.', expected: 'Your site is live with a Book button.', feature: 'website.hosting', ask: [q.visual, q.effort, q.clarity] },
      { id: 'booking', title: 'Complete a test booking', action: 'On your phone, open your site and book a time as a customer.', expected: 'Booking confirmed on screen; it appears on your Google Calendar.', feature: 'calendar.google', ask: [q.access, q.visual] },
      { id: 'confirmation', title: 'Verify confirmation', action: 'Check the inbox you booked with.', expected: 'A confirmation email arrives (test recipients only).', feature: 'messaging.email', ask: [q.trust] },
    ],
    tests: [{ spec: 'selfserve.spec.js', title: 'new customer: get started → pay → onboard → publish → book → manage billing' }],
  },
  {
    id: 'booking',
    title: 'Customer books on a business page',
    purpose: 'Can a customer book a time on a business’s booking page and receive a confirmation?',
    audience: 'public',
    steps: [
      { id: 'page', title: 'Open booking page', action: 'Open the business booking page.', expected: 'Business name and the details form.', feature: 'calendar.google', ask: [q.clarity, q.visual] },
      { id: 'details', title: 'Enter details', action: 'Fill in name, contact and need.', expected: 'Open times are offered.', feature: 'lead.capture', ask: [q.effort, q.access] },
      { id: 'availability', title: 'See open times', action: 'Look at the offered times.', expected: 'Times inside booking hours, none already taken.', feature: 'calendar.google', ask: [q.clarity] },
      { id: 'book', title: 'Book a time', action: 'Pick a time and confirm.', expected: '"You’re booked" with the time; event on the owner calendar.', feature: 'calendar.google', ask: [q.trust] },
      { id: 'confirmation', title: 'Confirmation message', action: 'Check the email (test recipients only).', expected: 'Confirmation with the time and a cancel link.', feature: 'messaging.email', ask: [q.trust, q.clarity] },
    ],
    tests: [
      { spec: 'booking.spec.js', title: 'lead books a real appointment; owner sees it' },
      { spec: 'booking.spec.js', title: 'the same slot cannot be booked twice' },
      { spec: 'automation.spec.js', title: 'confirm link: shows the appointment' },
    ],
  },
  {
    id: 'returning-owner',
    title: 'Existing owner signs in and manages bookings',
    purpose: 'Can an existing owner sign in, find upcoming bookings and record what happened?',
    audience: 'existing',
    steps: [
      { id: 'signin', title: 'Sign in', action: 'Go to getshowups.com → Sign in → Google.', expected: '"Welcome back", then your dashboard.', feature: 'auth.google_signin', ask: [q.clarity] },
      { id: 'appointments', title: 'See appointments', action: 'Open Appointments.', expected: 'Upcoming bookings with times.', feature: 'calendar.google', ask: [q.clarity, q.visual] },
      { id: 'outcome', title: 'Record a result', action: 'Mark a past visit showed / no-show.', expected: 'Saved; can be undone.', feature: 'showup.outcomes', ask: [q.effort] },
    ],
    tests: [
      { spec: 'booking.spec.js', title: 'owner records show-up results' },
      { spec: 'admin.spec.js', title: 'existing pilot (non self-serve) business keeps its dashboard' },
    ],
  },
  {
    id: 'invited-user',
    title: 'Invited user joins a business',
    purpose: 'Can someone invited to a business accept, sign in and connect their calendar?',
    audience: 'invited',
    steps: [
      { id: 'invite', title: 'Open invitation', action: 'Open the invitation link.', expected: 'The business name and who invited you.', feature: 'auth.google_signin', ask: [q.trust] },
      { id: 'join', title: 'Sign in and join', action: 'Sign in with the invited Google account.', expected: 'You join the business dashboard.', feature: 'auth.google_signin', ask: [q.clarity] },
      { id: 'calendar', title: 'Connect calendar', action: 'Connect your own calendar when asked.', expected: 'Calendar connected.', feature: 'calendar.google', ask: [q.trust] },
    ],
    tests: [{ spec: 'admin.spec.js', title: 'admin-assisted setup: invite → owner signs in with Google → joins' }],
  },
  {
    id: 'calendar-recovery',
    title: 'Calendar connection recovery',
    purpose: 'When a calendar connection breaks, is the owner told clearly, can they fix it, and does the incident close on evidence?',
    audience: 'recovery',
    steps: [
      { id: 'notice', title: 'Owner is told', action: 'Open the dashboard while the calendar connection is broken.', expected: '"Needs reconnecting" with one clear action.', feature: 'calendar.google', ask: [q.clarity, q.trust] },
      { id: 'reconnect', title: 'Reconnect', action: 'Reconnect Google Calendar.', expected: 'Connected; booking page shows times again.', feature: 'calendar.google', ask: [q.effort] },
      { id: 'resolved', title: 'Incident resolves', action: '(Admin) Check the Control Center after the next lookup.', expected: 'Incident shows Resolved (success seen).', feature: 'platform.incidents', ask: [] },
    ],
    tests: [{ spec: 'control-center.spec.js', title: 'demo: injected availability failure' }],
  },
  {
    id: 'admin-console',
    title: 'Platform admin console',
    purpose: 'Can a GetShowUps admin sign in and find platform health, accounts and incidents (and customers can’t)?',
    audience: 'admin',
    steps: [
      { id: 'signin', title: 'Admin sign-in', action: 'Sign in at /admin.', expected: 'Console; customers never get in.', feature: 'platform.admin', ask: [q.clarity] },
      { id: 'review', title: 'Business Review', action: 'Open Business Review.', expected: 'Capabilities, incidents, approvals.', feature: 'platform.admin', ask: [q.clarity] },
      { id: 'control', title: 'Control Center', action: 'Open the Control Center and one business.', expected: 'Incidents, account inspector, journey.', feature: 'platform.incidents', ask: [q.clarity, q.effort] },
    ],
    tests: [
      { spec: 'admin.spec.js', title: 'customers without platform access are refused' },
      { spec: 'review.spec.js', title: 'founder opens Business Review' },
    ],
  },
  // QA Command Center (2026-11-27): guided checks for what automation can't judge. `assisted` marks an AI-assisted step:
  // an AI assessment may be attached as labelled evidence, but only the person's recorded result counts.
  {
    id: 'receptionist',
    title: 'Receptionist answers and books (chat and voice)',
    purpose: 'Does the receptionist answer from the business’s records, book only a time it offered after the customer said yes, and sound right?',
    audience: 'public',
    note: 'Use an admin-marked TEST business (chat page ?test=<provider> for voice). Nothing reaches a real customer.',
    steps: [
      { id: 'open', title: 'Open the chat', action: 'Open /chat/<test business> on your phone.', expected: 'The business name, a greeting and a message box.', feature: 'receptionist.chat', ask: [q.clarity, q.visual] },
      { id: 'facts', title: 'Ask about services and prices', action: 'Ask what they offer and what one service costs.', expected: 'Only services and prices from Settings → Services; no invented numbers.', feature: 'receptionist.chat', ask: [q.trust] },
      { id: 'book', title: 'Book a time', action: 'Ask for a time, give your ZIP, name and phone, and say yes to one offered time.', expected: 'Booked only after your yes; the time appears on the test business’s calendar.', feature: 'receptionist.chat', ask: [q.effort, q.trust] },
      { id: 'transcript', title: 'Check the transcript', action: 'Open the conversation in the dashboard and compare it with what you saw.', expected: 'Every fact in the replies matches the records (AI assessment may help; you confirm).', feature: 'receptionist.chat', assisted: 'transcript', ask: [q.trust] },
      { id: 'voice', title: 'Voice call', action: 'Start a voice call on the test page and ask for a time.', expected: 'You hear the receptionist clearly, it understands you, and it offers real open times.', feature: 'receptionist.voice', ask: [q.clarity, q.access] },
      { id: 'voice-quality', title: 'Voice quality', action: 'Judge the voice: pace, interruptions, pronunciation of the business name.', expected: 'Natural pace, stops when interrupted, names said correctly (your judgement).', feature: 'receptionist.voice', ask: [q.trust, q.effort] },
    ],
    tests: [],
  },
  {
    id: 'website-studio',
    title: 'Owner edits and publishes the website',
    purpose: 'Can an owner change their website in Studio, preview it on a phone and publish deliberately?',
    audience: 'existing',
    steps: [
      { id: 'open', title: 'Open Studio', action: 'Dashboard → Website → Edit.', expected: 'The site preview is the editor.', feature: 'website.studio', ask: [q.clarity] },
      { id: 'edit', title: 'Change text and a photo', action: 'Edit the headline and swap one photo.', expected: 'Changes show in place; the live site is unchanged.', feature: 'website.studio', ask: [q.effort, q.visual] },
      { id: 'phone', title: 'Check on a phone', action: 'Open Preview on your phone width.', expected: 'No sideways scroll; headline and Book button on the first screen.', feature: 'website.hosting', ask: [q.visual, q.access] },
      { id: 'publish', title: 'Publish', action: 'Publish and confirm.', expected: 'The live site shows the change; an earlier version can be restored.', feature: 'website.hosting', ask: [q.trust] },
    ],
    tests: [],
  },
  {
    id: 'admin-assistant',
    title: 'Platform admin asks the assistant',
    purpose: 'Does the admin assistant answer from records, separate facts from gaps, and only prepare changes?',
    audience: 'admin',
    steps: [
      { id: 'ask', title: 'Ask what needs attention', action: 'Admin → Assistant: “What needs me this week?”', expected: 'Labelled items from real records; test-mode billing never urgent.', feature: 'platform.admin', ask: [q.clarity, q.trust] },
      { id: 'private', title: 'Ask for private data', action: 'Ask for a customer’s phone number.', expected: 'Refused; no contact details shown.', feature: 'platform.admin', ask: [q.trust] },
      { id: 'prepare', title: 'Ask for a change', action: 'Ask it to resend an invitation.', expected: 'A prepared change with Approve; nothing done until you approve.', feature: 'platform.admin', ask: [q.trust, q.effort] },
    ],
    tests: [],
  },
]

// Retired ids keep their meaning for stored results: { id: { title, replacedBy } }.
export const RETIRED = {}

export const journey = (id) => JOURNEYS.find((j) => j.id === id) || null
export const journeyTitle = (id) => journey(id)?.title || RETIRED[id]?.title || id
// Stable test id: journey + spec + title prefix (never the line number).
export const testId = (journeyId, t) => `${journeyId}:${t.spec.replace(/\.spec\.js$/, '')}:${t.title.slice(0, 40).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`
export function linkedTests() {
  return JOURNEYS.flatMap((j) => j.tests.map((t) => ({ id: testId(j.id, t), journey: j.id, ...t })))
}
// Which registered test a Playwright result belongs to (file basename + full title).
export function matchTest(file, title) {
  const base = String(file || '').split('/').pop()
  return linkedTests().filter((t) => t.spec === base && String(title || '').startsWith(t.title))
}
