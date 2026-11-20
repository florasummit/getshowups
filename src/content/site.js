// Marketing copy lives here so it can be edited without touching layout code.
// Rule: no testimonials, customer logos, or performance statistics until real data exists. Every claim below
// describes what works in production today; anything else says "coming soon" or "pilot".

export const navLinks = [
  { href: '#demo', label: 'See it work' },
  { href: '#how-it-works', label: 'How it works' },
  { href: '#teach', label: 'Teach Your AI' },
  { href: '#pricing', label: 'Pricing' },
  { href: '#faq', label: 'FAQ' },
]

// Primary call to action: start the founding plan (sign in with Google → business → Stripe Checkout).
export const getStarted = { href: '/dashboard?plan=founding', label: 'Get started' }
// While online enrollment isn't open (GET /api/enrollment), every "Get started" becomes this, so visitors know before
// they sign in with Google. Existing accounts, invitations and testers still use "Sign in".
export const enrollmentClosed = {
  href: '/#book-demo',
  label: 'Request early access',
  note: 'Online enrollment isn’t open yet. Book a short call and we’ll set you up as soon as it opens.',
  next: [
    'Pick a time for a short call. The calendar here books it directly; there’s no form to fill in first.',
    'On the call we look at your services, service area and current website, and answer your questions.',
    'When enrollment opens, we set you up first. Nothing is charged before you choose to sign up.',
  ],
}

export const hero = {
  eyebrow: 'AI booking for pool, HVAC and roofing businesses',
  sub: 'Your customers write in. GetShowUps understands the request, checks it against your area and your rules, asks only for what’s missing, and books a real open time on your calendar.',
}

// The friction GetShowUps removes. Plain observations, not statistics.
export const problem = {
  title: 'The inquiries you answer late are the jobs you don’t get',
  items: [
    { title: 'Messages arrive while you’re on a job', body: 'A pool that turned green, an AC that quit, a roof after a storm: the person asking is already looking for who answers first.' },
    { title: 'Every reply is the same ten questions', body: 'Where are you? What’s wrong? When works? Is it urgent? You’ve typed them a thousand times, usually from a truck.' },
    { title: 'Nothing connects the dots', body: 'The lead is in a text, the time is in your head, the address is in an email, and the calendar is somewhere else.' },
  ],
}

// Attract → Answer → Qualify → Book → Notify → Measure. Each says only what is live (status: live | partly | soon).
export const journey = [
  { id: 'attract', status: 'live', title: 'Attract', body: 'A professional website, built and hosted for you, with booking and chat built in. Use your GetShowUps address or your own domain.' },
  { id: 'answer', status: 'live', title: 'Answer', body: 'The AI receptionist replies on your website in seconds, in your words, using only your services, prices, area and hours.' },
  { id: 'qualify', status: 'live', title: 'Qualify', body: 'It checks the service area before offering times, follows the questions you set, and never invents a price or a promise.' },
  { id: 'book', status: 'live', title: 'Book', body: 'Real open times from your Google Calendar, booked only after the customer’s own yes. A time can never be booked twice.' },
  { id: 'notify', status: 'live', title: 'Notify', body: 'The visit lands on your calendar with the address; Google invites the customer; callback requests show up in Needs attention.' },
  { id: 'measure', status: 'live', title: 'Measure', body: 'Every inquiry, booking, show-up and finished job in one place, so you can see where leads come from and where they drop.' },
]

export const journeyNotes = 'Text messaging, email reminders and automatic follow-ups are built and in testing, not live yet. Voice calls on your website are in a pilot. We say so everywhere they come up.'

// Teach Your AI (released 2026-11-20 as a controlled pilot: the Studio is on for the first pilot business; published
// rules reach live conversations only once GetShowUps switches that on per business).
export const teach = {
  title: 'Your AI, your rules',
  sub: 'Teach Your AI is where you decide how it works: the questions it asks, in what order, what you don’t offer, which towns you serve completely, what counts as urgent, and when to hand off to you.',
  points: [
    ['Describe a change in plain words', '“Ask what the customer needs before asking where they live.” You see exactly what would change before anything is saved.'],
    ['Test it before customers see it', 'Type what a customer might say and watch what the AI understands and does next. Nothing is sent or booked.'],
    ['Publish when you’re ready', 'Every version is kept. Go back to an earlier one in one click.'],
    ['Some rules are always on', 'Your area is checked before times, bookings need the customer’s yes, danger means 911 first, prices come only from your records.'],
  ],
  status: 'In pilot with founding customers',
}

export const industries = [
  { id: 'pool', title: 'Pool service', body: 'Green pools, pump noise, weekly care. The AI knows the difference, confirms the area by town where you serve it completely, and books the visit at the customer’s address.' },
  { id: 'hvac', title: 'HVAC', body: 'No cooling in July isn’t a tune-up. Your AI can be told to settle urgency first, get the soonest time for the ones that can’t wait, and flag you.' },
  { id: 'roofing', title: 'Roofing', body: 'Storm damage means an inspection first and a person for the estimate. The AI books the look, records the callback, and never quotes a roof.', upcoming: true },
]

export const pricing = {
  name: 'Founding plan',
  price: 499,
  period: 'month',
  badge: 'Founding customers',
  note: 'Billed monthly. No free trial, no setup fee, cancel any time from your billing page.',
  includes: [
    'A professional website, built and hosted for you',
    'Use your GetShowUps address or connect your own domain',
    'AI receptionist on your website chat',
    'Online booking straight into your Google Calendar',
    'Service-area screening for every lead',
    'Teach Your AI: your questions, rules and hand-offs',
    'Google Calendar invitations for every booking',
    'Show-up and no-show tracking',
    'Direct help from the founding team',
  ],
  excludes: 'Advertising spend is separate and paid directly to Google or Meta. Text messaging, email reminders and ad management are coming soon for founding customers.',
}

export const faqs = [
  { q: 'What happens after I request early access?', a: 'You pick a time for a short call, straight from the calendar on this page. We look at your services, service area and current website together. Online enrollment isn’t open yet; when it opens, early-access businesses are set up first. Nothing is charged until you choose to sign up.' },
  { q: 'Is the AI on this page the real product?', a: 'The conversations are scripted examples with made-up businesses, so nothing you click is sent, booked or stored. They follow the same behaviour as the real AI receptionist: facts from the customer’s words, the service-area check, questions one at a time, real calendar times, and a booking only after a clear yes.' },
  { q: 'Will the AI say things I didn’t approve?', a: 'No. It only uses your records: services, prices, towns, ZIP codes, hours and the notes you approve. Prices that aren’t in your records are never stated. Guarantees, discounts or credentials never appear unless you’ve written them down.' },
  { q: 'Can I control how it handles my customers?', a: 'Yes. Teach Your AI lets you set the order of questions, what’s required before times are offered, services you don’t do, which towns you serve completely, urgent situations, hand-offs and tone. Some protections can’t be switched off: the area check, the customer’s yes before a booking, and safety advice when danger is described.' },
  { q: 'What if someone asks for a person?', a: 'The AI says plainly that it can’t transfer the call, then records a callback request or a message with their name and number. It shows up in your dashboard under Needs attention. It never promises when someone will call.' },
  { q: 'Do I need any other software?', a: 'Just a Google account with the calendar you book appointments on. If you already use GoHighLevel, a connection that copies your leads into your pipeline is in testing with founding customers.' },
  { q: 'Can I use my own domain? What if I cancel?', a: 'Yes. Your website works on a free GetShowUps address, and you can connect a domain you own from your dashboard. Your domain always stays yours. If you cancel, your website stays online until the end of the period you paid for plus 14 days, you can download your text and photos, and you can point your domain anywhere else.' },
  { q: 'What does it cost?', a: 'The founding plan is $499 a month, billed monthly with no setup fee and no free trial. You can cancel any time from your billing page. Advertising spend, if you run ads, is paid directly to Google or Meta.' },
  { q: 'When will text messages work?', a: 'Business texting in the US requires A2P 10DLC registration and consent from the people you message. Text messaging is coming soon; until then, every booking is confirmed with a Google Calendar invitation.' },
]
