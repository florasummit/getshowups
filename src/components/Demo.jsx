// "See it work": an interactive, fully simulated walk through one inquiry, from the customer's booking page to the
// owner's dashboard. Configuration in content/demo.js; one renderer for every industry. No network, no storage.
import { useEffect, useMemo, useRef, useState } from "react";
import Icon from "./Icon.jsx";
import GetStarted from "./GetStarted.jsx";
import {
  DEMO_INDUSTRY_EVENT,
  customer,
  dayLabel,
  demoDays,
  industries,
  outcomes,
  stages,
} from "../content/demo.js";
import { track } from "../lib/analytics.js";

const STAGE_OF = {
  inquiry: "inquiry",
  outside: "check",
  declined: "check",
  time: "book",
  booked: "after",
  summary: "after",
};
const money = (n) => `$${n.toLocaleString("en-US")}`;

const EXPLAIN = {
  inquiry: {
    title: "The inquiry",
    body: "Your booking page asks what they need, where you’d visit and how to reach them. The lead is saved the moment they continue, even if they never pick a time.",
  },
  time: {
    title: "In your area: straight to open times",
    body: "Their ZIP is on your list, so they see open times right away. In the product, times come from your Google Calendar and booking hours: busy times never show, and a time can’t be booked twice.",
  },
  outside: {
    title: "Outside your area: you decide",
    body: "Their ZIP isn’t on your list, so no times are offered. The lead isn’t thrown away: it waits in your dashboard for you to approve or decline the area.",
  },
  declined: {
    title: "Declined, still on record",
    body: "A declined area keeps the lead in your records but never lets it book. Your service ZIPs stay exactly as you set them.",
  },
  booked: {
    title: "Booked on your calendar",
    body: "The visit is on your Google Calendar with the address, and Google emails the customer an invitation. After the visit, you record what happened.",
  },
  summary: {
    title: "Every inquiry accounted for",
    body: "One place shows who asked, who booked and which jobs got done, without chasing anyone down or keeping a spreadsheet.",
  },
};

export default function Demo({ embedded = false }) {
  const [industryId, setIndustryId] = useState(industries[0].id);
  const ind = industries.find((i) => i.id === industryId);
  const [requestId, setRequestId] = useState(ind.requests[0].id);
  const [zipChoice, setZipChoice] = useState("in");
  const [stage, setStage] = useState("inquiry");
  const [approved, setApproved] = useState(false);
  const [day, setDay] = useState(0);
  const [slot, setSlot] = useState(null);
  const [outcome, setOutcome] = useState(null);
  const [estimate, setEstimate] = useState(null);
  const started = useRef(false);
  const focusNext = useRef(null);
  const customerHead = useRef(null);
  const ownerHead = useRef(null);
  const days = useMemo(() => demoDays(), []);

  const request =
    ind.requests.find((r) => r.id === requestId) || ind.requests[0];
  const zip =
    zipChoice === "in" ? { zip: ind.zips[0], town: ind.town } : ind.outsideZip;
  const current = STAGE_OF[stage];
  const currentIndex = stages.findIndex((s) => s.id === current);
  const booking = slot && { day: days[slot.day], time: slot.time };

  const begin = () => {
    if (started.current) return;
    started.current = true;
    track("demo_started", { industry: industryId });
  };
  const go = (next, focus = "customer", path) => {
    begin();
    focusNext.current = focus;
    setStage(next);
    if (STAGE_OF[next] !== STAGE_OF[stage])
      track("demo_step", {
        industry: industryId,
        step: STAGE_OF[next],
        ...(path ? { path } : {}),
      });
  };
  const reset = (id = industryId, announce = true) => {
    const next = industries.find((i) => i.id === id);
    setIndustryId(id);
    setRequestId(next.requests[0].id);
    setZipChoice("in");
    setStage("inquiry");
    setApproved(false);
    setDay(0);
    setSlot(null);
    setOutcome(null);
    setEstimate(null);
    if (announce) focusNext.current = "customer";
  };
  const chooseIndustry = (id, announce = true) => {
    if (id !== industryId) track("demo_industry", { industry: id });
    reset(id, announce);
  };

  // The hero's "Try it with…" buttons pick the industry here.
  useEffect(() => {
    const onPick = (e) => {
      if (industries.some((i) => i.id === e.detail))
        chooseIndustry(e.detail, false);
    };
    window.addEventListener(DEMO_INDUSTRY_EVENT, onPick);
    return () => window.removeEventListener(DEMO_INDUSTRY_EVENT, onPick);
  });

  // Move focus to the panel that changed (only after a visitor's action, never on first load).
  useEffect(() => {
    const target =
      focusNext.current === "owner"
        ? ownerHead.current
        : focusNext.current === "customer"
          ? customerHead.current
          : null;
    focusNext.current = null;
    target?.focus({ preventScroll: window.innerWidth > 900 });
  }, [stage, industryId, outcome]);

  // "Job done" keeps focus on the button (the estimate choice appears right after it); the others finish at once.
  const pickOutcome = (id) => {
    setOutcome(id);
    if (id !== "done") finish(id, null);
  };
  const finish = (id, value) => {
    setEstimate(value);
    go("summary", "owner");
    track("demo_finished", { industry: industryId, outcome: id });
  };

  const explain = EXPLAIN[stage];

  const board = (
    <div className="dm" data-demo data-industry={industryId} data-stage={stage}>
      <div className="dm-bar">
        <div className="dm-trades" role="group" aria-label="Business type">
          {industries.map((i) => (
            <button
              key={i.id}
              type="button"
              aria-pressed={i.id === industryId}
              onClick={() => chooseIndustry(i.id)}
            >
              {i.label}
            </button>
          ))}
        </div>
        <p className="dm-label" role="note">
          <span className="dm-dot" aria-hidden="true" />
          Simulation · example business · nothing is sent or booked
        </p>
      </div>

      <ol className="dm-stages" aria-label="Demo progress">
        {stages.map((s, i) => {
          const state =
            stage === "summary" || i < currentIndex
              ? "done"
              : i === currentIndex
                ? "active"
                : "todo";
          return (
            <li
              key={s.id}
              className={`dm-stage is-${state}`}
              aria-current={state === "active" ? "step" : undefined}
            >
              <span className="dm-stage-num" aria-hidden="true">
                {state === "done" ? (
                  <Icon name="tick" size={12} strokeWidth={3} />
                ) : (
                  i + 1
                )}
              </span>
              <span>{s.label}</span>
              {state === "done" && (
                <span className="visually-hidden"> (done)</span>
              )}
            </li>
          );
        })}
      </ol>

      <div className="dm-panes">
        {/* ---------- Customer: the business's booking page on a phone ---------- */}
        <section
          className="dm-pane dm-customer"
          aria-labelledby="dm-customer-title"
        >
          <p className="dm-pane-label">
            <Icon name="inbox" size={15} /> Customer’s phone · your booking page
          </p>
          <div className="dm-phone">
            <div className="dm-site-bar">
              <span className="dm-site-logo" aria-hidden="true">
                {ind.business[0]}
              </span>
              <span>{ind.business}</span>
              <span className="dm-site-tag">Example</span>
            </div>
            <div className="dm-phone-body">
              {stage === "inquiry" && (
                <form
                  className="dm-form"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (zipChoice === "in") go("time", "customer", "in_area");
                    else go("outside", "customer", "outside");
                  }}
                >
                  <h3 id="dm-customer-title" ref={customerHead} tabIndex={-1}>
                    Book a visit
                  </h3>
                  <fieldset className="dm-field">
                    <legend>What do you need?</legend>
                    <div className="dm-chips">
                      {ind.requests.map((r) => (
                        <label key={r.id} className="dm-chip">
                          <input
                            type="radio"
                            name="dm-request"
                            value={r.id}
                            checked={r.id === request.id}
                            onChange={() => {
                              begin();
                              setRequestId(r.id);
                            }}
                          />
                          <span>{r.short}</span>
                        </label>
                      ))}
                    </div>
                    <p className="dm-quote" data-request-text>
                      “{request.text}”
                    </p>
                  </fieldset>
                  <fieldset className="dm-field">
                    <legend>Service address ZIP</legend>
                    <div className="dm-chips">
                      <label className="dm-chip">
                        <input
                          type="radio"
                          name="dm-zip"
                          value="in"
                          checked={zipChoice === "in"}
                          onChange={() => setZipChoice("in")}
                        />
                        <span>
                          {ind.zips[0]} · {ind.town}
                        </span>
                      </label>
                      <label className="dm-chip">
                        <input
                          type="radio"
                          name="dm-zip"
                          value="out"
                          checked={zipChoice === "out"}
                          onChange={() => {
                            begin();
                            setZipChoice("out");
                          }}
                        />
                        <span>
                          {ind.outsideZip.zip} · {ind.outsideZip.town}
                        </span>
                      </label>
                    </div>
                  </fieldset>
                  <dl
                    className="dm-filled"
                    aria-label="Example contact details"
                  >
                    <div>
                      <dt>Name</dt>
                      <dd>{customer.name}</dd>
                    </div>
                    <div>
                      <dt>Phone</dt>
                      <dd>{customer.phone}</dd>
                    </div>
                    <div>
                      <dt>Address</dt>
                      <dd>
                        {ind.street}, {zip.town} {zip.zip}
                      </dd>
                    </div>
                  </dl>
                  <button type="submit" className="btn btn-primary btn-block">
                    Continue
                  </button>
                </form>
              )}

              {(stage === "outside" || stage === "declined") && (
                <div className="dm-msg" role="status">
                  <h3 id="dm-customer-title" ref={customerHead} tabIndex={-1}>
                    Thanks, {customer.first}
                  </h3>
                  <p className="dm-lede">
                    We may be able to help in your area.
                  </p>
                  <p>
                    {ind.business} has your details for ZIP {zip.zip} and will
                    confirm availability with you. You won’t need to fill this
                    in again.
                  </p>
                </div>
              )}

              {stage === "time" && (
                <form
                  className="dm-form"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (slot) go("booked", "owner");
                  }}
                >
                  <h3 id="dm-customer-title" ref={customerHead} tabIndex={-1}>
                    Pick a visit time
                  </h3>
                  {approved && (
                    <p className="dm-note">
                      Opened from the booking link {ind.business} sent.
                    </p>
                  )}
                  <div className="dm-days" role="group" aria-label="Day">
                    {days.map((d, i) => (
                      <button
                        key={d.toISOString()}
                        type="button"
                        aria-pressed={i === day}
                        onClick={() => setDay(i)}
                      >
                        {dayLabel(d)}
                      </button>
                    ))}
                  </div>
                  <fieldset className="dm-slots">
                    <legend className="visually-hidden">
                      Time on{" "}
                      {dayLabel(days[day], {
                        weekday: "long",
                        month: "long",
                        day: "numeric",
                      })}
                    </legend>
                    {ind.times.map((t) => (
                      <label key={t} className="dm-slot">
                        <input
                          type="radio"
                          name="dm-slot"
                          value={t}
                          checked={slot?.day === day && slot?.time === t}
                          onChange={() => setSlot({ day, time: t })}
                        />
                        <span>{t}</span>
                      </label>
                    ))}
                  </fieldset>
                  <p className="dm-fine">
                    Illustrative times. Real times come from the business’s
                    calendar.
                  </p>
                  <button
                    type="submit"
                    className="btn btn-primary btn-block"
                    disabled={!slot}
                  >
                    {slot
                      ? `Book ${dayLabel(days[slot.day], { weekday: "short" })} ${slot.time}`
                      : "Choose a time"}
                  </button>
                </form>
              )}

              {(stage === "booked" || stage === "summary") && booking && (
                <div className="dm-done" role="status">
                  <span className="dm-check" aria-hidden="true">
                    ✓
                  </span>
                  <h3 id="dm-customer-title" ref={customerHead} tabIndex={-1}>
                    Visit booked
                  </h3>
                  <p className="dm-when">
                    {dayLabel(booking.day, {
                      weekday: "long",
                      month: "long",
                      day: "numeric",
                    })}
                  </p>
                  <p className="dm-time">{booking.time}</p>
                  <p>
                    {ind.business} will visit {ind.street}.
                  </p>
                  <p>
                    A calendar invitation is on its way to {customer.email}.
                  </p>
                </div>
              )}
            </div>
          </div>
        </section>

        {/* ---------- Owner: what lands in the dashboard ---------- */}
        <section
          className="dm-pane dm-owner"
          aria-labelledby="dm-owner-title"
          data-owner
        >
          <p className="dm-pane-label">
            <Icon name="chart" size={15} /> Your dashboard · {ind.business}
          </p>
          <div className="dm-board" aria-live="polite">
            <h3 id="dm-owner-title" ref={ownerHead} tabIndex={-1}>
              {stage === "inquiry"
                ? "Waiting for an inquiry"
                : stage === "outside"
                  ? "Coverage review needed"
                  : stage === "declined"
                    ? "Area declined"
                    : stage === "time"
                      ? "Haven’t booked yet"
                      : stage === "booked"
                        ? "Upcoming"
                        : "This week"}
            </h3>

            {stage === "inquiry" && (
              <p className="dm-empty">
                Nothing yet. Submit the customer’s request and watch what
                arrives here.
              </p>
            )}

            {stage !== "inquiry" && stage !== "summary" && (
              <article className="dm-lead" data-lead>
                <div className="dm-lead-top">
                  <strong>{customer.name}</strong>
                  <span className="dm-src">Booking page</span>
                </div>
                <p className="dm-lead-need">{request.text}</p>
                <ul className="dm-tags">
                  <li
                    className={`dm-tag tone-${zipChoice === "in" || approved ? "ok" : stage === "declined" ? "bad" : "warn"}`}
                  >
                    ZIP {zip.zip}:{" "}
                    {zipChoice === "in"
                      ? "in your service area"
                      : approved
                        ? "area approved"
                        : stage === "declined"
                          ? "area declined"
                          : "not in your listed ZIPs"}
                  </li>
                  <li className="dm-tag">Visit at {ind.street}</li>
                  {booking && stage === "booked" && (
                    <li className="dm-tag tone-ok">On your Google Calendar</li>
                  )}
                  {booking && stage === "booked" && (
                    <li className="dm-tag tone-ok">
                      Invitation emailed by Google
                    </li>
                  )}
                </ul>
                {booking && stage === "booked" && (
                  <p className="dm-lead-when">
                    <Icon name="calendar" size={15} />{" "}
                    {dayLabel(booking.day, {
                      weekday: "long",
                      month: "short",
                      day: "numeric",
                    })}{" "}
                    · {booking.time} · {ind.visitMinutes} min visit
                  </p>
                )}
                {stage === "time" && (
                  <p className="dm-wait">
                    {approved
                      ? "You approved the area. Booking link sent; waiting for them to pick a time."
                      : "Saved as a lead. Waiting for them to pick a time."}
                  </p>
                )}
                {stage === "outside" && (
                  <div className="dm-actions">
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      onClick={() => {
                        setApproved(true);
                        go("time", "customer");
                      }}
                    >
                      Approve area
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => go("declined", "owner")}
                    >
                      Decline
                    </button>
                  </div>
                )}
                {stage === "booked" && (
                  <fieldset className="dm-outcome">
                    <legend>After the visit: how did it go?</legend>
                    <div className="dm-actions">
                      {outcomes.map((o) => (
                        <button
                          key={o.id}
                          type="button"
                          className={`btn btn-sm ${outcome === o.id ? "btn-primary" : "btn-ghost"}`}
                          aria-pressed={outcome === o.id}
                          onClick={() => pickOutcome(o.id)}
                        >
                          {o.label}
                        </button>
                      ))}
                    </div>
                    {outcome === "done" && (
                      <div className="dm-estimate">
                        <p>
                          Add your own estimate of the job value? (Optional. Not
                          a payment.)
                        </p>
                        <div className="dm-actions">
                          <button
                            type="button"
                            className="btn btn-primary btn-sm"
                            onClick={() => finish("done", request.value)}
                          >
                            Save {money(request.value)}
                          </button>
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm"
                            onClick={() => finish("done", null)}
                          >
                            Skip
                          </button>
                        </div>
                      </div>
                    )}
                  </fieldset>
                )}
              </article>
            )}

            {stage === "summary" && (
              <div className="dm-summary" data-summary>
                <dl className="dm-metrics">
                  <div>
                    <dt>Inquiries</dt>
                    <dd>1</dd>
                  </div>
                  <div>
                    <dt>Booked</dt>
                    <dd>1</dd>
                  </div>
                  <div>
                    <dt>{outcomes.find((o) => o.id === outcome)?.label}</dt>
                    <dd>1</dd>
                  </div>
                  <div>
                    <dt>Est. job value</dt>
                    <dd>{estimate ? money(estimate) : "—"}</dd>
                  </div>
                </dl>
                <p className="dm-fine">
                  Job value is your own estimate, never counted as money
                  received.
                </p>
                <ul className="dm-saved">
                  <li>
                    <Icon name="tick" size={16} strokeWidth={2.5} /> No phone
                    tag: {customer.first} picked a time on their own.
                  </li>
                  <li>
                    <Icon name="tick" size={16} strokeWidth={2.5} /> No double
                    booking: the time came from your calendar.
                  </li>
                  <li>
                    <Icon name="tick" size={16} strokeWidth={2.5} /> No
                    spreadsheet: inquiry, booking and result in one record.
                  </li>
                </ul>
              </div>
            )}
          </div>
        </section>
      </div>

      <div className="dm-foot">
        <div className="dm-explain" aria-live="polite">
          <p className="dm-explain-title">{explain.title}</p>
          <p>{explain.body}</p>
        </div>
        <div className="dm-foot-actions">
          {(stage === "summary" || stage === "declined") && (
            <GetStarted
              location="demo"
              className="btn btn-primary"
              onClick={() => track("early_access_cta", { location: "demo" })}
            />
          )}
          <button
            type="button"
            className="btn btn-ghost"
            disabled={stage === "inquiry"}
            onClick={() => {
              track("demo_reset", { industry: industryId });
              reset();
            }}
          >
            <Icon name="reset" size={16} /> Start over
          </button>
        </div>
      </div>
      <p className="dm-not-shown">
        Not in this demo because it isn’t live yet: text messages, email
        reminders and automatic follow-ups (coming soon).
      </p>
    </div>
  );
  if (embedded) return board;
  return (
    <section
      id="demo"
      className="section section--dark demo-section"
      aria-labelledby="demo-heading"
    >
      <span id="simulation" className="anchor-alias" aria-hidden="true" />
      <div className="container">
        <header className="section-heading">
          <p className="eyebrow">See it work</p>
          <h2 id="demo-heading">
            Follow one inquiry from your website to a finished job
          </h2>
          <p className="section-intro">
            You play both sides: the customer on your booking page, and you in
            your dashboard. Pick a trade and click through.
          </p>
        </header>
        {board}
      </div>
    </section>
  );
}
