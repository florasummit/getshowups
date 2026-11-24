// Marketing copy lives here so it can be edited without touching layout code.
// Rule: no testimonials, customer logos, or performance statistics until real data exists. Every claim below
// describes what works in production today; anything else says "coming soon" or "pilot".
// Flagship (2026-11-21): one screen, one message, one next action. Sections explain through product visuals
// (components/Story.jsx) built from this data; visible copy is one or two short lines per idea.

export const navLinks = [
  { href: '#demo', label: 'See it work' },
  { href: '#how-it-works', label: 'How it works' },
  { href: '#teach', label: 'Teach Your AI' },
  { href: '#pricing', label: 'Pricing' },
  { href: '#faq', label: 'FAQ' },
]

// Primary call to action: start the Growth plan (sign in with Google → business → Stripe Checkout).
export const getStarted = { href: '/dashboard?plan=founding', label: 'Get started' }
// While online enrollment isn't open (GET /api/enrollment), every "Get started" becomes this, so visitors know before
// they sign in with Google. Existing accounts, invitations and testers still use "Sign in".
export const enrollmentClosed = {
  href: '/#book-demo',
  label: 'Request early access',
  note: 'Online enrollment isn’t open yet. Book a short call and we’ll set you up as soon as it opens.',
  next: ['Pick a time. The calendar here books it directly.', 'We look at your services, service area and website together.', 'When enrollment opens, you’re set up first. Nothing is charged until you sign up.'],
}

export const hero = {
  eyebrow: 'For pool, HVAC and roofing businesses',
  // Founder-approved 2026-11-23. Every clause is true today: the receptionist and booking page go live during
  // onboarding (well under an hour hands-on); ads are drafted and approved here but delivered only once live ad
  // delivery is switched on for customers (ADS_LIVE_LAUNCH). Reword when that changes.
  sub: 'Get your AI receptionist and bookings running in under an hour, with your first ads drafted and ready to approve. One platform to attract customers, capture leads, and grow your business.',
}

// Trademark rule: plain-text names only, no third-party logos, no word that implies partnership or endorsement. A name
// is listed only while every eligible customer can use it in production (checked 2026-11-23, docs/STATUS.md); anything
// limited, in testing or coming soon belongs in the FAQ, never here.
export const integrations = {
  title: 'Works with',
  names: ['Google Calendar', 'Google sign-in', 'Claude', 'OpenAI', 'Your own domain'],
  note: 'Claude and OpenAI use your own API key. No affiliation or endorsement implied.',
}

// The friction GetShowUps removes, told as one example day (components/Story.jsx → Problem). Fictional, illustrative,
// not a measured result; the two columns use the same inquiry so the only difference is who answers.
export const problem = {
  title: 'The inquiries you answer late are the jobs you don’t get',
  legend: ['Messages arrive while you’re on a job', 'The same ten questions, every time', 'Lead, time and address in four places'],
  inquiry: 'Pool turned green overnight. Can someone come this week? I’m in Mount Pleasant.',
  without: {
    label: 'Without GetShowUps',
    events: [
      { t: '9:12 AM', who: 'customer', text: 'Pool turned green overnight. Can someone come this week? I’m in Mount Pleasant.' },
      { t: '9:12 AM', note: 'You’re on a job until 3 PM', tone: 'wait' },
      { t: '11:40 AM', who: 'customer', text: 'Hello? Still there?' },
      { t: '2:05 PM', note: 'Booked someone else', tone: 'bad' },
    ],
  },
  with: {
    label: 'With GetShowUps',
    events: [
      { t: '9:12 AM', who: 'customer', text: 'Pool turned green overnight. Can someone come this week? I’m in Mount Pleasant.' },
      { t: '9:12 AM', who: 'ai', text: 'Yes, Mount Pleasant is in our area. Friday I have 10:30 AM or 1:00 PM. Which works?' },
      { t: '9:13 AM', who: 'customer', text: '10:30. Book it.' },
      { t: '9:13 AM', note: 'Booked · on your calendar', tone: 'ok' },
    ],
  },
}

// Attract → Capture → Qualify → Book → Follow up → Measure → Optimize: each step is drawn as the product state it produces
// (components/Story.jsx → HowItWorks). `status`: live | partly | soon. Bodies are one line.
export const journey = [
  { id: 'attract', status: 'live', title: 'Attract', body: 'Your website, hosted for you, with booking and chat built in.' },
  { id: 'answer', status: 'live', title: 'Capture', body: 'Replies in seconds from your records.' },
  { id: 'qualify', status: 'live', title: 'Qualify', body: 'Your service area, checked before any time is offered.' },
  { id: 'book', status: 'live', title: 'Book', body: 'Real open times from Google Calendar. Never booked twice.' },
  { id: 'notify', status: 'partly', title: 'Follow up', body: 'Google invites the customer. Reminders: testing.' },
  { id: 'measure', status: 'live', title: 'Measure', body: 'Inquiry → booked → showed → done.' },
  { id: 'optimize', status: 'partly', title: 'Optimize', body: 'Change rules, test them. Live use: pilot.' },
]

export const journeyNotes = 'Texting, email reminders and automatic follow-ups: testing. Website voice: pilot.'

// Teach Your AI (released 2026-11-20 as a controlled pilot: the Studio is on for the first pilot business; published
// rules reach live conversations only once GetShowUps switches that on per business). The panel pairs an owner's
// rules with the moment one of them decides what the AI says (components/Story.jsx → TeachYourAI).
export const teach = {
  title: 'Your AI, your rules',
  sub: 'Decide what it asks, what you don’t offer, what counts as urgent, and when to hand off to you.',
  points: [
    ['Teach a change in plain words', 'You see exactly what would change before it’s saved.'],
    ['Test it first', 'Type what a customer might say. Nothing is sent or booked.'],
    ['Every version kept', 'Publish when you’re ready. Go back in one click.'],
  ],
  locked: 'Always on: the area check, the customer’s yes before a booking, safety first, prices only from your records.',
  status: 'In pilot with founding customers',
  rules: [
    { n: 1, text: 'Ask what they need first' },
    { n: 2, text: 'Check the service area', fixed: true },
    { n: 3, text: '“No heat” is urgent → soonest open time', hit: true },
    { n: 4, text: 'We don’t install equipment' },
    { n: 5, text: 'Asks for a person → record a callback' },
  ],
  chat: [
    { who: 'customer', text: 'No heat since last night. We’re in 29483.' },
    { who: 'ai', text: 'Sorry to hear that, let’s get someone out today. The soonest I have is 3:00 PM. Shall I hold it?' },
  ],
  applied: 'Rule 3 applied: “no heat” is urgent, so the soonest open time comes first.',
}

export const industries = [
  { id: 'pool', title: 'Pool service', body: 'Green pools, pump noise, weekly care. Booked at the customer’s address.' },
  { id: 'hvac', title: 'HVAC', body: 'No cooling in July isn’t a tune-up. Urgency first, soonest time, you’re flagged.' },
  { id: 'roofing', title: 'Roofing', body: 'Storm damage: an inspection is booked, a person gives the estimate.', upcoming: true },
]

// Two offerings (2026-11-23): Growth, the $499/month plan every business signs up for online (plan id `founding`
// in billing stays as it is), and Enterprise for organizations that run many businesses, priced by agreement and
// sold through an inquiry (components/EnterpriseInquiry.jsx), never instant checkout.
export const pricing = {
  name: 'Growth',
  price: 499,
  period: 'month',
  badge: 'Founding customers',
  note: 'Billed monthly. No free trial, no setup fee, cancel any time from your billing page.',
  includes: [
    'A professional website, built and hosted for you',
    'Your GetShowUps address or your own domain',
    'AI receptionist on your website chat',
    'Online booking straight into Google Calendar',
    'Service-area screening for every lead',
    'Teach Your AI (pilot): your questions and rules',
    'Google Calendar invitations for every booking',
    'Show-up and no-show tracking',
    'Direct help from the founding team',
  ],
  excludes: 'Ad spend is separate, paid directly to Google or Meta. Texting, email reminders and ad management: coming soon.',
}

// Every line describes what exists today. Organization-level management (one login over many workspaces, shared
// reporting, one invoice) is designed, not built: say so, never imply it (docs/ENTERPRISE_ORGANIZATIONS.md).
export const enterprise = {
  name: 'Enterprise',
  lead: 'Starting at',
  price: '10,000',
  period: 'month',
  badge: 'By agreement',
  audience: 'For agencies, franchises, entrepreneurship programs, universities and multi-location organizations.',
  points: ['The same acquisition engine as Growth, across your businesses', 'Limits, support, onboarding and billing by agreement', 'Ad spend and separately priced usage excluded unless contracted'],
  today: 'Each business runs as its own workspace. Organization-wide management is not live yet.',
  cta: 'Contact sales',
  // Keys are validated by the server (server/enterprise.js ORG_TYPES); a test keeps the two lists identical.
  types: [
    ['agency', 'Agency'],
    ['franchise', 'Franchise'],
    ['program', 'Entrepreneurship program'],
    ['university', 'University'],
    ['multi_location', 'Multi-location business'],
    ['other', 'Other'],
  ],
}

export const faqs = [
  { q: 'What happens after I request early access?', a: 'You pick a time for a short call, straight from the calendar on this page. We look at your services, service area and current website together. Online enrollment isn’t open yet; when it opens, early-access businesses are set up first. Nothing is charged until you choose to sign up.' },
  { q: 'Is the AI on this page the real product?', a: 'The conversations are scripted examples with made-up businesses, so nothing you click is sent, booked or stored. They follow the same behaviour as the real AI receptionist: facts from the customer’s words, the service-area check, questions one at a time, real calendar times, and a booking only after a clear yes.' },
  { q: 'Will the AI say things I didn’t approve?', a: 'No. It only uses your records: services, prices, towns, ZIP codes, hours and the notes you approve. Prices that aren’t in your records are never stated. Guarantees, discounts or credentials never appear unless you’ve written them down.' },
  { q: 'Can I control how it handles my customers?', a: 'Yes, in pilot: you can write and test rules today, and we switch them on for live conversations business by business. Teach Your AI lets you set the order of questions, what’s required before times are offered, services you don’t do, which towns you serve completely, urgent situations, hand-offs and tone. Some protections can’t be switched off: the area check, the customer’s yes before a booking, and safety advice when danger is described.' },
  { q: 'What if someone asks for a person?', a: 'The AI says plainly that it can’t transfer the call, then records a callback request or a message with their name and number. It shows up in your dashboard under Needs attention. It never promises when someone will call.' },
  { q: 'Do I need any other software?', a: 'Just a Google account with the calendar you book appointments on. If you already use GoHighLevel, a connection that copies your leads into your pipeline is in testing with founding customers.' },
  { q: 'Which integrations are limited or coming soon?', a: 'Google Calendar works today; while Google reviews our app, you may see a notice that Google hasn’t verified it when you connect. Google Ads: limited, test accounts only. Facebook and Instagram ads: coming soon. GoHighLevel: in testing. Text messaging: coming soon.' },
  { q: 'Can I use my own domain? What if I cancel?', a: 'Yes. Your website works on a free GetShowUps address, and you can connect a domain you own from your dashboard. Your domain always stays yours. If you cancel, your website stays online until the end of the period you paid for plus 14 days, you can download your text and photos, and you can point your domain anywhere else.' },
  { q: 'What does it cost?', a: 'Growth is $499 a month, billed monthly with no setup fee and no free trial. You can cancel any time from your billing page. Advertising spend, if you run ads, is paid directly to Google or Meta. Enterprise, for organizations that run many businesses, starts at $10,000 a month and is priced by agreement: use Contact sales under Pricing.' },
  { q: 'When will text messages work?', a: 'Business texting in the US requires A2P 10DLC registration and consent from the people you message. Text messaging is coming soon; until then, every booking is confirmed with a Google Calendar invitation.' },
]
