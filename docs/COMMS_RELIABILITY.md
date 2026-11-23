# Comms reliability (Agent B, 2026-11-19)

Branch `feat/comms-reliability`, no migration. Scope: Retell voice receptionist, voice release gate, email/SMS
automation, receptionist booking tool, operational events. No release switch was set or flipped, nothing live was
called (no Retell, Twilio, Resend, Anthropic or Google request), no production data was read.

**Labels.** *Verified* = shown by a test in this repo or read from the cited vendor page on 2026-11-19.
*Preliminary* = third-party source or our inference, not confirmed. *Live-only* = can only be checked with a real call.

## 1. Voice: defects found and fixed

Audited against Retell's custom-LLM WebSocket protocol (docs.retellai.com/api-references/llm-websocket, read
2026-11-19): `ping_pong` every 2 s with auto_reconnect, reconnect after 5 s without one (up to 2 times); a newer
`response_required` / `reminder_required` makes older responses obsolete; stream chunks share a response_id, only the
last has `content_complete: true`; `reminder_required` may come without a `response_id` in Retell's own example.

| # | Severity | Defect (server/receptionist/voice.js, engine.js) | Symptom on a call | Fix | Test |
| --- | --- | --- | --- | --- | --- |
| V1 | High | Barge-in did not stop the stale Claude stream: the turn queue waited for the whole old answer | Long silence after the caller interrupts; next turn starts seconds late | AbortController per turn, aborted on a newer response_id (only while the turn has not acted) | barge-in (old code: 3.06 s, new: <0.1 s) |
| V2 | High | One turn that threw (e.g. a D1 read) rejected the promise chain: every later turn was skipped | Call goes permanently silent | Chain catches per turn, speaks a retry line | failed turn |
| V3 | High | Socket close set `ended_at`, so Retell's auto_reconnect (same call id) was refused; a reconnect would also re-greet | Call drops after any network blip / missed pings | Reconnect allowed for 2 min unless the conversation ended; no greeting on reconnect | receptionist.test.js voice test |
| V4 | Medium | A frame without a numeric response_id set `latest = NaN`: staleness checks stopped working for the rest of the call | Interruptions no longer handled | Frame ignored, `voice_frame:bad_response_id` event | failed turn |
| V5 | Medium | Words of a talked-over turn were lost when an agent line (holding line) was heard in between | "Missed speech": caller repeats themselves | Dropped turn's words carried into the next turn (`turnText`) | missed speech |
| V6 | Medium | Holding line spoken only after the first model call finished | Silence while the model writes the tool call | Spoken at the stream's tool_use start | holding line (<0.3 s vs ≥0.41 s) |
| V7 | Low | Voice waited up to 25 s ×2 for the model; the fallback read a URL aloud | Very long silence; useless fallback | Voice timeout 10 s (1 retry); spoken fallback names the website and phone | model refuses |
| V8 | Low | Browser asked for the mic only inside Retell's startCall, after the server created the call | Mic denial found after a call was created | Mic permission first (echoCancellation/noiseSuppression/autoGainControl on), SDK preloaded, mic released on error | e2e voice-mic.spec.js |

Keepalive was already answered immediately (not queued behind a turn); the test keeps it that way.
The 2026-11-18 production call (bob-electrical: 1 of ~5 turns answered, STATUS.md) fits V1 + V5 (a slow answer the
caller talks over holds every following turn); this is *preliminary* until a live call with the fixes.

### Separating causes (what evidence distinguishes them)

| Layer | Possible cause | Evidence that points here | How to check |
| --- | --- | --- | --- |
| Browser / device | Mic constraints, AEC/AGC/noise suppression, laptop speaker echo, sample rate, Bluetooth headset switching profile | Problem goes away with headphones or another device; agent cuts itself off (its own voice heard as an interruption); Retell transcript shows words the caller didn't say | Same script with headphones vs laptop speakers; Chrome `chrome://webrtc-internals` (echo, levels) — *live-only* |
| Network | Packet loss / jitter on the WebRTC leg, socket drops | Choppy audio, gaps in both directions; `voice_socket:reconnected` events | Retell call log latency/disconnect fields; our reconnect events — *live-only* |
| Telephony | Not used: browser calls only (no phone number connected) | n/a | n/a |
| Provider (Retell STT / turn-taking / TTS) | End-of-speech too early/late, interruption sensitivity, denoising, TTS start | Retell transcript differs from what was said; `response_required` arrives mid-sentence; long gap between our first chunk and audio | Compare our `voice_turn first=` with Retell's per-turn latency in its call log — *live-only* |
| Our LLM path | Claude time-to-first-token, tool round trips, protocol handling | `voice_turn` events: large `first`/`model`/`tools`; `turn:talked_over`; `r=stale` | `receptionist_events` (numbers only), harness below — *verified in mocks* |

A laptop-mic symptom alone is not proof of a provider problem: our `voice_turn.first` minus Retell's reported
end-of-speech time separates "we were slow" from "Retell/the device was slow".

## 2. Latency harness and measurements

`test/voice-reliability.test.js` drives the real socket handler with mocked Retell frames and a mocked, timed
Anthropic stream (loopback `AI_API_MOCK_ORIGIN`, abort honoured). `VOICE_BENCH=1 VOICE_BENCH_N=200` prints the table.
Each turn writes one `voice_turn` event: `r=<ok|stale|busy|failed>;q=<queue ms>;first=<ms to first chunk>;total=<ms>;
model=<ms>;tools=<ms>;calls=<n>` (numbers and codes only, no transcript text).

**Proposed acceptance targets (not measured live):**

| Metric | Target |
| --- | --- |
| Time to first audio after end of speech | P50 ≤ 1.2 s, P95 ≤ 2.5 s, P99 ≤ 4 s |
| First audio after a tool call starts (holding line) | ≤ 1.5 s |
| Silent gaps > 4 s per call | 0 in ≥ 95 % of calls |
| False interruptions (agent stops for noise/echo) | ≤ 1 per 10 calls |
| Missed interruptions (caller can't break in) | ≤ 1 per 10 calls |
| Booking success when the caller wants a bookable time | ≥ 90 % |
| Duplicate bookings / duplicate confirmations | 0 |
| Cost per completed call (Retell + Claude) | ≤ $0.75 for a 3-minute booking call |

**Measured (mocked harness only; our own overhead, not Retell, not Claude):**

| Measurement | n | Result |
| --- | --- | --- |
| First chunk minus the mock model's first token (40 ms) | 200 turns | P50 8 ms, P95 10 ms, max 20 ms |
| Whole turn (one short answer, mock) | 200 turns | P50 53 ms, P95 55 ms |
| New turn's first chunk after barge-in on a stalled answer | 1 | old code ≈ 3.06 s (waits for the stale answer), new < 0.1 s |
| Holding line after the model starts a calendar lookup (tool call ends at ≥ 0.41 s) | 1 | new < 0.3 s (asserted), old only after the call ended |

P99 not reported (n too small to be meaningful for a mock). Real end-of-speech → audio latency: **not measured**
(needs an approved live call).

## 3. Test matrix (realistic calls)

| Scenario | Expected behaviour | How it runs | Result |
| --- | --- | --- | --- |
| Happy-path booking | Details saved once, real times, read back, explicit yes → one booking, confirmation | Mocked (receptionist.test.js chat booking, voice-reliability booking) | Pass |
| Changed time request | New lookup; only offered times bookable | Mocked (receptionist.test.js booking guards) | Pass |
| Unavailable slot (taken meanwhile) | Said honestly, new lookup, nothing booked | Mocked (receptionist.test.js slot taken) | Pass |
| Interruption mid-sentence | Stale answer aborted; next turn starts at once; words kept | Mocked (barge-in, missed speech) | Pass |
| Interruption during a booking | Booking kept (never aborted once it acted), exactly one | Mocked (voice-reliability) | Pass |
| Long silence | Reminder line; Retell ends the call after its silence limit | Reminder: mocked. Silence limit: live-only | Reminder pass; limit not run |
| Confused / repeating caller | Details never asked twice; targeted re-ask | Mocked (receptionist eval, 100 simulated scenarios) | Pass |
| Out-of-area ZIP | Never booked; coverage request recorded | Mocked (receptionist.test.js out of area) | Pass |
| Background noise / accent | STT and turn-taking hold up | Live-only | Not run |
| Disconnect mid-booking | Reconnect continues the call; booking state from the record | Reconnect: mocked; real network drop: live-only | Reconnect pass |
| Claude error / timeout | Spoken fallback (no URL), `model:<code>` event | Mocked (4xx); real timeout: live-only | Pass (4xx) |
| Provider (Retell) outage | Call can't start (`voice_unreachable` / `voice_http_<n>`); chat keeps working | Code path only; no dedicated test | Not run |
| Microphone blocked / missing | Told how to fix; no call created | Playwright (voice-mic.spec.js) | Pass |
| Voice not released for the business | No talk button; "in testing"; server refuses | Unit + Playwright | Pass |

## 4. Retell agent settings (PROPOSED, unmeasured live)

`scripts/retell-setup.mjs --tuned --test-agent "<name>"` sends these to a separate TEST agent only (the script refuses
`--tuned` for the live agent, 2026-11-21); without `--tuned` the live agent keeps Retell's defaults, so both can be compared
in the approved live test. Applying anything is an approval item (paid voice usage). Latency diagnosis and the test-agent
command: docs/RECEPTIONIST.md ("Latency: where the time goes"). Fields,
ranges and defaults: docs.retellai.com/api-references/create-agent (read 2026-11-19).

| Field | Retell default | Proposed | Why |
| --- | --- | --- | --- |
| responsiveness | 1 | 1 | Already fastest; pauses are not from Retell waiting longer |
| interruption_sensitivity | 1 | 0.8 | Laptop-speaker echo and job-site noise interrupt the agent at 1; 0.8 still lets a caller break in. Verify live |
| enable_backchannel | off | off | Backchannel words over browser echo read as interruptions |
| denoising_mode | noise-cancellation | noise-and-background-speech-cancellation | TV / crew voices in the background (may cost extra per Retell's docs) |
| reminder_trigger_ms / reminder_max_count | 10000 / 1 | 10000 / 2 | One more nudge before giving up |
| end_call_after_silence_ms | 600000 (10 min) | 60000 | A silent web call is billed per minute |
| max_call_duration_ms | 3600000 (1 h) | 900000 | A booking call takes minutes; caps cost |
| data_storage_setting | everything (transcripts, recordings, logs) | everything_except_pii | Our own record is the conversation; Retell keeps less personal data |
| data_storage_retention_days | unset = kept forever | 30 | Retell copy deleted after 30 days |
| opt_in_signed_url | (not stated) | true | Recording/log URLs expire (24 h default) |

**Recording / disclosure (for the attorney; no wording added):** by default Retell stores everything (recordings,
transcripts, logs) with no retention limit. The chat page footer says "AI assistant for <business>, powered by
GetShowUps. It can't transfer calls." with a Privacy link; nothing tells the caller before they speak that the call is
recorded or transcribed (by us or Retell). Whether a disclosure is required is a legal decision.

## 5. Voice release gate (owner decision 2026-11-19)

`RECEPTIONIST_VOICE_BUSINESSES`: comma-separated business ids, no wildcard, empty/unset = nobody (parsed like
AI_RULES_LIVE_BUSINESSES). Chat is not affected. Enforced in the public info route (`voice`, `voiceStatus`), the voice call
route (403 `voice_not_available`, before any Retell call) and the Retell socket (a call of an unlisted business is
closed). Owner dashboard: Beta label; "Browser voice: In testing, not available yet". Chat page: no talk button,
"Talking by voice is in testing and not available yet."

There is no stored per-business voice setting (receptionist_settings has enabled/mode/greeting/knowledge/transfer
phone only); nothing stored is changed. **At deploy:** every business whose receptionist is on and that is not
listed loses the voice button (today voice is shown whenever Retell is configured, e.g. bob-electrical). Chat stays.
To keep today's behaviour set `RECEPTIONIST_VOICE_BUSINESSES` to those ids at deploy (owner decision).

## 6. Email / SMS / booking chain

| Area | Finding | Change |
| --- | --- | --- |
| Account outbox | Retries every cron run: a 15-minute outage burned all 3 attempts; no age limit, so mail queued while no provider was set (owner notices included) could go out days late in a burst; a retry after Resend's 24 h idempotency window could duplicate | Backoff (5 min, 30 min after queueing); owner notices older than 2 h and anything older than 23 h closed as `expired`; Resend 400/422 fail at once |
| Confirmation + owner new-booking notice | Waited for the 5-minute cron | Sent right after the booking via `waitUntil` (`dispatchBooked`), same checks and launch gate; the cron stays the fallback; atomic claims mean no duplicates |
| Booking: unknown Google outcome | Cleanup delete was best effort and silent: a customer could keep an invitation for a booking we reported as failed | `removeEvent` result checked; failure = open `calendar.google` incident; cron `retryEventCleanups` removes it later |
| Booking: operational failures | Only an analytics event | `booking.failed` (open until the next success: `booking.recovered`) |
| Booking page: no times because the lookup failed | Not visible anywhere | `availability.failed` (≤ 1 row / business / 5 min; never for "no free time"); `availability.recovered` closes it; also from the receptionist's lookups |
| Lead messages / SMS | Already safe: unknown SMS outcome never resent; email retries keep the same Idempotency-Key within 30 min; stuck `sending` closed as `interrupted`; quiet hours move texts to morning | None |
| Time zones | Message times rendered in the business time zone at send time; quiet hours use the business time zone | None |
| One booking per conversation | Lead id claimed on the conversation row; conditional lead UPDATE; UNIQUE (customer, start_at) | None (covered by tests) |

Not changed (by design): MESSAGES_LIVE, SMS_LIVE, kill switch, recipientAllowed, offerSmsFor.

### Operational event codes (for founder alerts)

| Event (`audit_log.action`) | capability | resource | outcome |
| --- | --- | --- | --- |
| booking.failed / booking.recovered | calendar.google | business | failure / success (details.error: calendar_unavailable, calendar_error, booking_failed, storage_error) |
| booking.event_cleanup | calendar.google | calendar_event | failure (details.reason: unknown_outcome, already_booked, record_failed; details.error) / success |
| availability.failed / availability.recovered | calendar.google | availability | failure (details.error) / success |
| followups.send_failed, followups.delivery_failed (existing) | followups.sms / followups.email | message | failure |

Voice per-turn and socket events stay in `receptionist_events` (per conversation, purged with it): `voice_turn`
(ok 0/1, detail `r=ok|stale|busy|failed;…`), `voice_frame:bad_response_id`, `voice_socket:reconnected`,
`turn:talked_over`, `model:<code>` (model_timeout, model_unreachable, model_rate_limited, model_http_<n>, no_reply).
Capabilities registered: `receptionist.chat`, `receptionist.voice`. Outbox mail closed by age: `email_outbox.error =
'expired'`. Existing hooks an alert could use: the cron run (`functions/api/cron/run.js`) and Business Review's
open-failure query (server/ops/review.js `openFailures`).

## 7. Voice providers (recommendation only; no switch, no signup)

| Provider | Custom LLM (keeps our Claude engine + tools) | Barge-in / turn-taking | Price (platform, excl. LLM) | Source | Label |
| --- | --- | --- | --- | --- | --- |
| Retell (current) | Yes, WebSocket custom LLM | Own model; responsiveness, interruption_sensitivity, denoising settable | ~$0.07/min base; custom LLM no charge | docs.retellai.com (protocol, agent fields); price: third-party (flexprice.io, dupple.com) | Protocol verified; price preliminary |
| Vapi | Yes, OpenAI-compatible streaming endpoint | Configurable | ~$0.05/min platform + STT/TTS/LLM | docs.vapi.ai/faq; price third-party | Preliminary |
| ElevenLabs Agents | Yes (custom LLM, cost pass-through) | Own turn-taking model; eagerness/timeouts | ~$0.08–0.10/min | elevenlabs.io/docs/agents-platform/customization/llm; price third-party | Preliminary |
| Twilio ConversationRelay | Yes, WebSocket (text in/out) | Twilio STT/TTS + interruption events | $0.07/min + voice minutes | twilio.com/en-us/products/conversational-ai/pricing | Price from vendor page (search summary) |
| OpenAI Realtime | No: speech-to-speech with OpenAI models (would replace Claude and our guards' model) | Server VAD | Token-based | not researched in depth | Preliminary |
| Pipecat / LiveKit Agents | Yes (we host the pipeline) | We tune VAD/turn detection ourselves | Infra + chosen STT/TTS | not researched in depth | Preliminary |

**Recommendation: tune Retell config** (after the code fixes above), measured in one approved live test with and
without `--tuned`. Investigate an alternative only if the live numbers miss the targets with our overhead shown to be
small. Switching now would not address the defects found, which were in our code.
