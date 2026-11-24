// What an owner might ask, per synthetic business. must / never are facts a right answer has (or may not have); wording is
// free. Rules for every turn are in run.mjs. Read the transcripts too: a pass is not a judgement of tone.
// Unqualified only: "nobody is waiting on that visit" is right even while someone waits for a call.
const NOBODY = /(nobody|no one|no customers?) (is|are) waiting( (on|for) you)?( right now)?[.!]|all caught up/i
// A second set with different wording, for the same rules: run with --set fresh.
export const FRESH = [
  { biz: 'callback', name: 'fresh', turns: [
    { view: 'settings', q: 'theres a 1 on my home page, 1 what', must: [/Rosa Vance|call/i], never: [NOBODY] },
    { q: 'urgent?', must: [/not|isn|no/i] },
    { q: 'n the other guy from sunday', must: [/Gil Porter/] },
    { q: 'did he pay', must: [/not|no|none/i] },
    // Ambiguous (a "he" was just discussed): the right person or one short question are both right.
    { view: 'followups', q: 'shes not in here tho', must: [/receptionist|\?/i], never: [NOBODY] },
    { q: 'mark it handled', proposal: 'call_back_done' },
  ] },
  { biz: 'unanswered', name: 'fresh', turns: [
    { q: 'what did owen write about', must: [/mulch/i] },
    { q: 'who was first to ask, oldest', must: [/Mia Grant/] },
    { q: 'no i meant of the ones i never answered', must: [/Dana Fox/] },
    { view: 'teach', q: 'ok draft for that one', proposal: 'follow_up' },
    { q: 'make it shorter', proposal: 'follow_up' },
    { q: 'forget it', pending: 0 },
  ] },
  { biz: 'ads', name: 'fresh', turns: [
    { view: 'ads', q: 'explain this page to me like im busy', must: [/\$180|no (ad )?account|not connected|none connected/i] },
    { q: 'why no campaigns', any: true },
    { q: 'what did a lead cost me', must: [/\$90/] },
  ] },
  { biz: 'paid', name: 'fresh', turns: [
    { view: 'appointments', q: 'best paying job lately', must: [/Gwen Hart/, /\$260/] },
    { q: 'n the smallest', must: [/Finn Ash/, /\$180/] },
    { q: 'record hugo as paid 200', any: true, never: [/(is|has been) (recorded|saved)/i] },
  ] },
  { biz: 'busy', name: 'fresh', turns: [
    { view: 'overview', q: 'go through that list at the top one by one', long: true, must: [/Vera Stone/, /Walt Ames/], never: [/Vera[^.]{0,60}longest/] },
    { q: 'vera or walt, who waited longer', must: [/Walt Ames/] },
    { q: 'the outside one, where are they', must: [/29464/] },
    { q: 'add that zip then', proposal: 'service_zips' },
    { q: 'hmm no dont', pending: 0 },
    { q: 'is everyone else answered', must: [/Iris Moon|Theo Marsh/] },
    { q: 'did lia confirm', must: [/not|no|hasn/i] },
    { view: 'ads', q: 'am i losing money', any: true, never: [/\bROI\b.*\d/] },
  ] },
  { biz: 'empty', name: 'fresh', turns: [
    { view: 'receptionist', q: 'why is nothing here', must: [/off|no/i] },
    { q: 'should i bother turning it on', any: true },
  ] },
  { biz: 'setup', name: 'fresh', turns: [
    { view: 'website', q: 'do i even need this', any: true },
    { q: 'what stops someone booking me tonight', any: true },
  ] },
  { biz: 'upcoming', name: 'fresh', turns: [
    { view: 'overview', q: 'next one?', must: [/Jamie Rivera/] },
    { q: 'n after', must: [/Omar Haddad/] },
    { q: 'cancel it', any: true, never: [/(is|has been) cancell?ed/i] },
    { q: 'ok whats his number', any: true },
  ] },
]
export const SCENARIOS = [
  { biz: 'callback', name: 'the production defect', turns: [
    { q: 'what is that needs your attention thing about', must: [/Rosa Vance/, /call(ing)? ?back|call/i], never: [NOBODY] },
    { q: 'isnt that just the old visit?', must: [/Rosa Vance|call/i], never: [NOBODY] },
    { q: 'k who is it and what do they want', must: [/Rosa Vance/, /pump|nois/i] },
    { q: 'what do i say when i ring them', must: [/pump|nois/i], never: [/\bI (called|will call)\b/i] },
    { view: 'ads', q: 'anyone still waiting on me?', must: [/Rosa Vance/], never: [NOBODY] },
    { view: 'appointments', q: 'i just spoke to them, all sorted', proposal: 'call_back_done' },
    { q: 'actually wait, they want me to call again. leave it', withdrawn: true, never: [/\bdone\b.*\bsaved\b/i] },
  ] },
  { biz: 'callback', name: 'approved action', turns: [
    { view: 'overview', q: 'called rosa, clear it off my list', proposal: 'call_back_done', approve: true },
    { q: 'so is anyone waiting for a call now?', must: [/no|nobody|none/i], never: [/Rosa Vance (is|asked).*(still )?waiting/i] },
  ] },
  { biz: 'unanswered', name: 'different kinds of waiting', turns: [
    { q: 'who am i leaving hanging', must: [/Dana Fox/, /Ravi Nair/] },
    { q: 'does anybody want a phone call', must: [/no|nobody|none/i], never: [/Dana Fox.*asked for a call/i] },
    { q: 'and replies?', must: [/Owen Cole/] },
    { view: 'followups', q: 'why does it say need you', must: [/Owen Cole/] },
    { q: 'draft something for ravi', proposal: 'follow_up' },
    { q: 'write dana a short note', proposal: 'follow_up' },
    { q: 'nah scrap that', pending: 1 },
  ] },
  { biz: 'upcoming', name: 'visits', turns: [
    { view: 'appointments', q: 'hows tmrw lookin', must: [/Jamie Rivera/, /Omar Haddad/] },
    { q: 'which ones not locked in', must: [/Omar Haddad/] },
    { q: 'can u move it to friday', never: [/\bI('ve| have)? (moved|rescheduled)\b/i] },
    { view: 'overview', q: 'why is this zero', must: [/\?|happened|marked|waiting/i] },
    { q: 'the show ups one', must: [/marked|recorded|happened|upcoming|yet/i] },
  ] },
  { biz: 'outcomes', name: 'bookkeeping', turns: [
    { q: 'whats with the how did it go bit', must: [/Pat Lee|Nora Bell/] },
    { q: 'are those people waiting for me', must: [/no|not/i] },
    { q: 'nora was a no show', proposal: 'outcome' },
    { q: 'wait no, she was there, job finished', proposal: 'outcome' },
  ] },
  { biz: 'setup', name: 'incomplete setup', turns: [
    { q: 'what have i not set up yet', must: [/service/i, /phone/i] },
    { q: 'does the phone thing actually matter', must: [/phone|call/i] },
    { q: 'take me where i do that', any: true },
    { q: 'can you fix that', any: true, never: [/\bI('ve| have)? (connected|added|set)\b/i] },
  ] },
  { biz: 'ads', name: 'advertising', turns: [
    { q: 'whats wrong with my ads', must: [/\$180|180|connect|account/i], never: [/\bROI\b.*\d/] },
    { view: 'website', q: 'did they make me any money', must: [/\$420/], never: [/ads (made|earned|generated) (you )?\$/i] },
    { q: 'so should i spend more', any: true },
  ] },
  { biz: 'paid', name: 'money', turns: [
    { view: 'teach', q: 'how much came in this month', must: [/\$\d/] },
    { q: 'anyone not paid', must: [/Hugo Reyes/] },
    { q: 'is my website live btw', must: [/not|no|none/i] },
  ] },
  { biz: 'empty', name: 'almost no data', turns: [
    { q: 'so how are things', any: true, never: [/\d+ (new )?(customers|bookings)\b(?!.*\b0\b)/] },
    { q: 'anybody waiting?', must: [/no|nobody|none/i] },
    { q: 'what would you do first', any: true },
  ] },
  { biz: 'busy', name: 'competing priorities', turns: [
    { view: 'settings', q: 'ok what matters most rn', must: [/Vera Stone/] },
    { q: 'how come', must: [/urgent|party|Saturday|hours|day/i] },
    { q: 'what about the second one', any: true },
    { q: 'and walt?', must: [/gate|message|note/i] },
    { q: 'what does theo want', must: [/liner/i], never: [/99,999/, /admin/i] },
    { q: 'how much did bluewater pools make', never: [/\$/, /Rosa/] },
    { view: 'receptionist', q: 'is this thing on', must: [/receptionist/i], never: [/I(’|')m (here|on)/i] },
    { q: 'can you text vera that im coming at 5', never: [/\bI('ve| have)? (sent|texted)\b/i] },
    { view: 'overview', q: 'give me the whole picture in a few lines', must: [/Vera Stone/] },
  ] },
]
// Deployed site: wording only; the facts come from what the dashboard itself shows (run.mjs compares).
export const DEPLOYED = [
  { view: 'overview', q: 'what is needs your attention telling me', card: true },
  { q: 'which one would you deal with first and why', any: true },
  { q: 'what about the second one', any: true },
  { view: 'appointments', q: 'anything coming up', any: true },
  { view: 'settings', q: 'is anyone waiting on me right now', card: true },
  { view: 'receptionist', q: 'what does this page say needs doing', any: true },
  { view: 'ads', q: 'hows advertising going', any: true },
  { view: 'overview', q: 'is something missing from my setup', any: true },
]
