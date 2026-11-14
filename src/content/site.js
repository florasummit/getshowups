// Marketing copy lives here so it can be edited without touching layout code.
// Rule: no testimonials, customer logos, or performance statistics until real data exists.

export const navLinks = [
  { href: '#how-it-works', label: 'How it works' },
  { href: '#features', label: 'Features' },
  { href: '#simulation', label: 'Simulation' },
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
    body: 'Your own website, with booking built in, collects every inquiry in one place, so no lead sits unseen in an inbox.',
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
    body: 'Every booking sends the customer a Google Calendar invitation. Email and text reminders are coming soon.',
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
    body: 'Leads who haven’t booked and no-shows are listed for you to follow up. Automatic follow-ups are coming soon.',
  },
]

export const features = [
  {
    icon: 'bolt',
    title: 'Your website, done for you',
    body: 'Answer a few questions and GetShowUps builds a mobile-friendly website from your services and service area. Preview it, edit anything, and publish. Hosting included.',
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
    body: 'Every booking sends the customer a Google Calendar invitation. Email reminders and follow-ups, and text messages, are coming soon.',
  },
  {
    icon: 'chart',
    title: 'Show-up tracking',
    body: 'See leads, bookings, show-ups and no-shows (or completed jobs for on-site visits) in one simple dashboard.',
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
    'A professional website, built and hosted for you',
    'Use your GetShowUps address or connect your own domain',
    'Online booking straight into your Google Calendar',
    'Service-area screening for every lead',
    'Google Calendar invitations for every booking',
    'Show-up and no-show tracking',
    'Direct help from the founding team',
  ],
  excludes: 'Advertising spend is separate and paid directly to Google or Meta. Text messaging, email reminders and ad management are coming soon for founding customers.',
}

export const faqs = [
  {
    q: 'What is GetShowUps?',
    a: 'GetShowUps is an appointment conversion platform for service businesses. It gives you a website that captures leads, checks they are in your service area, books them onto your Google Calendar, and tracks whether they actually showed up. Automatic reminders and follow-ups are coming soon.',
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
    q: 'Will my website say things I didn’t approve?',
    a: 'No. Your website is drafted from what you tell us and stays private until you publish it. Promises like guarantees, discounts, ratings or credentials are never added unless you’ve confirmed them.',
  },
  {
    q: 'Can I use my own domain? What if I cancel?',
    a: 'Yes. Your website works on a free GetShowUps address, and you can connect a domain you own (like www.yourbusiness.com) from your dashboard. Your domain always stays yours. If you cancel, your website stays online until the end of the period you paid for plus 14 days, you can download your text and photos, and you can point your domain anywhere else.',
  },
  {
    q: 'What does it cost?',
    a: 'The founding plan is $499 a month, billed monthly with no setup fee and no free trial. You can cancel any time from your billing page. Advertising spend, if you run ads, is paid directly to Google or Meta.',
  },
  {
    q: 'When will text messages work?',
    a: 'Business texting in the US requires A2P 10DLC registration and consent from the people you message. Text messaging is coming soon; until then, every booking is confirmed with a Google Calendar invitation.',
  },
]
