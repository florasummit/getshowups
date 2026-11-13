// Public privacy policy at /privacy. Required by Google for publishing the OAuth app; it must describe
// exactly what the product does with Google user data. Keep it in sync with server/ behaviour.
import '../app.css'

const UPDATED = 'November 13, 2026'

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
          account; the names, IDs and currency of the Google Ads accounts that sign-in can use; and, for campaigns
          GetShowUps creates, their settings, budgets, keywords, ads, review status and performance figures (cost, clicks,
          impressions and conversions). We never receive or store advertising payment details: Google bills the business
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
          rebook if the appointment was missed. We send text messages only if you tick the box to receive them; you can
          reply STOP to any text to opt out. We record whether each message was sent and whether you confirmed.
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
        data, use it for advertising, or use it to train AI models.
      </p>
      <p>
        For businesses that connect Google Ads, we use that access only to do what the business owner approves in
        GetShowUps: create the campaigns they approve (always paused until they start them), make the changes they
        request (start, pause, budget), read those campaigns back to confirm they match what was approved, and report
        their cost and results to the business. GetShowUps doesn’t change campaigns on its own; it may recommend changes.
      </p>
      <p>
        GetShowUps’ use and transfer of information received from Google APIs adheres to the{' '}
        <a href="https://developers.google.com/terms/api-services-user-data-policy">Google API Services User Data Policy</a>,
        including the Limited Use requirements.
      </p>

      <h2>Sharing</h2>
      <p>
        Appointment requests are shared with the business the request was made to. We use service providers to run
        GetShowUps: Cloudflare for hosting and storage, Google for sign-in and calendars, Resend to deliver email, and
        Twilio to deliver text messages. If we turn on paid plans, we will also use Stripe to process payments; we never
        receive or store full card numbers. We do not sell or share personal information for advertising. We do not
        share mobile phone numbers or text-message consent with third parties for their marketing. We may disclose
        information if required by law.
      </p>

      <h2>Storage and security</h2>
      <p>
        Data is stored with Cloudflare. Google calendar and Google Ads access tokens are encrypted, and access to business data is
        limited to that business’s signed-in users and to authorized GetShowUps staff for support.
      </p>

      <h2>Retention</h2>
      <p>
        We keep business and appointment information while the business uses GetShowUps, and delete it on request.
        Sign-in sessions expire after 7 days, invitation links expire automatically, and rate-limit records are
        short-lived.
      </p>

      <h2>Your choices</h2>
      <ul>
        <li>
          A business can disconnect GetShowUps at any time from its Google Account’s third-party access settings, or by
          contacting us.
        </li>
        <li>
          A business can disconnect Google Ads in GetShowUps (Ads → Disconnect). We then delete our stored Google Ads access
          and stop managing and reporting the account; campaigns already in Google Ads stay under the business’s control
          there. We can also do this on request within 3 business days.
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
