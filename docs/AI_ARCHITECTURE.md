# AI architecture: efficiency review (2026-11-23)

Measured = production records (counts, tokens, timings; never content) or a local bench. Estimated = computed from
recorded sizes and list prices. Samples are small (39 voice turns, 29 conversations); treat them as direction.

## Features

| Feature | Model, who pays | Latency (measured) | Tokens / cost per use |
| --- | --- | --- | --- |
| Receptionist chat | Claude Opus 5.5, low effort; GetShowUps | not recorded per event | $0.0155 per turn (measured, 25 turns) |
| Receptionist voice (Retell path) | same engine | median first words about 2.5 s (recent tuned turns), 4.9 s before; caller-interrupted turns 16 of 39 | $0.0109 per saved turn (measured, 39 turns); interrupted turns were not counted |
| Voice on OpenAI / ElevenLabs | the provider's model; GetShowUps | provider side | $0.08 per minute (estimate, server/voice/providers.js) |
| Teach Your AI | fixed patterns first, else Opus 5.5 low | not recorded before | about $0.01-0.02 per model request (estimate) |
| Website, included | Workers AI Mistral Small | 6.4 s avg (measured) | 983 in / 346 out, $0.0005 (measured) |
| Website, own key | owner's Claude/OpenAI; owner | 30 s OpenAI, 47 s Sonnet, 138 s Opus (measured averages) | 3.8k/3.1k, 20k/8.7k, 30k/18k tokens (measured) |
| Text follow-ups | Workers AI Mistral Small (off) | none | under $0.001 (estimate) |
| Ads plan | Opus 5.5, reserved against a monthly cap | none recorded | 15¢ reserved |

## Changed, with evidence

| Finding | Before | After |
| --- | --- | --- |
| Records read one after another each turn, the profile twice | model asked after 488 ms at 60 ms per read (bench); production voice turns cancelled before the model took about 720 ms | 123-125 ms at 60 ms per read (bench). Production gain to be read from `voice_turn` events |
| Only the prompt was cached; history paid at full price on every model call | estimate $0.911 for the 8 longest conversations ($0.755 recorded) | estimate $0.511, 44% less; short 3-turn chats 8-22% |
| Interrupted or losing turns never recorded their cost, so limits undercounted | 16 of 39 voice turns | completed calls in full; an aborted call counts what the stream reported at its start (a lower bound) |
| Teach Your AI model calls: 30 an hour, no daily limit, cost not stored | up to 720 a day per business | 60 a day; cost and latency stored (`ai_teach_model` events) |

Prompts, models, tools and answers are unchanged.

## Reviewed and left alone

- **Models.** Opus 5.5 at low effort for the receptionist. Sonnet 5.5 is half the list price, but no quality evidence
  exists here; changing it needs `test/receptionist-eval` run live on both (paid, approval). Lightweight models already
  handle website copy and texts; deterministic code handles details, areas, times and most Teach requests.
- **Context.** Prompt plus tools is about 2,500 tokens, records only, stable per business.
- **Timeouts and retries.** Every call is bounded: chat 25 s and voice 10 s with one SDK retry (so up to twice that),
  Teach 20 s with one, own-key 120 s (designer 600 s) with none. Failure gives the fixed reply with the booking link.
- **Isolation.** Business from the signed conversation or call record; tools bound to it; prompt caching is per exact
  prefix, which contains that business's records, so nothing crosses tenants.
- **Triggers.** Model calls follow a customer message or an owner action. No background model calls except the follow-up
  assistant (off).
- **One `model_http_400`** in production: the cause was not recorded; unknown.

## Scale (estimate)

Per business: 100 chats a month × 5 turns at $0.0155 = $7.75, about $4.30 with history cached (if the 44% holds).

| Businesses | Before | After | Worst case under today's $5/day cap |
| --- | --- | --- | --- |
| 10 | $78/month | $43/month | $50/day |
| 100 | $775/month | $434/month | $500/day |
| 1,000 | $7,750/month | $4,340/month | $5,000/day |

Limits that matter: the provider's account-wide rate limit (all businesses share one key; not visible from here) at
100+, and there is **no platform-wide daily ceiling**. The cap is check-then-spend, so concurrent turns can pass it by
one turn each. Rate limits fail open on a storage error. Next, if traffic grows: a platform ceiling, then the model eval.
