// Marketing copy lives here so it can be edited without touching layout code.
// Rule: no testimonials, customer logos, or performance statistics until real data exists.

export const navLinks = [
  { href: '#how-it-works', label: 'How it works' },
  { href: '#features', label: 'Features' },
  { href: '#pricing', label: 'Pricing' },
  { href: '#faq', label: 'FAQ' },
]

// Primary call to action: start the founding plan (sign in with Google → business → Stripe Checkout).
export const getStarted = { href: '/dashboard?plan=founding', label: 'Get started' }

// Steps and features describe only what works today; anything not yet live says so.
export const steps = [
  {
    id: 'capture',
    title: 'Capture',
    icon: 'inbox',
    body: 'Your own landing page and booking form collect every inquiry in one place, so no lead sits unseen in an inbox.',
  },
  {
    id: 'qualify',
    title: 'Qualify',
    icon: 'sparkles',
    body: 'Leads outside the area you serve are flagged before they can book, so your calendar only fills with jobs you want.',
  },
  {
    id: 'book',
    title: 'Book',
    icon: 'calendar',
    body: 'Leads pick a real open time from your Google Calendar. No phone tag, and a time can never be booked twice.',
  },
  {
    id: 'remind',
    title: 'Remind',
    icon: 'bell',
    body: 'Confirmation and reminder emails with a one-tap “I’ll be there”. Text reminders are coming soon.',
  },
  {
    id: 'show',
    title: 'Show Up',
    icon: 'check',
    body: 'Mark each appointment as showed or no-show and see exactly where leads drop off.',
  },
  {
    id: 'follow',
    title: 'Follow Up',
    icon: 'refresh',
    body: 'Leads who don’t book get a follow-up, and no-shows get an easy way to pick a new time.',
  },
]

export const features = [
  {
    icon: 'bolt',
    title: 'Live in minutes',
    body: 'Answer a few questions and GetShowUps drafts your landing page from your services and service area. You review it and publish.',
  },
  {
    icon: 'calendar',
    title: 'Real-time booking',
    body: 'Customers book straight into your Google Calendar using your hours and appointment length. Busy times are hidden automatically.',
  },
  {
    icon: 'sparkles',
    title: 'Service-area screening',
    body: 'Tell us the ZIP codes you serve and every lead is checked before booking.',
  },
  {
    icon: 'bell',
    title: 'Confirmations & reminders',
    body: 'Email confirmations, reminders and follow-ups that stop as soon as a lead books. Text messages are coming soon.',
  },
  {
    icon: 'chart',
    title: 'Show-up tracking',
    body: 'See leads, bookings, confirmations, show-ups and no-shows in one simple dashboard.',
  },
  {
    icon: 'phoneMissed',
    title: 'Ads, when you’re ready',
    body: 'Google and Meta ad campaigns are coming for founding customers. You approve every dollar, and ad spend is paid directly to Google or Meta.',
  },
]

export const pricing = {
  name: 'Founding plan',
  price: 499,
  period: 'month',
  badge: 'Founding customers',
  note: 'Billed monthly. No free trial, no setup fee, cancel any time from your billing page.',
  includes: [
    'Your own landing page, ready in minutes',
    'Online booking straight into your Google Calendar',
    'Service-area screening for every lead',
    'Email confirmations, reminders and follow-ups',
    'Show-up and no-show tracking',
    'Direct help from the founding team',
  ],
  excludes: 'Advertising spend is separate and paid directly to Google or Meta. Text messaging and ad management are coming soon for founding customers.',
}

export const faqs = [
  {
    q: 'What is GetShowUps?',
    a: 'GetShowUps is an appointment conversion platform for service businesses. It responds to new leads, qualifies them, books them onto your calendar, reminds them, and tracks whether they actually showed up — then follows up either way.',
  },
  {
    q: 'Who is it for?',
    a: 'Appointment-driven service businesses: home services, dental and medical practices, med spas, salons, fitness studios, legal and financial consultations, and similar teams that live or die by booked, attended appointments.',
  },
  {
    q: 'Do I need any other software?',
    a: 'Just a Google account with the calendar you book appointments on. If you already use GoHighLevel, a connection that copies your leads into your pipeline is in testing with founding customers.',
  },
  {
    q: 'Will my page say things I didn’t approve?',
    a: 'No. Your landing page is drafted from what you tell us and stays private until you publish it. Promises like guarantees, discounts, ratings or credentials are never added unless you’ve confirmed them.',
  },
  {
    q: 'What does it cost?',
    a: 'The founding plan is $499 a month, billed monthly with no setup fee and no free trial. You can cancel any time from your billing page. Advertising spend, if you run ads, is paid directly to Google or Meta.',
  },
  {
    q: 'When will text messages work?',
    a: 'Business texting in the US requires A2P 10DLC registration and consent from the people you message. Text messaging is coming soon; until then, confirmations and reminders go by email.',
  },
]
