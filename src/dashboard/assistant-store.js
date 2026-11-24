// State of the one help/assistant panel (Help.jsx): what is selected, and which page the owner is on.
import { useSyncExternalStore } from 'react'

// What is open: { key, topic, from, label?, value?, sub?, kind?, missing?, note?, days?, loading? }. Only one thing at a time.
let open = null
export const getOpen = () => open
const subs = new Set()
export const set = (next) => {
  open = next
  subs.forEach((f) => f())
}
export const useOpen = () => useSyncExternalStore((f) => (subs.add(f), () => subs.delete(f)), () => open)
export const close = () => {
  const from = open?.from?.isConnected ? open.from : document.querySelector('[data-assistant]')
  set(null)
  from?.focus({ preventScroll: true })
}

// Whether the owner is in a conversation (AskAbout.jsx marks the panel).
export const talking = () => !!document.querySelector('[data-ask-talking]')

export function openAssistant(extra = {}) {
  set({ key: 'global', from: document.activeElement, ...extra })
}

// Where the owner is (Home sets it), so questions carry the page without saying it.
let view = 'overview'
export const setAssistantView = (v) => {
  view = v
  subs.forEach((f) => f())
}
export const useView = () => useSyncExternalStore((f) => (subs.add(f), () => subs.delete(f)), () => view)
