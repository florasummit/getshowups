# GetShowUps Privacy Policy — DRAFT (update of the live /privacy page)

> **DRAFT for the owner's review. Not legal advice and not published.** The live page (src/legal/Privacy.jsx) is
> accurate about Google data and was written for Google's OAuth review; **keep its Google sections word for word**
> (Google checks them). This draft adds what the product does today that the live page doesn't cover: paid plans
> (Stripe), website hosting, forms and imports, your own AI keys, Meta and GoHighLevel, cancellation and deletion.
> **[DECISION]** marks choices for you; **[VERIFY]** marks facts to confirm; have an attorney check CCPA/CPRA and
> other state laws (and GDPR if you serve EU residents). Publishing needs your approval.

Last updated: [DATE]

## Who we are

GetShowUps (getshowups.com) is operated by **[DECISION: legal entity]**. It helps service businesses turn requests into
booked appointments. Contact: **[DECISION: privacy@ / support@ address instead of a personal one]**.

Two kinds of people use GetShowUps: **business owners** (our customers) and **their customers** (people who visit a
business's website, request or book an appointment, or talk to its AI receptionist). For their customers' information,
the business decides why it is collected; we process it to run the business's GetShowUps services.
**[Attorney: confirm controller/processor wording.]**

## Information we collect

*(Keep the live page's items for: Google sign-in, Google Calendar, Google Ads, booking requests, appointment messages,
AI receptionist conversations, product usage and security. Add:)*

- **Billing (business owners).** When you subscribe, Stripe collects your payment details; we never receive or store
  card numbers. We keep your plan, subscription status, billing dates, amounts and Stripe identifiers.
- **Your website.** The business information, text, photos and logos you add, the versions you publish, and your own
  domain if you connect one.
- **Website import.** If you ask us to bring in your existing website, we read its public pages (respecting robots.txt)
  and keep what we found so you can choose what to use.
- **Website forms.** If your website has a contact or quote form, we receive what visitors submit (name, contact
  details, message, ZIP) and pass it to you like a booking request, with the ad campaign tags of the visit if any.
- **Service-area requests.** If someone outside your listed ZIP codes asks for service, we keep their request so you
  can decide whether to serve them.
- **Visit outcomes.** Whether an appointment happened, and amounts you choose to record for it (estimated, invoiced or
  paid).
- **Your own AI key (optional).** If you connect your own Claude or OpenAI key, we store it encrypted and show only its
  last 4 characters. Website-design requests made with it go to that provider under your account with them.
- **Meta and GoHighLevel (optional).** If you connect Meta, we receive ad account details and leads from your lead
  forms; if you connect GoHighLevel, we send contacts and booking stages to your GoHighLevel account.
  [VERIFY: Meta/GHL enabled for any business at publication.]

## How we use information

To provide the Service: host your website and booking page, offer times from your calendar, book appointments, send
the messages you turn on, answer customers with the AI receptionist, run and report on ads you approve, bill your plan,
keep the Service secure, and comply with law. **We do not sell personal information, do not use it for cross-site
advertising, and do not use your or your customers' data to train AI models.**

## AI processing

- The AI receptionist uses Anthropic's Claude to understand and answer customers, using only that business's
  information. Voice calls run through Retell (speech recognition and voice).
- Website text and designs may be generated with Cloudflare Workers AI or, if you connect one, your own Claude or OpenAI
  key. Only your business information is sent; never your customers' personal data.
- **[VERIFY with providers: their data-retention / no-training terms for API data, and cite them.]**

## Sharing

With the business the person contacted; and with service providers that run GetShowUps: Cloudflare (hosting, storage,
Workers AI), Google (sign-in, Calendar, Ads), Stripe (payments), Resend (email), Twilio (texts, when enabled), Anthropic
(AI receptionist), Retell (voice), and, only if a business connects them, Meta, GoHighLevel, OpenAI or Anthropic under the
business's own account. We may disclose information if required by law, or to a successor if the business is
transferred **[Attorney: merger/acquisition clause]**. We do not share mobile numbers or texting consent with third parties
for their marketing.

## Retention

- Sessions expire after 7 days; rate-limit records are short-lived.
- Conversation text in a business's inbox (texts and emails we send on its behalf) and AI receptionist conversations
  are deleted 12 months after their last activity.
- Google Ads click identifiers (only if conversion reporting is on) are kept encrypted for up to 90 days.
- **Canceled businesses:** the website stays online 14 days after the paid period; all data is kept and recoverable for
  90 days. After that: **[DECISION: approve the retention schedule (docs/DATA_RETENTION.md §2) and state it here — today
  data is kept until deleted on request.]**
- **Account deletion:** website taken offline, Stripe billing canceled, connections removed and business data erased.
  Kept: billing records for **[DECISION: 7]** years (tax and accounting) and security logs without personal data.
  Backups expire within **[VERIFY: 30]** days. Stripe, Google and Resend keep their own records under their policies.

## Your choices and rights

- Business owners: access, export (your website), correct, or delete your data from the dashboard or by emailing us.
- Customers of a business: contact that business, or us, to access or delete your information; reply STOP to texts;
  use the unsubscribe link in follow-up emails.
- **[Attorney: state-law rights wording (e.g. California), response times, and verification of requests.]**

## Security

Data is stored with Cloudflare. Access tokens and AI keys are encrypted; access to business data is limited to that
business's signed-in users and authorized GetShowUps staff for support; staff actions are recorded in a tamper-evident
audit log.

## Added 2026-11-25 (facts of the product; wording for review)

- **Assistant history:** the owner's conversation with the dashboard assistant is kept in that owner's browser only (not on
  our servers) until they sign out, delete the business or account, or clear it. [FACT: the live policy says we don't store
  it, which is true of our servers, but its browser-storage section doesn't list this. Must be added.]
- **Demo booking:** the homepage now uses our own booking page, not Google's scheduler. [Live policy to correct.]
- **People and sessions:** owners invite others by email; we keep who belongs to a business, pending invitations and sign-in
  sessions (7 days). Each person chooses which notices they get.
- **Export:** the owner can download the business's data; the download is recorded, not its contents.
- **Closing:** while online deletion is off, a request is recorded and handled by a person. When on: see DATA_RETENTION.
  A marker holding only the business id and a date is kept outside the database so a restored backup can't bring a deleted
  business back.
- **Disconnecting:** for Google Calendar we delete our access and, if no other connection uses the same Google account, ask
  Google to revoke it. For Google Ads, Business Profile, Meta and ChatGPT ads we delete our access only; the provider's own
  permission is removed by the owner there.
- **Call reports (off):** "If a business turns on call reports, we read from Google Ads the time, length and answered or
  missed status of calls from its ads, not the caller's number or recordings." [Needed before GOOGLE_CALLS_ENABLED.]

## Children, changes

Unchanged from the live page.
