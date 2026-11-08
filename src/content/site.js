// Marketing copy lives here so it can be edited without touching layout code.
// Rule: no testimonials, customer logos, or performance statistics until real data exists.

export const navLinks = [
  { href: '#how-it-works', label: 'How it works' },
  { href: '#features', label: 'Features' },
  { href: '#simulation', label: 'Simulation' },
  { href: '#pricing', label: 'Pricing' },
  { href: '#faq', label: 'FAQ' },
]

export const steps = [
  {
    id: 'capture',
    title: 'Capture',
    icon: 'inbox',
    body: 'Web forms, ads, calls, and texts land in one pipeline, so no inquiry sits unseen in an inbox.',
  },
  {
    id: 'qualify',
    title: 'Qualify',
    icon: 'sparkles',
    body: 'An AI assistant asks your screening questions by text and routes good-fit leads forward.',
  },
  {
    id: 'book',
    title: 'Book',
    icon: 'calendar',
    body: 'Qualified leads pick a real open slot from your calendar without a phone-tag back-and-forth.',
  },
  {
    id: 'remind',
    title: 'Remind',
    icon: 'bell',
    body: 'Timed SMS and email reminders confirm the appointment and make rescheduling easy.',
  },
  {
    id: 'show',
    title: 'Show Up',
    icon: 'check',
    body: 'Mark each appointment as showed or no-show so you can see exactly where leads drop off.',
  },
  {
    id: 'follow',
    title: 'Follow Up',
    icon: 'refresh',
    body: 'No-shows get a reschedule path, and completed visits get a next-step or review request.',
  },
]

export const features = [
  {
    icon: 'bolt',
    title: 'Instant lead response',
    body: 'Every new inquiry gets a personalized text right away — including nights and weekends when your front desk is closed.',
  },
  {
    icon: 'sparkles',
    title: 'AI qualification',
    body: 'Configure the questions that matter to your business. The assistant collects answers conversationally and flags leads that need a human.',
  },
  {
    icon: 'calendar',
    title: 'Appointment scheduling',
    body: 'Leads book directly into your availability, with buffers, service types, and staff calendars respected.',
  },
  {
    icon: 'bell',
    title: 'SMS & email reminders',
    body: 'Confirmation and reminder sequences you control — timing, wording, and channel — with one-tap confirm or reschedule.',
  },
  {
    icon: 'phoneMissed',
    title: 'Missed-call follow-up',
    body: 'When a call goes unanswered, the caller gets a text back so the conversation continues instead of going to a competitor.',
  },
  {
    icon: 'chart',
    title: 'Show-up tracking',
    body: 'See booked, confirmed, showed, and no-show counts for every lead source, so you know which channels actually produce visits.',
  },
]

export const pricing = {
  name: 'Introductory plan',
  price: 299,
  period: 'month',
  badge: 'Proposed pricing',
  note: 'This is proposed introductory pricing and may change before launch. Final terms will be confirmed with you during your demo.',
  includes: [
    'Instant SMS response to new leads',
    'AI qualification flow tailored to your services',
    'Online booking into your calendar',
    'SMS & email reminder sequences',
    'Missed-call text-back',
    'Show-up and no-show tracking',
    'Guided setup during onboarding',
  ],
  excludes: 'Carrier SMS fees and A2P 10DLC registration costs may be billed separately.',
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
    q: 'Does it work with GoHighLevel?',
    a: 'Yes — GetShowUps is being built on GoHighLevel. If you already use GHL, we can work within your existing sub-account. If you don’t, we set up the account as part of onboarding.',
  },
  {
    q: 'Is the AI going to say things I didn’t approve?',
    a: 'You approve the qualification questions, tone, and boundaries during setup. Conversations that fall outside those boundaries are handed off to your team instead of being improvised.',
  },
  {
    q: 'Is $299/month the final price?',
    a: 'No. $299/month is proposed introductory pricing and may change. We’ll confirm current pricing and what’s included on your demo call before you commit to anything.',
  },
  {
    q: 'What do I need for SMS to work?',
    a: 'Business texting in the US requires A2P 10DLC registration and consent from the people you message. We’ll walk through what your business needs during the demo.',
  },
  {
    q: 'Is the simulation on this page real?',
    a: 'No. The interactive simulation uses a fictional business and scripted messages to illustrate the workflow. Nothing in it is sent, stored, or connected to a live system.',
  },
]
