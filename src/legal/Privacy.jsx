// Public privacy policy at /privacy. Required by Google for publishing the OAuth app; it must describe
// exactly what the product does with Google user data. Keep it in sync with server/ behaviour.
import '../app.css'

const UPDATED = 'November 9, 2026'

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
          <strong>People who request an appointment on a booking page:</strong> the name, email address, phone number,
          service request, and ZIP code they enter. These are shared with that business so it can serve them, and are
          included in the appointment added to the business’s Google Calendar, which sends you a calendar invitation.
        </li>
        <li>
          <strong>Product usage and security:</strong> records of actions such as sign-ups and bookings without names or
          contact details, the campaign source of a first visit (for example a utm_source link), one-way hashed IP
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
        GetShowUps’ use and transfer of information received from Google APIs adheres to the{' '}
        <a href="https://developers.google.com/terms/api-services-user-data-policy">Google API Services User Data Policy</a>,
        including the Limited Use requirements.
      </p>

      <h2>Sharing</h2>
      <p>
        Appointment requests are shared with the business the request was made to. We use service providers to run
        GetShowUps: Cloudflare for hosting and storage, and Google for sign-in and calendars. If we turn on account email
        or paid plans, we will also use an email delivery provider to send account emails and Stripe to process
        payments; we never receive or store full card numbers. We do not sell or share personal information for
        advertising. We may disclose information if required by law.
      </p>

      <h2>Storage and security</h2>
      <p>
        Data is stored with Cloudflare. Google calendar access tokens are encrypted, and access to business data is
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
