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

// "Help" in the page header: the list of help topics and how to reach a person (Help.jsx HelpIndex). No request is made.
export const openHelp = () => set({ key: 'help', from: document.activeElement })
// Whether a panel is on the page to show it (not on the few sign-in problem screens): Help.jsx sets it.
let panel = false
export const setPanelReady = (on) => {
  panel = on
}
export const panelReady = () => panel

// Where the owner is (Home sets it), so questions carry the page without saying it.
let view = 'overview'
export const setAssistantView = (v) => {
  view = v
  subs.forEach((f) => f())
}
export const useView = () => useSyncExternalStore((f) => (subs.add(f), () => subs.delete(f)), () => view)

// A follow-up the owner opened from the assistant: FollowUps.jsx puts it in that person's reply box. Nothing is sent.
let draft = null
export const setDraft = (d) => {
  draft = d
  window.dispatchEvent(new CustomEvent('gsu:draft'))
}
export const takeDraft = (leadId) => {
  if (!draft || (leadId && draft.leadId !== leadId)) return null
  const d = draft
  if (leadId) draft = null
  return d
}

// The conversation open on Follow-ups, so "this one" means it.
let selected = null
export const setSelected = (leadId) => {
  selected = leadId || null
}
export const getSelected = () => selected
