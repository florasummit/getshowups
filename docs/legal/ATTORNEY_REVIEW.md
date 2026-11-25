# Legal readiness: attorney-review package

Prepared 2026-11-19 by the engineering coordinator for the owner and the attorney. **Not legal advice; no attorney has
reviewed anything yet; nothing is published.** It checks docs/legal/TERMS_DRAFT.md and docs/legal/PRIVACY_DRAFT.md
against the product as built (main 425d311) and lists what is missing or inconsistent. Labels: **[FACT]** checked in
code or config docs on 2026-11-19 · **[GAP]** missing or inconsistent · **[Q]** question for the attorney.

## 1. Document inventory

| Document | Exists | State |
| --- | --- | --- |
| Terms of Service | docs/legal/TERMS_DRAFT.md | Draft with open [DECISION]s; `/terms` does not exist on the site (it falls through to the home page) |
| Privacy Policy | Live `/privacy` (src/legal/Privacy.jsx) + docs/legal/PRIVACY_DRAFT.md (update) | Live page written for Google OAuth review; draft adds billing, website, AI keys, Meta/GHL |
| Refund Policy | Only Terms §4 (three options) | **[GAP]** no standalone policy; owner decision is **discretionary** = Terms §4 Option C |
| Data Processing Addendum | **None** | **[GAP]** owner decision is "DPA available"; no draft, no subprocessor list document |
| SMS program terms | Live per business at `/sms-terms/<id>` (generated from records) | Texting is not live; carriers review the opt-in before approval |

## 2. Owner decisions to apply to the drafts (already made)

| Decision | Where it goes | Draft today |
| --- | --- | --- |
| Refunds discretionary | Terms §4: keep Option C, delete A/B | Three options still listed |
| Tax-exclusive pricing | Terms §3 "Taxes" | Still "[DECISION: exclude / include]"; wording pending the accountant (ACCOUNTANT_PACKAGE.md Q9) |
| 30 days' notice | Terms §3 price changes and §11 Terms changes | Still "[DECISION: 30]" in both |
| DPA available | Terms §7 + a DPA document + subprocessor list | Still "[DECISION/attorney: whether a DPA is offered]" |

## 3. Facts from the product that the documents must match

| Topic | Product behaviour [FACT] | Draft consistency |
| --- | --- | --- |
| Renewal | Monthly in advance via Stripe; no trial; no setup fee | Matches Terms §3 |
| Cancellation | Owner cancels in Stripe portal; effective at period end; no proration; site online +14 days; data recoverable 90 days | Matches Terms §5 and the public FAQ |
| Failed payment | Stripe retries; service continues; ads managed by us paused (billed businesses); no automatic lock-out. Stripe must be set to cancel after the final retry (not yet verified in live Stripe) | Terms §3 matches; [VERIFY] stays |
| Suspension | Manual, audited admin action only | Matches Terms §2 |
| Account deletion | Built, switched off (`ACCOUNT_DELETION_ENABLED`); retention schedule not approved | Terms §5 / Privacy note it; retention [DECISION] open |
| Email to customers' leads | Built; **not live** (`MESSAGES_LIVE` off; only test recipients). Public site says "coming soon" | **[GAP]** Terms §6 "Messages" describes confirmations/reminders as current. Say "when enabled" |
| Follow-up email footer | Unsubscribe link + one-click headers; says sent by GetShowUps for the business; **no postal address** | **[Q]** below (CAN-SPAM) |
| Texts | Built; not live; consent box only when registration approved; STOP/START/HELP handled | Terms §6 says "once texting is approved" (ok) |
| AI receptionist | Built; **owner can switch it on** (chat + browser voice; no phone numbers, no transfers). Page says "AI assistant for <business>, powered by GetShowUps. It can't transfer calls." Transcripts of typed and spoken lines are stored and shown to the owner; purged after 12 months. Retell's own recording/retention settings are not set by us (account defaults apply) | **[GAP]** no notice to the caller that the conversation is recorded/transcribed. Not advertised on the pricing page, yet Terms §1 lists it as part of the Service |
| Ads | Off except allowlisted businesses; campaigns created paused, owner-approved budgets; ad spend billed by Google/Meta to the business | Terms §6 matches; [VERIFY] availability |
| Data ownership | Owner owns content and customer data; export of the published site; we never change DNS | Terms §7 matches |
| AI training | No training on customer data (our policy); provider terms not yet cited | Privacy [VERIFY] stays |
| Sessions | Expire after 7 days (server/auth.js) | Privacy matches |
| Support contact | Dashboard uses hello@getshowups.com; live `/privacy` lists a personal address | **[GAP]** pick one role address for privacy/support (LAUNCH_CHECKLIST A2) |

## 4. Subprocessors (input for the DPA and Privacy "Sharing")

From the code [FACT]; the owner confirms which are active at publication:

| Provider | Purpose | Active today |
| --- | --- | --- |
| Cloudflare | Hosting, database, storage, Workers AI (website text) | Yes |
| Google | Sign-in, Calendar (free/busy, own events), Ads | Yes (Ads allowlist only) |
| Stripe | Billing | Sandbox only |
| Resend | Email delivery | Test recipients only |
| Twilio | Texts (one subaccount per business) | No |
| Anthropic | AI receptionist model | Yes, where an owner switched it on |
| Retell | Voice calls (speech recognition, voice) | Configured; used where an owner switched voice on |
| OpenAI / Anthropic (owner's own key) | Website design under the owner's account | Optional, owner's contract |
| Meta, GoHighLevel | Lead ads, CRM sync | Off unless enabled per business |

## 5. Questions for the attorney (written answers needed)

**Entity and law**
1. Legal entity name, state of organization and address for the Terms, Privacy and DPA (owner supplies facts; see
   ACCOUNTANT_PACKAGE.md F1–F3). Governing law, venue or arbitration, class-action waiver for a B2B SaaS.
2. Warranty disclaimer, liability cap (draft suggests fees paid in the prior 12 months), indirect-damages exclusion,
   indemnities (including for owner-supplied content, photos and claims on their website).

**Subscription, renewal, refunds**
3. Automatic-renewal disclosures: do state auto-renewal laws (e.g. California's) apply to a business-only subscription,
   and is any checkout disclosure, consent or cancellation-method wording needed?
4. Discretionary refunds: wording that keeps discretion without conflicting with consumer-protection or card-network
   rules; how to state it at checkout; interaction with tax already collected.
5. Price and Terms changes with 30 days' email notice: is continued use after notice enough for acceptance?
6. Service availability: is "no uninterrupted-service promise" enough, or is a support/availability statement needed
   given "direct help from the founding team" is in the plan?

**Data protection**
7. Controller/processor roles for the leads and customers of each business (we process for the business; we also use
   aggregate, non-personal events). Is a processor model right?
8. DPA scope: which laws to address (CCPA/CPRA service-provider terms, other US state laws; GDPR only if we serve EU
   residents), subprocessor list and change notice, security measures annex, breach notice timing, deletion on
   termination consistent with the 90-day recovery and the unapproved retention schedule.
9. Retention after the 90-day recovery period, billing-record retention (draft: 7 years) and backup expiry (draft: 30
   days); what may be kept after account deletion.
10. Security commitments: what may we state (encryption of tokens/keys, tamper-evident audit log, staff access limits)
    without creating warranties we cannot measure?

**AI receptionist and voice**
11. Notice before a caller speaks: is an "AI assistant" label enough, or do recording/transcription disclosures and
    consent apply (all-party-consent states for recording, state AI/bot disclosure laws)? Who gives the notice: us
    or the business?
12. Does storing transcripts for 12 months and showing them to the business need specific Privacy wording or the
    business's own notice?
13. The receptionist can make mistakes and cannot handle emergencies (it directs callers to 911). Is the Terms §6
    language adequate, and does the business need to accept specific terms before switching it on?

**Messaging**
14. Email: are the lead follow-up and no-show re-booking emails "commercial" under CAN-SPAM? If so, whose postal
    address must appear (the business's or ours) and who is the "sender"?
15. SMS: confirm the consent language on the booking form and website forms, the per-business `/sms-terms` page,
    STOP/HELP handling and quiet hours meet TCPA and carrier (CTIA / A2P 10DLC) expectations; who is the sender of
    record (the business, on its own Twilio subaccount)?

**Advertising**
16. Ad account permissions: wording for acting in the business's Google/Meta accounts (paused creation, owner-approved
    budgets, pause on billing problems, no unattended changes) and for responsibility for ad content and spend.

**Website**
17. Website content: owner responsibility for claims, photos and legal pages imported from their old site (we keep
    imported legal text word for word); licensed stock photos (CC0) attribution needs.
18. Domain: we never change DNS; is any statement needed about the bare domain staying with the owner's provider?

## 6. Blockers before publication (in order)

1. Owner fills every [DECISION] (entity, contact address, decisions in §2, retention).
2. Resolve the receptionist position: inside the paid plan at launch, beta, or off (see LAUNCH_READINESS.md). The
   Terms, Privacy and tax analysis must describe the same thing.
3. Change Terms §6 "Messages" to describe email/text as available only when enabled.
4. Draft a DPA and subprocessor list (attorney) since the owner decided it is available.
5. Attorney review of Terms, Privacy, DPA (questions above).
6. Owner approves final text; then one engineering PR adds `/terms` (and the refund wording inside it) and updates
   `/privacy`, keeping the Google sections word for word (OAuth review). Not before.

## 6. Added 2026-11-24 (for the same review)
- Live privacy policy changed (safeguards, Google data and AI, sharing, retention, the dashboard assistant). Please review as published.
- Pilot: an unbilled founder-assisted pilot (docs/pilot/CUSTOMER_ZERO.md) needs short written terms before it starts. [Q]
- AI assistant: answers owners' questions and prepares changes; needs a limitation in the Terms (may be wrong, not advice). [Q]
- Refunds: owner decision is discretionary (Terms §4 Option C); confirm state-law limits. [Q]
- Providers to list: Cloudflare (including Workers AI), Google, Resend, Twilio (not active), Anthropic, OpenAI (voice today), ElevenLabs and
  Retell (selectable), Stripe (test mode). [FACT]

## 7. Added 2026-11-25: account controls (please answer with the numbered questions above)

The unnumbered questions in the section above are 19 (pilot terms), 20 (AI assistant limits) and 21 (state-law limits on
discretionary refunds). [FACT] Cancel, keep, export, people, connections and closing are now in Settings; see POLICY_MAP.md.

22. Recovery window before erasure: none (decided 2026-11-14) or 14 days (proposed)? Must deletion requests from individuals
    (the business's customers) be faster than the business's own window?
23. May the longest-standing member alone close a business that has several people? What notice do the others need?
24. Cancelling online: does the confirmation in Settings meet "click to cancel" and renewal-notice rules that apply to us?
25. An owner who cancels while a payment is overdue: the unpaid invoice stays due. Wording?
26. Outstanding amounts when a business is deleted: billing ends at once and nothing further is charged. Acceptable?
27. Ads that keep running in the customer's own ad account after closing: is our notice enough?
28. The id-and-date marker and the permanent log kept after deletion (no personal data): acceptable, and how to disclose?
29. Feature restrictions and suspension: notice and appeal wording.
