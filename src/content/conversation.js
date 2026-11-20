// The AI conversation simulation (components/Conversation.jsx): scripted, deterministic, offline. Every line is a
// fictional example; nothing is sent, booked, stored or paid for. The scripts follow what the AI receptionist does in
// production today (server/receptionist/, server/intelligence/, verified 2026-11-20): facts recognized from the
// customer's words, the service area checked before times, missing details asked one at a time, real open times from
// the business's calendar (illustrative here), a booking only after a clear yes, a callback request when a person is
// needed (no live transfer exists), and safety advice first when danger is described.
//
// Owner-set rules come from Teach Your AI (Dashboard → Teach Your AI). Roofing is an upcoming vertical: its script
// shows the same engine with a roofing business's records; the industry playbook for roofing isn't shipped yet.

// Each scenario: the customer's lines (visitors send them in order), and for each one what the AI recognized
// (chips), the rule or check that applied, and its reply. `facts` accumulate across the conversation.
export const SCENARIOS = [
  {
    id: 'pool',
    label: 'Pool service',
    business: 'Tidewater Pools',
    rulesNote: 'Tidewater marked Mount Pleasant as fully served, so no ZIP is needed to confirm the area.',
    turns: [
      {
        customer: 'My pool is green. I’m in Mount Pleasant and need someone Friday.',
        recognized: [
          ['Service', 'Green pool cleanup'],
          ['Area', 'Mount Pleasant ✓ fully served'],
          ['Day', 'Friday'],
        ],
        check: 'Area confirmed by town · Still needed: name, phone, address',
        reply: 'Got it — a green pool in Mount Pleasant, and you’d like Friday. You’re in our service area. What’s your name and the best number to reach you?',
      },
      {
        customer: 'Jamie Rivera, 843-555-0142.',
        recognized: [
          ['Name', 'Jamie Rivera'],
          ['Phone', '(843) 555-0142'],
        ],
        check: 'Phone digits match what Jamie said · Still needed: service address',
        reply: 'Thanks, Jamie. What’s the address for the visit?',
      },
      {
        customer: '14 Harbor Oak Lane, Mount Pleasant 29464.',
        recognized: [
          ['Address', '14 Harbor Oak Lane'],
          ['ZIP', '29464 ✓ on the list'],
        ],
        check: 'Everything needed to book is known · Checking the calendar for Friday',
        reply: 'Let me check the calendar. Friday I have 10:30 AM or 1:00 PM for a green pool cleanup at 14 Harbor Oak Lane. Which works?',
        offers: ['Fri 10:30 AM', 'Fri 1:00 PM'],
      },
      {
        customer: '10:30 works. Yes, book it.',
        recognized: [['Confirmed', 'Friday 10:30 AM — “yes, book it”']],
        check: 'Booked only after a clear yes · On the calendar · Owner notified',
        reply: 'You’re booked for Friday at 10:30 AM. Tidewater Pools has the address and your number. See you then!',
        done: 'booked',
      },
    ],
  },
  {
    id: 'hvac',
    label: 'HVAC',
    business: 'Lowcountry Air',
    rulesNote: 'Lowcountry Air asks whether it’s urgent before offering times, and treats “no cooling” as urgent.',
    turns: [
      {
        customer: 'My AC stopped cooling and it’s 90 degrees inside.',
        recognized: [
          ['Problem', 'AC not cooling'],
          ['Urgency', 'Possibly urgent'],
        ],
        check: 'Owner rule: know urgency before offering times · Area not known yet',
        reply: 'Sorry about that — 90 degrees is no fun. Is anyone unwell in the heat, or is this something that can wait until tomorrow? And what’s your ZIP code?',
      },
      {
        customer: 'My mom is 82 and she’s here with me. We’re in 29483.',
        recognized: [
          ['Urgency', 'Urgent — vulnerable person in the heat'],
          ['ZIP', '29483 ✓ on the list'],
        ],
        check: 'Owner rule: urgent → soonest time and an urgent callback request',
        reply: 'Understood, let’s get someone out today. I’ve flagged this as urgent for the team. The soonest I have is 3:00 PM this afternoon — shall I hold it? And what’s your name and number?',
        offers: ['Today 3:00 PM'],
      },
      {
        customer: 'Please. Dana Price, 843-555-0190.',
        recognized: [
          ['Name', 'Dana Price'],
          ['Phone', '(843) 555-0190'],
          ['Confirmed', 'Today 3:00 PM — “please”'],
        ],
        check: 'Booked after a clear yes · Urgent callback recorded for the owner',
        reply: 'Done — 3:00 PM today, and the team has an urgent note with your number. Keep your mom cool and hydrated until then.',
        done: 'booked_urgent',
      },
    ],
  },
  {
    id: 'roofing',
    label: 'Roofing',
    upcoming: true,
    business: 'Palmetto Roofing',
    rulesNote: 'Palmetto hands storm claims to a person: an inspection is booked, and a callback is recorded for the estimate.',
    turns: [
      {
        customer: 'A storm damaged my roof. Can someone inspect it?',
        recognized: [
          ['Request', 'Roof inspection'],
          ['Cause', 'Storm damage'],
        ],
        check: 'Area not known yet · Owner rule: storm damage → inspection + callback',
        reply: 'Sorry to hear that. We can come and take a look. Is any water coming in right now, and what’s the ZIP code at the property?',
      },
      {
        customer: 'No leaks yet, just missing shingles. 29401, downtown Charleston.',
        recognized: [
          ['Urgency', 'Not urgent — no water inside'],
          ['ZIP', '29401 ✓ on the list'],
        ],
        check: 'Area confirmed · Inspection can be booked · Estimate needs a person',
        reply: 'Good — then it can wait for a proper inspection. I can book one for tomorrow at 9:00 AM or Thursday at 2:00 PM. Which suits you? A roofer will give you the estimate on site.',
        offers: ['Tomorrow 9:00 AM', 'Thu 2:00 PM'],
      },
      {
        customer: 'Thursday at 2 is fine. I’m Sam Okafor, 843-555-0177.',
        recognized: [
          ['Name', 'Sam Okafor'],
          ['Phone', '(843) 555-0177'],
          ['Confirmed', 'Thursday 2:00 PM'],
        ],
        check: 'Inspection booked · Callback request recorded for the estimate',
        reply: 'Booked: Thursday at 2:00 PM for a storm-damage inspection. I’ve also left a note for the team to call you about the estimate. Anything else I can help with?',
        done: 'booked_callback',
      },
    ],
  },
]

export const DONE = {
  booked: { label: 'Booked on the calendar', tone: 'ok' },
  booked_urgent: { label: 'Booked today · urgent callback recorded', tone: 'ok' },
  booked_callback: { label: 'Inspection booked · callback recorded', tone: 'ok' },
}

// What the owner sees afterwards (the dashboard's real labels: summary from recorded facts, actions as event codes).
export const ownerView = (s) => ({
  booked: ['Booked', 'Fri 10:30 AM · Green pool cleanup · 14 Harbor Oak Lane', ['Noted the customer’s details', 'Checked your service area', 'Looked up open times on your calendar', 'Booked the appointment']],
  booked_urgent: ['Booked · Needs attention', 'Today 3:00 PM · AC not cooling · urgent', ['Noted the customer’s details', 'Applied your rule: urgency first', 'Recorded an urgent callback request', 'Booked the appointment']],
  booked_callback: ['Booked · Callback requested', 'Thu 2:00 PM · Roof inspection · storm damage', ['Noted the customer’s details', 'Checked your service area', 'Booked the inspection', 'Recorded a callback request']],
}[s])

export const CONVERSATION_EVENT = 'gsu:conversation-industry'
