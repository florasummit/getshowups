# Research Vault

Confidential research workspace at `/admin/research-vault`. Stage A (0–10 customers): built to cost **$0 more** per month.
Deterministic: no AI calls, no cron job, no outside requests, no new dependency, no new infrastructure.

## Access
- **Who**:
  - the founder: `RESEARCH_FOUNDER_EMAIL`, who must also be in `PLATFORM_ADMIN_EMAILS`
  - research members: `research_members`, role `director` or `researcher`, granted and revoked by the founder (directors
    can grant researchers)
  - A platform admin alone is not enough.
- **Refusals**: signed out, not an admin, not a member, the vault switched off, tables missing, cross-site requests. Every
  one gets the same `404 {"error":"not_found"}`, and the page shows "Not found". Refusals of signed-in admins are audited
  (`research.access_refused`).
- **Step-up**: writes need a sign-in from the last 12 hours. The existing sign-in has no second factor, so this is the
  strongest step-up available without new infrastructure.
- **Nothing public**:
  - The route is in no navigation and is `noindex`, but security never relies on that: the server authorizes every
    request.
  - Formulas, derivations and checks exist only in `server/research/` (Functions code, never shipped to browsers). A
    test confirms no formula text is in the browser bundle.
  - Customer-facing code and assistants never import `server/research/` (also tested).
- **Audit**: every create, update, link and member change is in the hash-chained `audit_log` (capability
  `research.vault`, ids only).

## What works (Stage A)

| Capability | How |
| --- | --- |
| Knowledge graph | `research_nodes`: one store for questions, theses, assumptions, hypotheses, models, experiments, observations, evidence, counterexamples, recommendations, outcomes and notes. `research_edges` links them (supports, contradicts, assumes, tests, derives, informs, answers, supersedes, measures). No graph database. |
| History | Every change is a new version with a reason in `research_versions`. Versions and links are append-only (database triggers), so contradictions stay recorded. Concurrent edits are refused (409), never overwritten. |
| Required rigor | Refused when missing, never filled in: hypotheses need a falsifier and assumptions; theses and models need assumptions; experiments need primary outcome, design, assignment, success criteria, stopping rule and budget limit **before** they start; recommendations need all of: what improves, why, KPI, action, risks, evidence, uncertainty, validation status, what invalidates it, approval, success criteria, follow-up. |
| Traceability | `trace` follows the links backwards from any record (e.g. a recommendation) to its assumptions, model, evidence and counter-evidence, and counts the contradictions. |
| Model registry | 5 built-in, versioned models: GS-ECO-001 (square-root response, optimal spend), 002 (funnel: where a point is worth most), 003 (budget allocation, KKT), 007 (creative replacement, renewal-reward), 012 (does GetShowUps pay for itself). Each carries question, variables with units, assumptions, domain, a step-by-step derivation, limitations, references, and validation status (`illustrative` until data validates it). A changed model is a new id (`@2`). Researchers can also record their own models as text; they are never executed. |
| Proof and verification | **Learn**: the derivation, step by step. **Research**: sliders evaluate the model on the server. **Challenge**: the documented counterexamples (where each result fails) plus "Run the checks": finite-difference stationarity, concavity, independent search, break-even and KKT equalization, units. They are labelled `numeric` or `derivation`. **Formal proof: not verified**; no proof assistant is integrated and it is never claimed. |
| Visualization | A 2-D curve with markers (optimum, budget, break-even), parameter sliders, and a results table, redrawn as sliders move (server-evaluated, 150 ms debounce). |
| KPIs | The same functions as the dashboards: `growthMeasure` (GetShowUps itself, as Admin → Growth), `funnel` (per business), `spendToday` (AI spend). Each value is tagged measured, estimated, simulated, test, missing or unverified. Missing stays missing. |
| Accountability | For GetShowUps-owned businesses: rates with Wilson intervals only when n is large enough, losses per stage with **possible** causes and attribution "unknown" (never blame), and a warning against buying demand when visits aren't happening. Provider attendance is reported **missing**: "happened" doesn't say which side failed. |
| Experiments | Sample-size calculator (two-proportion test). Analysis gives **no verdict before the planned sample** ("running"), "insufficient" below 10 per group, the z-test p-value, and a Beta posterior P(treatment better). Bayesian belief update for rates. |
| Decision queue | Recommendations ranked by expected net value range = probability × benefit (low/high) − cost. Unquantified recommendations are listed last and never given a value. |
| Evidence scan | On request only: last 30 days vs the 30 before, per GetShowUps-owned business. It proposes an observation only with ≥ 20 cases per window and p < 0.01; otherwise it stays dormant and says so. |
| "What is unproven" | Deterministic challenge of the records: unsupported hypotheses, recommendations with no evidence, contradicted records not re-assessed, running experiments without a plan, approved recommendations on illustrative models. |
| Programs | Records of kind `program`, imported from a file the founder keeps outside this public repository ("Import records"). Each shows "Has data" or "Dormant", computed from the data requirements it names (server/research/programs.js `NEEDS`), never set by hand. |

## Data and permissions
- **Read**: GetShowUps corporate metrics, and the funnels of businesses whose account type is `internal_live` (GetShowUps-
  owned, e.g. PoolThru). **Customer businesses are never read.**
- **Cross-account research is off** (`CROSS_ACCOUNT`). It needs a legal basis and customer permission (Terms/DPA) first.
  When enabled: aggregates only, cohorts of at least 5, no personal data.
- **Stored**: only research records. No personal data, no conversations, no payment data.

## Deferred, and why

| Deferred | Why | Trigger to build |
| --- | --- | --- |
| AI research assistant | Paid inference must stay off, and research would leave our systems | Founder approval + a cost ceiling via `server/ai-budget.js` |
| Formal verification (Lean 4), symbolic algebra (SymPy) | Needs a Python or proof-assistant runtime: new infrastructure | A model whose correctness matters enough to pay for it |
| Cross-account learning | Legal basis and customer permission | Terms/DPA allow it, and ≥ 5 comparable businesses |
| Analyses that need outside data | No authorized data source; no scraping, no paid data | An approved import or integration |
| Provider-attendance measurement | Not recorded in the product | A product change to record who missed a visit |
| Automatic triggers (scheduled scans) | No cron by design at Stage A | Measured value from manual scans, Stage B |
| 3-D surfaces, contour plots | 2-D plus sensitivity first | A model where two parameters interact enough to need them |

## Costs and resources
- **Money**: $0 more. It uses existing D1 and Functions; no AI, no cron.
- **Requests**: each page view is a few indexed D1 reads; slider moves are one Function call each, rate-limited (300
  reads and 240 writes per 10 min per researcher).
- **Storage**: bounded at 5,000 records, lists cap at 200, traces at 80 records.

## The first useful experiments (when PoolThru has traffic)
1. **Two offered times vs open calendar** (GS-ECO-002): booked ÷ qualified.
2. **Receptionist greeting that asks the job first**: qualified ÷ leads.
3. **Reminder the day before** (needs MESSAGES_LIVE approval): happened ÷ booked.

Use the sample-size calculator first. At PoolThru's volume, a 10-point change needs a few hundred qualified leads, so
record these as running experiments and read them once, at the planned sample.
