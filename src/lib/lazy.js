// Lazy app chunks that survive a deploy. Chunk file names change with every release and the previous release's files
// are gone, so a page opened before a deploy can't load a part it hasn't loaded yet (the server answers with the HTML
// page instead of the script). Then the page reloads ONCE to pick up the new release, instead of going blank. Work in
// progress is already safe: drafts are saved on the server and the website editor keeps unsaved edits in this browser.
import { lazy } from 'react'

const KEY = 'gsu_chunk_reload'
const WINDOW_MS = 30_000

export function shouldReload(now = Date.now(), storage = globalThis.sessionStorage) {
  try {
    const last = Number(storage.getItem(KEY)) || 0
    if (now - last < WINDOW_MS) return false // reloaded just now and still failing: a real error, don't loop
    storage.setItem(KEY, String(now))
    return true
  } catch {
    return false // no storage: can't guard against a loop, so show the error instead
  }
}

export const lazyPage = (load) =>
  lazy(() =>
    load().catch((err) => {
      if (typeof window !== 'undefined' && shouldReload()) {
        window.location.reload()
        return new Promise(() => {}) // the page is reloading
      }
      throw err
    }),
  )
