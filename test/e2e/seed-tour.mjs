// Seed for the visual tour (test/e2e/tour.spec.js): one realistic, FICTIONAL pool business with a little history, so
// screens are reviewed with representative data instead of empty states only. Fake names, 555 numbers, .example
// addresses. Prints SQL for `wrangler d1 execute --command`.
//   node test/e2e/seed-tour.mjs <customer id> <session token hash> <now ms>
const [id, tokenHash, nowArg] = process.argv.slice(2)
const now = Number(nowArg)
const H = 3600_000
const DAY = 24 * H
const q = (v) => (v === null || v === undefined ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`)
const row = (table, obj) => `INSERT INTO ${table} (${Object.keys(obj).join(', ')}) VALUES (${Object.values(obj).map(q).join(', ')});`
// Next weekday at 10:00 New York (≈ 14:00/15:00 UTC); exact local hour doesn't matter for the screenshots.
const nextWeekday = (() => {
  let t = new Date(now + DAY)
  while ([0, 6].includes(t.getUTCDay())) t = new Date(t.getTime() + DAY)
  t.setUTCHours(15, 0, 0, 0)
  return t.getTime()
})()
const past = now - 3 * DAY
const log = (lines) => lines.map(([who, text, channel = 'chat'], i) => ({ who, text, channel, at: now - 2 * H + i * 30_000 }))

const sql = [
  row('customers', { id, name: 'Harbor Pool Co', timezone: 'America/New_York', service_zips: '29403,29401', day_start: '09:00', day_end: '17:00', workdays: '1,2,3,4,5', hours_confirmed_at: now, created_at: now - 20 * DAY, updated_at: now }),
  row('customer_users', { email: `owner@${id}.example`, customer: id, created_at: now }),
  row('sessions', { token_hash: tokenHash, email: `owner@${id}.example`, created_at: now, expires_at: now + DAY }),
  row('service_settings', { customer: id, appointment_mode: 'at_customer', updated_at: now }),
  row('business_profiles', {
    customer: id,
    phone: '(843) 555-0142',
    industry: 'Pool service',
    description: 'Family-run pool care in Charleston.',
    services: JSON.stringify([{ name: 'Weekly pool care', price: '$280/month' }, { name: 'Green pool cleanup', price: '' }, { name: 'Filter cleaning', price: '$95' }]),
    cities: JSON.stringify(['Charleston', 'Mount Pleasant']),
    updated_at: now,
  }),
  row('receptionist_settings', { customer: id, enabled: 1, mode: 'ai_first', greeting: 'Hi! Thanks for reaching out to Harbor Pool Co. How can we help?', knowledge: 'Weekly care includes chemicals and skimming.', transfer_phone: null, updated_at: now }),
  // Leads + bookings
  row('leads', { id: 'tour-lead-1', customer: id, name: 'Jamie Rivera', email: '', phone: '+18435550101', need: 'Weekly pool care', zip: '29403', status: 'booked', token_hash: 'x', created_at: now - 2 * H, updated_at: now - 2 * H }),
  row('lead_addresses', { lead_id: 'tour-lead-1', customer: id, street: '12 King St', unit: '', city: 'Charleston', state: 'SC', zip: '29403', created_at: now - 2 * H }),
  row('appointments', { id: 'tour-appt-1', customer: id, lead_id: 'tour-lead-1', start_at: nextWeekday, end_at: nextWeekday + H, status: 'booked', google_event_id: 'tourevent1', created_at: now - 2 * H, updated_at: now - 2 * H }),
  row('leads', { id: 'tour-lead-2', customer: id, name: 'Pat Lee', email: 'pat@example.net', phone: '+18435550102', need: 'Filter cleaning', zip: '29401', status: 'booked', token_hash: 'x', created_at: past - DAY, updated_at: past }),
  row('lead_addresses', { lead_id: 'tour-lead-2', customer: id, street: '40 Meeting St', unit: '', city: 'Charleston', state: 'SC', zip: '29401', created_at: past - DAY }),
  row('appointments', { id: 'tour-appt-2', customer: id, lead_id: 'tour-lead-2', start_at: past, end_at: past + H, status: 'showed', google_event_id: 'tourevent2', created_at: past - DAY, updated_at: past + 2 * H }),
  row('leads', { id: 'tour-lead-3', customer: id, name: 'Sam Ortiz', email: 'sam@example.net', phone: '+18435550103', need: 'Green pool cleanup', zip: '29403', status: 'new', token_hash: 'x', created_at: now - 5 * H, updated_at: now - 5 * H }),
  // Receptionist conversations: booked (chat), urgent callback (voice), information only (chat)
  row('receptionist_conversations', {
    id: 'tourconv1', customer: id, channel: 'chat', status: 'booked', outcome: 'booked', lead_id: 'tour-lead-1', appointment_id: 'tour-appt-1',
    summary: 'Booked Weekly pool care',
    state: JSON.stringify({ customer: { name: 'Jamie Rivera', phone: '+18435550101', zip: '29403', need: 'Weekly pool care', street: '12 King St', city: 'Charleston', state: 'SC' }, booked: { appointmentId: 'tour-appt-1', start: nextWeekday }, endedAt: now - H, log: log([
      ['customer', 'Hi, do you do weekly pool cleaning in 29403? How much is it?'],
      ['receptionist', 'Yes, we serve 29403. Weekly pool care is $280/month and includes chemicals and skimming. Would you like me to find a time for a first visit?'],
      ['customer', 'Yes please. Jamie Rivera, 843-555-0101, 12 King St, Charleston.'],
      ['receptionist', 'Thanks, Jamie. I can do the next weekday at 10:00 AM. Shall I book it?'],
      ['customer', 'Yes, book it.'],
      ['receptionist', 'You’re booked. It’s on the Harbor Pool Co calendar.'],
    ]) }),
    transcript: '[]', turns: 3, cost_micros: 42000, created_at: now - 2 * H, updated_at: now - H,
  }),
  row('receptionist_conversations', {
    id: 'tourconv2', customer: id, channel: 'voice', status: 'handoff', outcome: 'callback_urgent', lead_id: null, appointment_id: null,
    summary: 'Asked for a call back (urgent)',
    state: JSON.stringify({ customer: { name: 'Morgan Diaz', phone: '+18435550104', need: 'Pump sparking' }, requests: { callback: 'tourreq1' }, log: log([
      ['customer', 'My pool pump is sparking and smells like burning.', 'voice'],
      ['receptionist', 'Please switch off the breaker for the pump and stay away from it. If there is fire or smoke, call 911. I can record an urgent callback request for the team. What is your name and number?', 'voice'],
      ['customer', 'Morgan Diaz, 843 555 0104.', 'voice'],
      ['receptionist', 'I’ve recorded your urgent callback request for the Harbor Pool Co team with 843-555-0104.', 'voice'],
    ]) }),
    transcript: '[]', turns: 2, cost_micros: 31000, created_at: now - 40 * 60_000, updated_at: now - 35 * 60_000,
  }),
  row('receptionist_conversations', {
    id: 'tourconv3', customer: id, channel: 'chat', status: 'closed', outcome: 'info', lead_id: null, appointment_id: null,
    summary: 'Asked about prices',
    state: JSON.stringify({ customer: {}, endedAt: now - 20 * H, log: log([
      ['customer', 'Do you service hot tubs?'],
      ['receptionist', 'We don’t list hot tub service. We do weekly pool care, green pool cleanup and filter cleaning. Can I help with one of those?'],
    ]) }),
    transcript: '[]', turns: 1, cost_micros: 9000, created_at: now - 21 * H, updated_at: now - 20 * H,
  }),
  ...[
    ['tourconv1', 'save_customer_details', 1, null, -2 * H],
    ['tourconv1', 'check_service_area', 1, null, -2 * H + 1000],
    ['tourconv1', 'find_available_times', 1, null, -2 * H + 2000],
    ['tourconv1', 'book_appointment', 1, null, -H - 60_000],
    ['tourconv2', 'request_callback', 0, 'name_needed', -40 * 60_000],
    ['tourconv2', 'save_customer_details', 1, null, -36 * 60_000],
    ['tourconv2', 'request_callback', 1, 'urgent', -35 * 60_000],
  ].map(([c, kind, ok, detail, at]) => row('receptionist_events', { customer: id, conversation_id: c, kind, ok, detail, at: now + at })),
  row('receptionist_requests', { id: 'tourreq1', customer: id, conversation_id: 'tourconv2', kind: 'callback', name: 'Morgan Diaz', phone: '+18435550104', email: null, note: 'Pool pump is sparking and smells like burning.', urgent: 1, status: 'open', held: 1, created_at: now - 35 * 60_000, updated_at: now - 35 * 60_000, resolved_at: null }),
]
process.stdout.write(sql.join('\n'))
