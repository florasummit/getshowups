// Website chat panel (migration 0043): the owner may show the chat inside a panel on their website instead of the plain
// "Chat or talk with us" link. It is the SAME chat page (/chat/<id>?embed=1, the one receptionist engine) in a frame:
// no second chat, no script on the business site (a <details> element opens it), nothing loads until a visitor opens
// it (loading="lazy" inside a closed <details>). Off by default: without a row the site gets the link, byte for byte.
const missing = (err) => String(err?.message).includes('no such table')

// → { available: the setting can be stored, on }
export async function chatPanelSetting(db, customerId) {
  try {
    const r = await db.prepare('SELECT panel FROM website_chat_settings WHERE customer = ?1').bind(customerId).first()
    return { available: true, on: r?.panel === 1 }
  } catch (err) {
    if (missing(err)) return { available: false, on: false }
    throw err
  }
}

export async function saveChatPanel(db, customerId, on, now = Date.now()) {
  try {
    await db
      .prepare('INSERT INTO website_chat_settings (customer, panel, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(customer) DO UPDATE SET panel = ?2, updated_at = ?3')
      .bind(customerId, on ? 1 : 0, now)
      .run()
    return { ok: true, on: Boolean(on) }
  } catch (err) {
    if (missing(err)) return { ok: false, error: 'not_ready' }
    throw err
  }
}

const attr = (s) => s.replace(/[<>"']/g, '').replace(/&/g, '&amp;')

// The panel: a closed <details> whose summary is the same pill as the link. href = the chat page (with any ad
// parameters); the frame adds embed=1. "Open in a new tab" stays for browsers that block the frame or the microphone.
export function chatPanel(href) {
  const page = attr(href)
  const frame = attr(`${href}${href.includes('?') ? '&' : '?'}embed=1`)
  return `<style>[data-gsu-chat-panel]{position:fixed;right:16px;bottom:16px;z-index:50;font:600 15px/1.2 system-ui,-apple-system,sans-serif}[data-gsu-chat-panel]>summary{list-style:none;display:inline-flex;align-items:center;gap:8px;padding:12px 18px;border-radius:999px;background:#111113;color:#fff;cursor:pointer;box-shadow:0 8px 24px rgb(0 0 0 / .25);float:right}[data-gsu-chat-panel]>summary::-webkit-details-marker{display:none}[data-gsu-chat-panel]>summary:focus-visible{outline:3px solid #2563eb;outline-offset:2px}[data-gsu-chat-panel][open]>summary{padding:8px 14px;font-size:13px;margin-top:8px}[data-gsu-chat-panel] .gsu-chat-box{clear:both;display:flex;flex-direction:column;width:min(380px,calc(100vw - 32px));height:min(600px,calc(100vh - 96px));height:min(600px,calc(100dvh - 96px));background:#fff;border:1px solid #d9dee8;border-radius:14px;overflow:hidden;box-shadow:0 16px 48px rgb(15 23 42 / .22)}[data-gsu-chat-panel] iframe{flex:1;width:100%;border:0}[data-gsu-chat-panel] .gsu-chat-new{padding:8px 12px;font-weight:500;font-size:12px;color:#475569;text-align:right;border-top:1px solid #e6e9f0}[data-gsu-chat-panel] .gsu-chat-new a{color:inherit}[data-gsu-chat-panel] .gsu-chat-c,[data-gsu-chat-panel][open] .gsu-chat-o{display:none}[data-gsu-chat-panel][open] .gsu-chat-c{display:inline}@media (max-width:480px){[data-gsu-chat-panel]{right:8px;left:8px;bottom:8px}[data-gsu-chat-panel] .gsu-chat-box{width:100%}}</style><details data-gsu-chat-panel><summary><span class="gsu-chat-o">Chat or talk with us</span><span class="gsu-chat-c">Close chat</span></summary><div class="gsu-chat-box"><iframe src="${frame}" title="Chat with us" loading="lazy" allow="microphone" referrerpolicy="strict-origin-when-cross-origin"></iframe><p class="gsu-chat-new"><a href="${page}" target="_blank" rel="noopener" data-gsu-chat>Open the chat in a new tab</a></p></div></details>`
}
