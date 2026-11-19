// The one "start" action on the marketing site. Open (or unknown) → Get started (Google sign-in with the founding plan);
// closed → Request early access (the demo/booking section), so nobody signs in only to be told enrollment isn't open.
import { useStartAction } from '../lib/enrollment.js'

export default function GetStarted({ className, onClick, children }) {
  const start = useStartAction()
  return (
    <a href={start.href} className={className} onClick={onClick}>
      {start.label}
      {children}
    </a>
  )
}
