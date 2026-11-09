// Platform metrics computed from real records only. Anything without data is null, never estimated.
const DAY = 24 * 60 * 60 * 1000

export async function customerRows(env, now = Date.now()) {
  const db = env.ONBOARDING_DB
  const since30 = now - 30 * DAY
  const { results } = await db
    .prepare(
      `SELECT c.id, c.name, c.source, c.created_via, c.status, c.created_at, c.hours_confirmed_at,
              (SELECT group_concat(email, ', ') FROM customer_users u WHERE u.customer = c.id) AS owners,
              (SELECT count(*) FROM leads l WHERE l.customer = c.id AND l.created_at >= ?1) AS leads30,
              (SELECT count(*) FROM appointments a WHERE a.customer = c.id AND a.status IN ('booked','showed','no_show') AND a.created_at >= ?1) AS booked30,
              (SELECT max(a.created_at) FROM appointments a WHERE a.customer = c.id AND a.status IN ('booked','showed','no_show')) AS last_booking,
              (SELECT count(*) FROM account_invites i WHERE i.customer = c.id AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > ?2) AS pending_invites,
              (SELECT min(i.created_at) FROM account_invites i WHERE i.customer = c.id AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > ?2) AS oldest_invite,
              (SELECT count(*) FROM events e WHERE e.customer = c.id AND e.type = 'booking_failed' AND e.at >= ?3) AS failures7,
              s.status AS sub_status, s.plan_id, s.mrr_cents, coalesce(ss.appointment_mode, 'at_business') AS appointment_mode
         FROM customers c LEFT JOIN subscriptions s ON s.customer = c.id LEFT JOIN service_settings ss ON ss.customer = c.id
        ORDER BY c.created_at DESC`,
    )
    .bind(since30, now, now - 7 * DAY)
    .all()

  const rows = []
  for (const r of results) {
    const calendar = Boolean(await env.GOOGLE_TOKENS.get(`google:${r.id}`))
    const hours = Boolean(r.hours_confirmed_at)
    const onboarding =
      r.status === 'suspended' ? 'suspended' : !r.owners ? 'invited' : !calendar ? 'calendar' : !hours ? 'hours' : 'live'
    const attention = []
    if (r.status === 'suspended') attention.push('suspended')
    if (r.sub_status === 'past_due') attention.push('past_due')
    if (r.failures7 > 0) attention.push('booking_failures')
    if (hours && !calendar) attention.push('calendar_disconnected')
    if (onboarding !== 'live' && onboarding !== 'suspended' && now - r.created_at > DAY) attention.push('setup_stalled')
    if (r.oldest_invite && now - r.oldest_invite > 3 * DAY) attention.push('invite_pending')
    if (!r.owners && !r.pending_invites) attention.push('no_owner')
    if (onboarding === 'live' && now - (r.last_booking || r.hours_confirmed_at) > 14 * DAY) attention.push('no_recent_bookings')
    rows.push({
      id: r.id,
      name: r.name,
      owners: r.owners || '',
      source: r.source,
      createdVia: r.created_via,
      appointmentMode: r.appointment_mode,
      status: r.status,
      createdAt: r.created_at,
      onboarding,
      calendarConnected: calendar,
      leads30: r.leads30,
      booked30: r.booked30,
      lastBooking: r.last_booking,
      pendingInvites: r.pending_invites,
      subscription: r.sub_status ? { status: r.sub_status, planId: r.plan_id, mrrCents: r.mrr_cents } : null,
      attention,
    })
  }
  return rows
}

const pct = (num, den) => (den > 0 ? Math.round((num / den) * 1000) / 10 : null)

// rows: output of customerRows(), so activation reflects each business's actual current state
// (calendar connected + hours saved), including businesses set up before events existed.
export async function growth(env, rows, now = Date.now()) {
  const db = env.ONBOARDING_DB
  const one = async (sql, ...args) => (await db.prepare(sql).bind(...args).first()) || {}
  const since30 = now - 30 * DAY
  const prior30 = now - 60 * DAY

  const customers = await one("SELECT count(*) AS total, sum(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active FROM customers")
  const activated = { n: rows.filter((r) => r.calendarConnected && r.onboarding !== 'invited' && r.onboarding !== 'calendar' && r.onboarding !== 'hours').length }
  const firstBooked = { n: rows.filter((r) => r.lastBooking && r.calendarConnected).length }
  const leads = await one("SELECT sum(CASE WHEN status <> 'unqualified' THEN 1 ELSE 0 END) AS qualified, sum(CASE WHEN status = 'booked' THEN 1 ELSE 0 END) AS booked, count(*) AS total FROM leads WHERE created_at >= ?1", since30)
  // Outcomes split by appointment mode: attendance for at_business; visit happened vs job completed
  // for at_customer (a technician arriving is not a completed job).
  const outcomes = await one(
    `SELECT
       sum(CASE WHEN m.mode = 'at_business' AND a.status = 'showed' THEN 1 ELSE 0 END) AS showed,
       sum(CASE WHEN m.mode = 'at_business' AND a.status = 'no_show' THEN 1 ELSE 0 END) AS no_show,
       sum(CASE WHEN m.mode = 'at_customer' AND a.status = 'showed' THEN 1 ELSE 0 END) AS visited,
       sum(CASE WHEN m.mode = 'at_customer' AND a.status = 'no_show' THEN 1 ELSE 0 END) AS missed,
       sum(CASE WHEN m.mode = 'at_customer' AND a.status = 'showed' AND ao.work = 'completed' THEN 1 ELSE 0 END) AS completed,
       sum(CASE WHEN m.mode = 'at_customer' AND a.status = 'showed' AND ao.work = 'not_completed' THEN 1 ELSE 0 END) AS not_completed,
       sum(CASE WHEN a.status = 'showed' THEN ao.value_cents ELSE 0 END) AS value_cents,
       sum(CASE WHEN a.status = 'showed' AND ao.value_cents IS NOT NULL THEN 1 ELSE 0 END) AS valued
     FROM appointments a
     JOIN (SELECT c.id, coalesce(ss.appointment_mode, 'at_business') AS mode FROM customers c LEFT JOIN service_settings ss ON ss.customer = c.id) m ON m.id = a.customer
     LEFT JOIN appointment_outcomes ao ON ao.appointment_id = a.id AND ao.customer = a.customer
     WHERE a.start_at >= ?1`,
    since30,
  )
  const retained = await one(
    `SELECT count(*) AS cohort, sum(CASE WHEN EXISTS (SELECT 1 FROM appointments a WHERE a.customer = c.id AND a.created_at >= ?2 AND a.status IN ('booked','showed','no_show')) THEN 1 ELSE 0 END) AS active
       FROM customers c WHERE c.hours_confirmed_at IS NOT NULL AND c.hours_confirmed_at < ?1`,
    since30,
    since30,
  )
  const subs = await one(
    "SELECT count(*) AS any_sub, sum(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS paying, sum(CASE WHEN status = 'active' THEN mrr_cents ELSE 0 END) AS mrr, sum(CASE WHEN status = 'trialing' THEN 1 ELSE 0 END) AS trialing, max(currency) AS currency FROM subscriptions",
  )
  const canceled30 = await one("SELECT count(DISTINCT customer) AS n FROM events WHERE type = 'subscription_canceled' AND at >= ?1", since30)
  const revenue = async (from, to) => {
    const { results } = await db.prepare("SELECT props FROM events WHERE type = 'revenue' AND at >= ?1 AND at < ?2").bind(from, to).all()
    return results.reduce((sum, r) => sum + (JSON.parse(r.props).amountCents || 0), 0)
  }
  const { results: weekly } = await db
    .prepare("SELECT (at / 604800000) AS week, count(*) AS n FROM events WHERE type = 'business_created' AND at >= ?1 GROUP BY week ORDER BY week")
    .bind(now - 8 * 7 * DAY)
    .all()

  const billing = subs.any_sub > 0
  const rev30 = billing ? await revenue(since30, now) : null
  const revPrior = billing ? await revenue(prior30, since30) : null
  return {
    customers: { total: customers.total || 0, active: customers.active || 0 },
    signupsByWeek: weekly.map((w) => ({ weekStart: new Date(w.week * 7 * DAY).toISOString().slice(0, 10), count: w.n })),
    activationRate: pct(activated.n || 0, customers.total || 0),
    firstBookingRate: pct(firstBooked.n || 0, activated.n || 0),
    bookingConversion30: pct(leads.booked || 0, leads.qualified || 0),
    showUpRate30: pct(outcomes.showed || 0, (outcomes.showed || 0) + (outcomes.no_show || 0)), // at_business only
    visitRate30: pct(outcomes.visited || 0, (outcomes.visited || 0) + (outcomes.missed || 0)), // at_customer
    completionRate30: pct(outcomes.completed || 0, (outcomes.completed || 0) + (outcomes.not_completed || 0)), // at_customer
    // Self-reported value of jobs booked through GetShowUps (association). Incremental revenue caused by
    // GetShowUps needs a baseline or control group and is not measured.
    reportedBookingValue30Cents: outcomes.valued ? outcomes.value_cents || 0 : null,
    incrementalRevenue: null,
    retention30: pct(retained.active || 0, retained.cohort || 0),
    billing: billing
      ? {
          currency: subs.currency,
          mrrCents: subs.mrr || 0,
          arrCents: (subs.mrr || 0) * 12,
          payingCustomers: subs.paying || 0,
          trialing: subs.trialing || 0,
          revenue30Cents: rev30,
          revenueGrowth30: revPrior > 0 ? pct(rev30 - revPrior, revPrior) : null,
          churn30: pct(canceled30.n || 0, (subs.paying || 0) + (canceled30.n || 0)),
        }
      : null,
    // Not computable without recorded costs; shown as unavailable rather than estimated.
    cac: null,
    ltv: null,
    grossMargin: null,
  }
}
