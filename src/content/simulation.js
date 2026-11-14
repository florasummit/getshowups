// Scripted, fictional scenarios for the on-page simulation.
// Businesses, people, and phone numbers (555-01xx is reserved for fiction) are made up.

export const stageNotes = {
  capture: {
    what: 'A new lead arrives. The clock starts now — the first reply goes out before anyone on your team has to touch it.',
    today: 'Website and booking-page requests arrive as leads in your dashboard. Instant text replies, including after a missed call, are coming soon.',
  },
  qualify: {
    what: 'The assistant asks only the screening questions you approved and records the answers on the contact.',
    today: 'Every lead is checked against the ZIP codes you serve before it can book. Screening questions by text are coming soon.',
  },
  book: {
    what: 'Good-fit leads are offered real open times. Once they choose, the appointment lands on your calendar.',
    today: 'Live: leads pick a real open time from your Google Calendar, and the visit is added to your calendar.',
  },
  remind: {
    what: 'Reminders go out on your schedule, with an easy way to confirm or reschedule instead of silently not showing.',
    today: 'Email confirmation and reminders with a one-tap “I’ll be there”. Text reminders are coming soon.',
  },
  show: {
    what: 'Your team marks the outcome, so show-up tracking reflects what actually happened.',
    today: 'Live: mark each appointment as showed or no-show (or visit done and job completed) in your dashboard.',
  },
  follow: {
    what: 'The next step depends on the outcome: rebook no-shows, nurture completed visits.',
    today: 'Leads who don’t book get an email follow-up, and no-shows get an easy way to pick a new time. Texts are coming soon.',
  },
}

export const scenarios = [
  {
    id: 'form',
    label: 'Web form lead',
    business: 'Northside Plumbing',
    contact: 'Jordan',
    events: [
      { stage: 'capture', day: 'Monday', time: '9:42 PM', from: 'system', text: 'New lead: Jordan R. submitted “Request service” — water heater not heating.' },
      { stage: 'capture', time: '9:42 PM', from: 'bot', text: 'Hi Jordan, this is the Northside Plumbing assistant. Thanks for reaching out about your water heater! Mind if I ask two quick questions so we send the right tech?' },
      { stage: 'qualify', time: '9:44 PM', from: 'lead', text: 'Sure' },
      { stage: 'qualify', time: '9:44 PM', from: 'bot', text: 'Is it gas or electric, and is any water leaking right now?' },
      { stage: 'qualify', time: '9:45 PM', from: 'lead', text: 'Gas. No leak, just no hot water.' },
      { stage: 'qualify', time: '9:45 PM', from: 'system', text: 'Qualified · in service area · water heater repair · standard urgency' },
      { stage: 'book', time: '9:45 PM', from: 'bot', text: 'Thanks! I can get a technician out tomorrow at 9:00 AM or 1:30 PM. Which works better?' },
      { stage: 'book', time: '9:46 PM', from: 'lead', text: '1:30 works' },
      { stage: 'book', time: '9:46 PM', from: 'system', text: 'Booked · Tue 1:30 PM · Water heater diagnostic' },
      { stage: 'remind', day: 'Tuesday', time: '9:00 AM', from: 'bot', text: 'Reminder: your Northside Plumbing visit is today at 1:30 PM. Reply C to confirm or R to reschedule.' },
      { stage: 'remind', time: '9:07 AM', from: 'lead', text: 'C' },
      { stage: 'show', time: '2:41 PM', from: 'system', text: 'Technician marked the appointment as Showed.' },
      { stage: 'follow', time: '3:15 PM', from: 'bot', text: 'Thanks for choosing Northside Plumbing, Jordan! If anything else comes up, just reply to this text.' },
    ],
  },
  {
    id: 'missed',
    label: 'Missed call',
    business: 'Lakeview Family Dental',
    contact: 'Sam',
    events: [
      { stage: 'capture', day: 'Wednesday', time: '12:18 PM', from: 'system', text: 'Missed call from (555) 010-0147 — front desk at lunch.' },
      { stage: 'capture', time: '12:18 PM', from: 'bot', text: 'Hi, this is Lakeview Family Dental — sorry we missed your call! How can we help? You can reply right here.' },
      { stage: 'qualify', time: '12:21 PM', from: 'lead', text: 'Looking for a cleaning. I’m a new patient.' },
      { stage: 'qualify', time: '12:21 PM', from: 'bot', text: 'Welcome! Do you have dental insurance you’d like us to check, and are you having any pain right now?' },
      { stage: 'qualify', time: '12:23 PM', from: 'lead', text: 'Delta Dental, no pain' },
      { stage: 'qualify', time: '12:23 PM', from: 'system', text: 'Qualified · new patient · exam & cleaning · insurance noted for staff to verify' },
      { stage: 'book', time: '12:23 PM', from: 'bot', text: 'Great. Our next new-patient openings are Thu 8:00 AM or Fri 3:30 PM.' },
      { stage: 'book', time: '12:24 PM', from: 'lead', text: 'Friday' },
      { stage: 'book', time: '12:24 PM', from: 'system', text: 'Booked · Fri 3:30 PM · New patient exam & cleaning' },
      { stage: 'remind', day: 'Thursday', time: '3:30 PM', from: 'bot', text: 'Hi Sam, see you tomorrow at 3:30 PM at Lakeview Family Dental. Reply C to confirm or R to reschedule.' },
      { stage: 'remind', time: '3:52 PM', from: 'lead', text: 'R — something came up' },
      { stage: 'remind', time: '3:52 PM', from: 'bot', text: 'No problem! How about Mon 10:00 AM or Tue 4:00 PM?' },
      { stage: 'remind', time: '3:53 PM', from: 'lead', text: 'Tue' },
      { stage: 'remind', time: '3:53 PM', from: 'system', text: 'Rescheduled · Tue 4:00 PM · reminder sequence restarted' },
      { stage: 'show', day: 'Next Tuesday', time: '4:05 PM', from: 'system', text: 'Front desk marked the appointment as Showed.' },
      { stage: 'follow', time: '5:30 PM', from: 'bot', text: 'Thanks for visiting, Sam! When you’re ready, reply here to book your six-month cleaning.' },
    ],
  },
]
