// Owner help, written once and shown next to the setting or number it explains (components in dashboard/Help.jsx).
// Static: opening it never calls a model. Every sentence describes what the product does today.
// kind (numbers only): measured = counted from your records; reported = the ad platform's figure; recorded = you typed
// it; estimated = you estimated it. ask (results): suggested follow-ups, answerable from this text and the counts
// server/assist.js sends. example is never sent to the model: its numbers aren't the owner's.
export const HELP = {
  // ---- settings ----
  service_area: {
    title: 'Where you work',
    what: 'Whether customers come to you or you visit them, and the exact ZIP codes where people can book. No ZIP codes means you serve everyone.',
    why: 'It keeps you from driving to jobs you don’t want. People outside the list are kept as requests for you to answer; they never see times.',
    example: 'You list 29464 and 29466. Someone in 29412 leaves their details, and you decide whether to take the job.',
    next: 'List every ZIP you’d drive to without hesitating.',
  },
  hours: {
    title: 'Booking hours',
    what: 'The days and times customers may book, and how long an appointment takes.',
    why: 'Only times inside these hours that are also free on your Google Calendar are offered.',
    example: 'Monday to Friday, 9 to 5, 60 minutes: a 10:30 dentist visit on your calendar hides the times it overlaps.',
    next: 'Check the length first. Too short is the usual cause of running late.',
  },
  calendar: {
    title: 'Google Calendar',
    what: 'The calendar we check for free time and add bookings to.',
    why: 'Without it nobody can book. We see when you’re busy, never what your events say.',
    example: 'You block Friday afternoon for family. Customers simply don’t see those times.',
    next: 'If this says it needs reconnecting, do that first: bookings wait on it.',
  },
  website_details: {
    title: 'Details on your website',
    what: 'Phone, what you do, towns and a short description.',
    why: 'Your website, booking page and receptionist use these words. They never add facts you didn’t write.',
    example: '“Weekly pool care in Mount Pleasant” helps people know they’re in the right place.',
    next: 'Keep it plain: what you do, and where.',
  },
  policies: {
    title: 'What customers should know',
    what: 'Notes about preparing for the visit, and your cancellation rule.',
    why: 'They’re shown word for word on the booking page, so fewer visits are wasted.',
    example: '“Please unlock the side gate and keep pets inside.”',
    next: 'Add the one thing that most often goes wrong on arrival.',
  },
  reminders: {
    title: 'Reminders',
    what: 'A confirmation and reminders before the appointment.',
    why: 'People forget. Email sending is still being activated, and this card says whether messages go out yet. Google’s calendar invitation is sent either way.',
    example: 'A booked visit on Friday: a reminder the day before.',
    next: 'Leave it on.',
  },
  followups: {
    title: 'Follow-ups',
    what: 'People who contacted you, and where each conversation stands.',
    why: 'Most lost jobs are inquiries nobody answered in time.',
    example: '“Need you” means a person is waiting for your own reply.',
    next: 'Clear “Need you” once a day.',
  },
  receptionist: {
    title: 'AI receptionist',
    what: 'It answers customers on your website’s chat and voice from your own records.',
    why: 'It replies while you’re on a job, checks your area and offers real open times. It books only after a clear yes, and it can’t transfer calls.',
    example: 'A customer asks at 9 PM. It answers, offers two times, and the booking is on your calendar.',
    next: 'Try it yourself on your chat page before sharing it.',
  },
  // ---- results ----
  inquiries: { kind: 'measured', title: 'New inquiries', what: 'People who left their details in the last 30 days.', why: 'Every job starts here. Test records aren’t counted.', example: '12 inquiries and 9 bookings means 3 people to call back.', next: 'Low? Share your website or booking link in more places.', ask: ['How many inquiries became bookings?', 'What should I look at first?'] },
  booked: { kind: 'measured', title: 'Booked', what: 'Appointments on your calendar. Cancelled ones aren’t counted.', why: 'Compared with inquiries it shows whether people who ask actually book.', example: '9 of 12 inquiries booked.', next: 'If many ask but few book, check that your hours offer enough open times.', ask: ['How does this compare with my inquiries?', 'Could my hours be limiting bookings?'] },
  showed: { kind: 'measured', title: 'Show-ups and visits', what: 'Appointments you marked as happened.', why: 'A booking isn’t a visit until you say so, so this counts only what you record.', example: '9 booked, 7 marked as showed, 2 not marked yet.', next: 'Mark each appointment the same day.', ask: ['Do I have visits left to mark?', 'How does this compare with bookings?'] },
  show_rate: { kind: 'measured', title: 'Show-up rate', what: 'Of the appointments you marked, the share that happened.', why: 'It appears after 5 recorded outcomes, because a rate from two visits misleads.', example: '8 showed of 10 marked is 80%.', next: 'Low? Put clear instructions in “What customers should know”.', ask: ['How many no-shows did I have?', 'What should I change first?'] },
  completed: { kind: 'measured', title: 'Jobs completed', what: 'Visits where you marked the job done.', why: 'Arriving isn’t finishing. This is what earns money.', example: '7 visits, 6 jobs done.', next: 'Mark “Visited, not done” when you have to come back.', ask: ['Do I have visits left to mark?'] },
  // ---- ads ----
  ad_budget: {
    title: 'Monthly ad budget',
    what: 'The most you approve spending on ads in a month. Nothing can start without it.',
    why: 'It’s your ceiling. Google’s daily budget is an average: a busy day can cost up to twice it, but a month stays near 30 days’ worth. You pay the ad platform directly.',
    example: '$300 a month is about $10 a day. One day may cost $18, another $4.',
    next: 'Start with an amount you could lose without worry, then look at cost per booking.',
  },
  ad_spend: { kind: 'reported', title: 'Ad spend', what: 'What Google reports for your GetShowUps campaigns in this period.', why: 'Every cost below divides by it. “—” means nothing was reported yet. Test accounts never spend money.', example: '$120 in 30 days.', next: 'If it’s “—” with a running campaign, wait a day: reports arrive late.', ask: ['What did I get for this spend?'] },
  ad_leads: { kind: 'measured', title: 'Leads from ads', what: 'People whose visit carried your campaign’s own link.', why: 'We never guess. Someone who saw an ad and typed your address later is counted as untraced.', example: '10 leads, 6 traced to ads.', next: 'Compare it with untraced leads before judging a campaign.', ask: ['How many of these became bookings?', 'What counts as a lead from an ad?'] },
  qualified: { kind: 'measured', title: 'Qualified', what: 'Leads whose ZIP is on your list, or whose area you approved.', why: 'Leads you can’t serve cost the same as ones you can.', example: '10 leads, 7 in your area.', next: 'Many outside? Tighten the campaign’s ZIP codes.', ask: ['How many ZIP codes do I list?', 'What makes a lead qualified?'] },
  ad_clicks: { kind: 'reported', title: 'Clicks', what: 'Clicks Google reports on your GetShowUps ads.', why: 'A click is a visit, not a lead. Comparing the two shows whether visitors leave their details.', example: '40 clicks, 6 leads.', next: 'Many clicks but few leads? Check that your booking page offers open times.', ask: ['How many leads came from ads?'] },
  ad_booked: { kind: 'measured', title: 'Booked from ads', what: 'Appointments from leads traced to your ads. Cancelled ones aren’t counted. Cost each is ad spend divided by these bookings.', why: 'Cost per booking is the number to compare with what a job earns you.', example: '$120 ÷ 3 bookings = $40.', next: 'Wait for at least 10 leads before deciding anything.', ask: ['Do I have enough leads to judge this?', 'How does this compare with my leads?'] },
  ad_showed: { kind: 'measured', title: 'Showed up from ads', what: 'Visits from ad leads that you marked as happened. Cost each is ad spend divided by these visits.', why: 'It includes the cost of no-shows, so it’s closer to what a real visit costs.', example: '$120 ÷ 2 visits = $60.', next: 'Mark each visit the same day.', ask: ['Do I have visits left to mark?'] },
  outside_area: { kind: 'measured', title: 'Outside your service area', what: 'Leads whose ZIP isn’t on your list. They’re kept for your answer and never shown times.', why: 'Some may be jobs you’d take. They cost the same as leads inside your area.', example: '10 leads, 3 outside.', next: 'Answer them in Appointments.', ask: ['How many ZIP codes do I list?'] },
  cost_per_lead: { kind: 'measured', title: 'Cost per lead', what: 'Ad spend divided by leads from ads.', why: 'Useful for comparing campaigns, not for judging profit.', example: '$120 ÷ 6 leads = $20.', next: 'Look at cost per booking before changing a budget.', ask: ['Why isn’t this enough to judge profit?'] },
  cost_per_booking: { kind: 'measured', title: 'Cost per booking', what: 'Ad spend divided by bookings from those leads.', why: 'The number to compare with what a job earns you.', example: '$120 ÷ 3 bookings = $40. If a job earns $160, that leaves room.', next: 'Wait for at least 10 leads before deciding anything.', ask: ['Do I have enough leads to judge this?', 'How does this relate to my ad spend?'] },
  cost_per_showup: { kind: 'measured', title: 'Cost per show-up', what: 'Ad spend divided by appointments you marked as happened.', why: 'It includes the cost of no-shows.', example: '$120 ÷ 2 visits = $60.', next: 'Mark outcomes promptly or this stays “—”.', ask: ['Do I have visits left to mark?'] },
  job_value: { kind: 'estimated', title: 'Estimated job value', what: 'What you think the jobs from these leads are worth.', why: 'It’s kept apart from invoiced and paid because an estimate isn’t money received.', example: 'Estimated $400, invoiced $380, paid $380.', next: 'Record what was actually paid on each visit.', ask: ['Why are estimates kept apart from payments?'] },
  job_invoiced: { kind: 'recorded', title: 'Invoiced', what: 'What you recorded as billed for visits that happened.', why: 'It shows work you charged for. It isn’t money received yet.', example: 'Invoiced $380, paid $200: $180 is still owed.', next: 'Record the payment when it arrives.', ask: ['How is this different from paid?'] },
  job_paid: { kind: 'recorded', title: 'Paid', what: 'Money you recorded as received for these jobs.', why: 'It’s the only figure used for “Paid per $1 of ads”. We don’t measure how much of it the ads caused.', example: 'Invoiced $380, paid $380.', next: 'Record payments the day they arrive.', ask: ['How is this different from invoiced?'] },
  ad_return: { kind: 'recorded', title: 'Paid per $1 of ads', what: 'Payments you recorded, divided by what Google reports you spent on ads.', why: 'It compares money in with money out. It doesn’t show what the ads caused, or your costs to do the job.', example: '$360 paid ÷ $120 spent is $3.00.', next: 'Wait until most visits have a recorded payment before judging it.', ask: ['What does this leave out?'] },
}
