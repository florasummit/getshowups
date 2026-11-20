// The homepage product demo: configuration only (one renderer in components/Demo.jsx).
// Everything here is a fictional example. Businesses, people, addresses and times are made up; the 555-01xx phone
// range is reserved for fiction; example.com addresses never deliver. The demo calls no API and stores nothing.
//
// The journey mirrors what the product does in production today (verified against the code, 2026-11-20):
//   booking page "What do you need?" + name/phone/email + ZIP (+ service address for visits) → the lead is saved before
//   a time is picked → ZIP checked against the owner's listed ZIPs (listed = bookable; not listed = kept as a lead,
//   "We may be able to help in your area", owner approves or declines) → open times from the owner's Google Calendar
//   and booking hours → booked on the calendar, Google emails the customer an invitation → the owner records how the
//   visit went (Job done / Visited, not done / Couldn't visit) and, optionally, their own estimate of the job value.
// Not shown as working because it isn't live: text messages, email reminders, automatic follow-ups, AI receptionist,
// ad management.

export const industries = [
  {
    id: 'pool',
    label: 'Pool service',
    business: 'Tidewater Pools',
    town: 'Mount Pleasant',
    zips: ['29464', '29466'],
    outsideZip: { zip: '29910', town: 'Bluffton' },
    street: '14 Harbor Oak Ln',
    visitMinutes: 60,
    times: ['8:00 AM', '10:30 AM', '1:00 PM', '3:30 PM'],
    requests: [
      { id: 'weekly', short: 'Weekly service', text: 'I need weekly pool service in Mount Pleasant.', value: 180 },
      { id: 'green', short: 'Green pool', text: 'My pool turned green after the storm. Can someone come clean it up?', value: 350 },
      { id: 'pump', short: 'Pump noise', text: 'The pool pump is making a grinding noise and the water isn’t circulating.', value: 240 },
    ],
  },
  {
    id: 'hvac',
    label: 'HVAC',
    business: 'Lowcountry Air',
    town: 'Summerville',
    zips: ['29483', '29485'],
    outsideZip: { zip: '29577', town: 'Myrtle Beach' },
    street: '207 Live Oak Dr',
    visitMinutes: 90,
    times: ['7:30 AM', '10:00 AM', '12:30 PM', '3:00 PM'],
    requests: [
      { id: 'cooling', short: 'AC not cooling', text: 'Our AC is running but the house won’t get below 80.', value: 320 },
      { id: 'tuneup', short: 'Seasonal tune-up', text: 'Looking to book a heating tune-up before winter.', value: 129 },
      { id: 'thermostat', short: 'New thermostat', text: 'I’d like a smart thermostat installed and wired.', value: 260 },
    ],
  },
  {
    id: 'electrical',
    label: 'Electrical',
    business: 'Bright Line Electric',
    town: 'North Charleston',
    zips: ['29405', '29406', '29420'],
    outsideZip: { zip: '29201', town: 'Columbia' },
    street: '58 Rivers Ave',
    visitMinutes: 60,
    times: ['8:30 AM', '11:00 AM', '1:30 PM', '4:00 PM'],
    requests: [
      { id: 'outlets', short: 'Dead outlets', text: 'Half the outlets in our kitchen stopped working.', value: 210 },
      { id: 'ev', short: 'EV charger', text: 'We need a Level 2 EV charger installed in the garage.', value: 900 },
      { id: 'panel', short: 'Panel check', text: 'The breaker panel keeps tripping. Can someone take a look?', value: 275 },
    ],
  },
]

// The hero's "Try it with…" buttons tell the demo which industry to show (window event, detail = industry id).
export const DEMO_INDUSTRY_EVENT = 'gsu:demo-industry'

export const customer = { first: 'Jordan', name: 'Jordan Lee', phone: '(555) 010-0142', email: 'jordan@example.com' }

// The four stages the demo walks through (each has a real counterpart in the product).
export const stages = [
  { id: 'inquiry', label: 'Inquiry' },
  { id: 'check', label: 'Service-area check' },
  { id: 'book', label: 'Booking' },
  { id: 'after', label: 'After the visit' },
]

// What the owner records after a visit (the product's labels for visits at the customer's address).
export const outcomes = [
  { id: 'done', label: 'Job done', tone: 'ok' },
  { id: 'not_done', label: 'Visited, not done', tone: 'warn' },
  { id: 'no_visit', label: 'Couldn’t visit', tone: 'bad' },
]

// Next three working days from `now` (Mon–Sat), as illustrative booking days.
export function demoDays(now = new Date()) {
  const out = []
  const d = new Date(now)
  d.setHours(12, 0, 0, 0)
  while (out.length < 3) {
    d.setDate(d.getDate() + 1)
    if (d.getDay() !== 0) out.push(new Date(d))
  }
  return out
}

export const dayLabel = (d, opts = { weekday: 'short', month: 'short', day: 'numeric' }) => d.toLocaleDateString('en-US', opts)
