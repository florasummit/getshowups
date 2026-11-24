// Public privacy policy at /privacy. Required by Google for publishing the OAuth app; it must describe
// exactly what the product does with Google user data. Keep it in sync with server/ behaviour.
import '../app.css'

const UPDATED = 'November 24, 2026'

export default function Privacy() {
  return (
    <main className="app-main legal">
      <p className="eyebrow-sm">
        <a href="/">GetShowUps</a>
      </p>
      <h1 className="title title--page">Privacy Policy</h1>
      <p className="fine">Last updated {UPDATED}</p>

      <h2>Who we are</h2>
      <p>
        GetShowUps (getshowups.com) helps service businesses turn booking requests into confirmed appointments. Questions
        about this policy: <a href="mailto:brandon@getshowups.com">brandon@getshowups.com</a>.
      </p>

      <h2>Information we collect</h2>
      <ul>
        <li>
          <strong>Business owners who sign in with Google:</strong> your verified Google account email address, used only
          to sign you in and to connect you to your business.
        </li>
        <li>
          <strong>Google Calendar, when a business connects it:</strong> the connected Google account’s email address and
          account identifier, and permission to see when the calendar is busy (free/busy only, not event details) and to
          create and manage the appointment events GetShowUps adds to calendars the business owns.
        </li>
        <li>
          <strong>Google Ads, when a business connects it:</strong> permission to manage the business’s Google Ads
          account; the names, IDs and currency of the Google Ads accounts that sign-in can use; and the settings, budgets,
          keywords, ads, review status and daily performance figures (cost, clicks, impressions and conversions) of the
          campaigns GetShowUps creates and of the campaigns already in the account. For Local Services Ads we read lead
          records such as type, time and whether they were charged, not contact details or message contents. We never receive or store advertising payment details: Google bills the business
          directly.
        </li>
        <li>
          <strong>People who request an appointment on a booking page:</strong> the name, email address, phone number,
          service request, and ZIP code they enter, and, for businesses that visit their customers, the service address. These are shared with that business so it can serve them, and are
          included in the appointment added to the business’s Google Calendar, which sends you a calendar invitation.
        </li>
        <li>
          <strong>Appointment messages:</strong> if the business has automatic messages turned on, we email you on its
          behalf about your request and appointment: a reminder to pick a time if you haven’t booked, a booking
          confirmation, reminders before the appointment with a link to confirm you’ll attend, and an invitation to
          rebook if the appointment was missed. We send text messages only if you tick the box to receive them or text the business first; you can
          reply STOP to any text to opt out and HELP for help. We record whether each message was sent and whether you confirmed. Texts
          you exchange with the business, and the emails we send you on its behalf, are kept for the business’s inbox for up to
          12 months and then deleted.
        </li>
        <li>
          <strong>AI receptionist conversations:</strong> if a business turns on its AI receptionist, what you type in its
          chat or say on a voice call with it (and what you share there, such as your name, phone, email and ZIP code) is
          used to answer you from that business’s own information, check its calendar and book the appointment you
          confirm. The conversation, what the receptionist did and the outcome are kept for that business for up to 12
          months and then deleted. Voice calls use your microphone only while the call is on.
        </li>
        <li>
          <strong>Help for business owners:</strong> when an owner asks the dashboard assistant a question or asks for help
          with wording, the question or text, the business’s own settings and counts (for example inquiries, bookings and
          ad spend) are sent to an AI model to write the answer. When the owner asks about appointments or inquiries, the
          assistant also sends their dates, status, ZIP code and what the person asked for, with email addresses, links and
          phone numbers removed. We don’t add customers’ names, contact details or service addresses, or the messages they
          exchange with the business. Anything the owner types, such as a name, is sent as typed. We don’t store the
          assistant’s conversation.
        </li>
        <li>
          <strong>Product usage and security:</strong> records of actions such as sign-ups and bookings without names or
          contact details, the campaign source of a first visit (for example a utm_source link), the ad campaign tags of a
          booking request that came from an ad (and whether a Google click identifier was present) so the business can see
          which ads lead to bookings; if a business turns on conversion reporting, the Google click identifier itself is
          kept encrypted for up to 90 days so that request, its booking and a completed job can be reported to that
          business’s own Google Ads account (no names or contact details are sent), one-way hashed IP
          addresses kept briefly to limit abuse, and standard request logs processed by our hosting provider.
        </li>
      </ul>

      <h2>Cookies and browser storage</h2>
      <p>
        We use essential, secure cookies to keep you signed in and to protect the Google sign-in and calendar connection
        steps. Your browser also stores the campaign source of your first visit and a pending invitation link. We do not
        use advertising or cross-site tracking cookies.
      </p>

      <h2>Demo booking on our website</h2>
      <p>
        The “Book a Demo” scheduler on getshowups.com is provided by Google Calendar appointment scheduling. Information
        you enter there is handled by Google under its privacy policy and shared with us so we can meet with you.
      </p>

      <h2>How we use Google user data</h2>
      <p>
        We use Google data only to provide the booking features a business turns on: showing open times based on its
        calendar availability, adding booked appointments to its calendar, and sending the calendar invitation to the
        customer through Google. We do not read the contents of existing calendar events. We do not sell Google user
        data or use it to show advertising. Google Ads data is used only to run and report on that business’s own ads.
      </p>
      <p>
        For businesses that connect Google Ads, we use that access only to do what the business owner approves in
        GetShowUps: create the campaigns they approve (always paused until they start them), make the changes they
        request (start, pause, budget), read campaigns back to confirm they match what was approved, show the campaigns
        already in the account, and report cost and results to the business. GetShowUps never starts a campaign or raises
        a budget on its own. It may recommend changes, and it pauses the campaigns it runs if the account is suspended,
        closed or a payment fails.
      </p>
      <p>
        GetShowUps’ use and transfer of information received from Google APIs adheres to the{' '}
        <a href="https://developers.google.com/terms/api-services-user-data-policy">Google API Services User Data Policy</a>,
        including the Limited Use requirements.
      </p>
      <h3>Google data and AI</h3>
      <p>
        We do not use Google user data, or information derived from it, to develop, improve or train generalized or
        non-personalized AI or machine learning models. Some features a business turns on pass limited information derived
        from Google data to an AI provider, only to answer at that moment: the AI receptionist receives the open times it
        can offer and the booked time (never your calendar’s events or busy periods), and the dashboard assistant, when
        the owner asks, receives Google Ads totals such as spend and clicks, open booking times, and appointment times. Google sign-in credentials are never sent to an AI provider.
      </p>

      <h2>Sharing</h2>
      <p>
        Appointment requests are shared with the business the request was made to. We use service providers to run
        GetShowUps: Cloudflare for hosting, storage and the AI models behind the dashboard’s help and website writing;
        Google for sign-in, calendars and ads; Resend to deliver email; Twilio to deliver text messages; Anthropic to run
        the AI receptionist’s language model; and OpenAI for its voice calls (speech and voice). ElevenLabs and Retell are
        other voice services we can use; voice calls go to one of them only where we have selected it. Each provider
        receives what it needs for its part and keeps it under its own terms. If an owner connects their own AI account
        for website design, the business information used there goes to that provider under their agreement with it. If we
        turn on paid plans, we will also use Stripe to process payments; payment details are entered on Stripe’s pages and we never
        receive or store full card numbers. We do not sell or share personal information for advertising. We do not
        share mobile phone numbers or text-message consent with third parties for their marketing. We may disclose
        information if required by law.
      </p>

      <h2 id="security">How we protect your data</h2>
      <p>These are the safeguards in place for personal and business information, including data from Google accounts.</p>
      <ul>
        <li>
          <strong>Encryption in transit:</strong> getshowups.com is served over HTTPS, plain HTTP requests are redirected to it,
          and browsers are told to use HTTPS only. We connect to Google and our other providers over HTTPS.
        </li>
        <li>
          <strong>Encryption at rest:</strong> our databases and key storage are hosted by Cloudflare, which encrypts stored
          data (AES-256).
        </li>
        <li>
          <strong>Google credentials:</strong> the credentials that let us use a connected calendar or ads account are also
          encrypted by GetShowUps (AES-256-GCM) before they are stored, with a key kept as a server secret, separate from the
          database. They are used only on our servers and are never sent to a browser. Short-lived access tokens are not stored.
        </li>
        <li>
          <strong>Least access from Google:</strong> for calendars we ask only for free/busy times and for events in
          calendars the business owns. Connecting uses Google’s sign-in with state and PKCE checks; we never see a Google password.
        </li>
        <li>
          <strong>Sign-in:</strong> sign-in cookies are secure and unreadable by scripts. We store only a one-way hash of each session
          token, and sessions stop working after 7 days.
        </li>
        <li>
          <strong>Separation between businesses:</strong> businesses share a database, and every dashboard request is
          checked on the server so a signed-in user reaches only their own business’s records.
        </li>
        <li>
          <strong>Staff access:</strong> limited to named GetShowUps administrators, for support, security and running the
          service. Administrative changes are recorded in a log designed so that edits or removals can be detected.
        </li>
        <li>
          <strong>Logs and abuse limits:</strong> our application is written to log error codes rather than messages,
          credentials or contact details, and limits how often sensitive actions can be requested.
        </li>
        <li>
          <strong>Monitoring:</strong> automatic checks record service failures, such as a calendar connection that stops
          working, for us to review.
        </li>
      </ul>
      <p>
        No system is completely secure. If you think your information is at risk, tell us at the address at the top of this page.
      </p>

      <h2>Retention and deletion</h2>
      <p>
        We keep business and appointment information, including Google Ads figures already read, while the business uses
        GetShowUps and afterwards until it asks us to delete it. Texts and emails in the business’s inbox and AI receptionist
        conversations are deleted after 12 months. Sign-in sessions and invitation links stop working when they expire, and
        rate-limit records are short-lived.
      </p>
      <p>
        When we delete information on request, we handle the request by hand and confirm when it’s done. Copies can remain for a time in
        backups: our hosting provider’s recovery history, up to 30 days, and restricted copies we make before updates, which
        we keep until they are no longer needed. We may keep records the law requires, such as billing records, and an administrative log that
        does not hold contact details of customers.
      </p>

      <h2>Your choices</h2>
      <ul>
        <li>
          A business can disconnect GetShowUps at any time from its Google Account’s third-party access settings, or by
          contacting us. We can then no longer use that access. Ask us if you also want the stored, encrypted credential and
          account details removed.
        </li>
        <li>
          A business can disconnect Google Ads in GetShowUps (Ads → Disconnect). We then delete our stored Google Ads access
          and stop managing and reporting the account; campaigns already in Google Ads stay under the business’s control
          there. Figures already read stay in the dashboard until you ask us to delete them. We can also do this on request within 3 business days.
        </li>
        <li>
          To access or delete your information, email <a href="mailto:brandon@getshowups.com">brandon@getshowups.com</a>. If
          you booked with a business, you can also contact that business directly.
        </li>
      </ul>

      <h2>Children</h2>
      <p>GetShowUps is not directed to children under 13, and we do not knowingly collect their information.</p>

      <h2>Changes</h2>
      <p>We will update this page when our practices change and show the date of the latest update above.</p>
    </main>
  )
}
