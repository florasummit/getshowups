# Comms reliability (Agent B, 2026-11-19)

Branch `feat/comms-reliability`. Scope: Retell voice receptionist, email/SMS automation, receptionist booking tool,
observability. No gate, switch or provider was changed; nothing live was called.

## Plan

1. Audit the Retell custom-LLM socket (server/receptionist/voice.js) and the engine's voice path (engine.js) against
   Retell's published protocol; fix defects in our code.
2. Deterministic latency harness: mocked Retell frames + mocked Anthropic (loopback mock origin), measuring
   time-to-first-chunk, turn time, tool latency, interruption and stale response_id behaviour. Per-turn timings
   recorded as numbers only (receptionist_events `voice_turn`).
3. Provider comparison (docs/VOICE_PROVIDER_COMPARISON.md): recommendation only.
4. Email/SMS hardening: unknown-outcome resends, burst after outage, retry/backoff, quiet hours. No gate changes.
5. Booking tool: unknown Google outcome, orphan events, double-confirm, one booking per conversation.
6. Observability: recordEvent for failures/recoveries, receptionist capabilities in server/ops/catalog.js, tests.
