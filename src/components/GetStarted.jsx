// The one "start" action on the marketing site. Open (or unknown) → Get started (Google sign-in with the founding plan);
// closed → Request early access: GetShowUps' own booking page when it runs (lead captured and attributed in the product,
// with the button's location), otherwise the demo/booking section, so nobody signs in only to be told enrollment isn't open.
import { salesBookingHref, useStartAction } from '../lib/enrollment.js'

export default function GetStarted({ className, onClick, children, location = 'cta' }) {
  const start = useStartAction()
  const href = start.closed && start.salesBooking ? salesBookingHref(location) : start.href
  return (
    <a href={href} className={className} onClick={onClick} data-start-location={location}>
      {start.label}
      {children}
    </a>
  )
}
