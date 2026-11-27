// The homepage is the GetShowUps business's website: when that business turns on the chat panel (Receptionist page →
// "chat panel on your website"), the homepage shows the SAME panel a customer's site gets (server/chat-panel.js: a closed
// <details> with the chat page /chat/getshowups?embed=1 in a lazy frame; one receptionist engine, nothing loads until opened).
import { chatPanel } from '../../server/chat-panel.js'
import { salesChatHref, useSalesPanel } from '../lib/enrollment.js'

export default function SalesChatPanel() {
  const on = useSalesPanel()
  if (!on) return null
  // chatPanel() builds fixed markup and escapes the link it is given (only our path + checked campaign codes).
  return <div data-sales-panel dangerouslySetInnerHTML={{ __html: chatPanel(salesChatHref()) }} />
}
