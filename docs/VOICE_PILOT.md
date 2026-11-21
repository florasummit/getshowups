# Test-phone pilot: preparation (nothing activated)

Prepared 2026-11-21 with the Voice Lab release. **Status: preparation only.** No number has been bought, no provider
has been activated for telephony, no customer call is routed anywhere new. Production customer phone routing is
unchanged: GetShowUps still provisions no phone numbers, forwarding or transfers (server/receptionist/routing.js is
simulated only), and browser voice stays the Retell custom-LLM path for the two allow-listed pilot businesses.

## What the pilot is

One dedicated TEST number, answered by the receptionist engine through the provider the Voice Lab benchmark
recommends, on an admin-marked TEST business, with every booking in dry-run until the owner flips it. Real callers
are GetShowUps staff only. The pilot proves telephony + the engine on a phone line; it never touches a customer's
line.

## Steps (each one is an approval item with cost or routing impact)

| # | Step | Who | Approval needed |
|---|------|-----|-----------------|
| 1 | Pick the provider from the Voice Lab benchmark (docs/VOICE_LAB.md, "Benchmark"), by evidence: real-audio sessions only count as measured; simulated runs count for guards and conversation quality | founder + engineering | no |
| 2 | Buy or import ONE test number at that provider (Retell: numbers via the Retell dashboard/API or an imported Twilio/SIP number; OpenAI Realtime: SIP trunk interface; ElevenLabs: Twilio or SIP-trunk integration; details and current limits are in each provider's section of docs/VOICE_LAB.md, written against the docs on the date noted there) | founder | **yes: paid number + per-minute usage** |
| 3 | Route that number to the Lab's test business only (provider-side agent/number binding carries `business=<test id>`; our server keeps rejecting any call id it did not create) | engineering | yes (routing change at the provider, test number only) |
| 4 | Human hand-off: no live transfer exists; the engine records a callback request / message (receptionist_requests) and the owner notice path stays in MESSAGE_TEST_RECIPIENTS mode. A real transfer target (the business's own phone) is a later approval | — | later |
| 5 | Failure recovery: provider reconnects (Retell auto_reconnect ≤2 within 2 min; the Lab adapters re-mint and reconnect ≤2), engine fallback lines when the model fails, `turn:talked_over` and `model:*` events for diagnosis; the call never books without `book_appointment` returning `booked: true` | built | no |
| 6 | Call event logging: receptionist_calls (call id, provider, timings), receptionist_events (codes and numbers only), conversation transcript visible to the owner, Lab session metrics; never audio, never personal data in events | built | no |
| 7 | Recording and transcript controls: recordings stay OFF at the provider unless the founder turns them on for the test number; transcripts are the engine's text record (365-day retention, erased with the account) | founder | yes (recording = consent/retention decision) |
| 8 | Go/no-go for a customer-facing line: separate decision after the pilot, with the owner's approval of live booking (dry-run off), live messaging (MESSAGES_LIVE) and the specific business | founder | **yes** |

## Rollback

- Provider side: unbind the test number from the agent (or release the number). Our side: `VOICE_LAB_ENABLED` off
  hides the Lab and 404s its routes; `RECEPTIONIST_VOICE_BUSINESSES` unchanged throughout; `RECEPTIONIST_ENABLED=false`
  is the receptionist kill switch for every channel.
- Code: the Voice Lab release is frontend + admin-only routes + the provider adapters; reverting the merge commit
  restores the previous engine behaviour (the Retell conversation improvements ship separately as Release C).
- Data: Lab sessions are conversations on test businesses (excluded from every metric); nothing to migrate back.

## Not done, by design

No number purchased, no SIP trunk created, no provider telephony enabled, no customer number redirected, no
recording turned on, no live customer communication. Each is listed above with its approval.
