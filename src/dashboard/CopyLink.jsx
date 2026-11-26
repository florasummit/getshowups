// A copy control that says which link it copies ("Copy booking link"), confirms with "Copied", and, when the browser
// refuses the clipboard, shows the address selected in the page to copy by hand (never a browser prompt).
import { useState } from 'react'

export default function CopyLink({ url, label, className = 'btn btn-quiet' }) {
  const [state, setState] = useState('')
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url)
      setState('copied')
      setTimeout(() => setState((s) => (s === 'copied' ? '' : s)), 1800)
    } catch {
      setState('manual')
    }
  }
  return (
    <>
      <button type="button" className={className} onClick={copy} data-copy>
        {state === 'copied' ? 'Copied' : label}
      </button>
      {state === 'manual' && <input className="copy-manual" readOnly value={url} aria-label={`${label}: select and copy`} autoFocus onFocus={(e) => e.target.select()} />}
    </>
  )
}
