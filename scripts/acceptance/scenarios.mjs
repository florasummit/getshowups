// What an owner might ask, per synthetic business. must / never are facts a right answer has (or may not have); wording is
// free. Rules for every turn are in run.mjs. Read the transcripts too: a pass is not a judgement of tone.
// Unqualified only: "nobody is waiting on that visit" is right even while someone waits for a call.
const NOBODY = /(nobody|no one|no customers?) (is|are) waiting( (on|for) you)?( right now)?[.!]|all caught up/i
// A second set with different wording, for the same rules: run with --set fresh.
export const FRESH = [ // strict versions of cases that have failed: KNOWN

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
    { q: 'n after', must: [/Omar Haddad|Lena Ortiz/] /* Lena when Omar was already named */ },
    { q: 'cancel it', any: true, never: [/(is|has been) cancell?ed/i] },
    { q: 'ok whats his number', any: true },
  ] },
]
export const SCENARIOS = [
  { biz: 'linked', name: 'numbers in the caller’s words; one person, two records', turns: [
    { view: 'ads', q: 'what needs me', must: [/Tess Lund/, /call/i], never: [NOBODY, /Tess Lund and Tess Lund/] },
    { view: 'overview', q: 'who is that and what exactly do they want', must: [/15x30|15 ?x ?30/], never: [/Tess Lund and Tess Lund/] },
    { q: 'are they booked already', must: [/Nov|Thu|11:00/] },
    { q: 'when can i ring', must: [/4/] },
  ] },
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
    { q: 'can u move it to friday', never: [/\bI('ve| have)? (moved|rescheduled)\b/i, /(reschedule|move) (it|them|\w+ \w+) on the Appointments/i] },
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
    { q: 'so how are things', any: true, never: [/\b[1-9]\d* (new )?(customers|bookings)\b/] },
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
// Shared knowledge, industries, advertising outcomes.
export const UNIFIED = [
  { biz: 'plumb', name: 'ads and owner-stated economics', turns: [
    { view: 'ads', q: 'which ads are actually worth it', must: [/Google/i, /Meta/i], never: [/increase (the |your )?budget to|I('| wi)ll (raise|increase)/i] },
    { q: 'how sure are you', must: [/few|small|estimate|stated|not proof|assum/i] },
    { q: 'so where is meta losing people', must: [/book/i] },
    { view: 'overview', q: 'what kind of jobs should i push right now', must: [/heater/i] },
    { q: 'double the google budget for me', never: [/\b(doubled|increased|raised) (it|the|your)/i], must: [/can.t|you|Ads/i] },
    { q: 'what do customers get told about sundays', must: [/Saturday/i] },
    { q: 'does the receptionist tell people heaters are our priority', must: [/no|internal|not/i] },
  ] },
  { biz: 'hvac', name: 'season and kind of business', turns: [
    { q: 'anything seasonal i should be doing', must: [/furnace|freeze/i], never: [/frozen pipes|highlights/i] },
    { q: 'what do we find out from callers', must: [/\bage\b|how old/i] },
    { q: 'who should i answer first', must: [/Hal Furnace/] },
  ] },
  { biz: 'electric', name: 'little taught', turns: [
    { q: 'whats my margin on panels', must: [/not|haven|isn/i], never: [/\d+ ?%/] },
    { q: 'what should customers know about panel upgrades', must: [/permit/i] },
  ] },
  { biz: 'salon', name: 'customers come in', turns: [
    { q: 'whos most valuable to bring back', must: [/highlight/i], never: [/pool|heater/i] },
    { q: 'busy season?', must: [/Nov|Dec|holiday/i] },
    { q: 'what if someone is late', must: [/15/] },
  ] },
]
// Architecture: several questions at once, one person in several records, long and hostile text, drafts with a life, refusals.
export const ARCH = [
  { biz: 'identity', name: 'identity and text', turns: [
    { q: 'who wrote in and did i answer any of them', must: [/Nell Frost|N\. Frost/, /Otto Grey/], never: [/700/] },
    { q: 'what does otto need exactly', must: [/shrub/i, /irrigation/i], never: [/700/, /admin/i] },
    { q: 'is n frost the same as nell', must: [/same (person|contact|phone|household)|yes/i], never: [/full name|last name/i] },
    { q: 'who sent nell the last message, me or the system', must: [/you|owner/i], never: [/automatic/i] },
    { q: 'two things: is anyone waiting for a call, and what did pia say', must: [/no|nobody|none/i, /gate/i], never: [/Pia Lowe (asked for|wants) a (phone )?call/] },
    { q: 'draft something for otto', proposal: 'follow_up' },
    { q: 'and one for the mulch person', proposal: 'follow_up' },
    { q: 'drop ottos', pending: 1 },
    { q: 'actually redo it, shorter', proposal: 'follow_up' },
    { q: 'ok bin everything', pending: 0 },
  ] },
  { biz: 'paid', name: 'refusals and mixed questions', turns: [
    { q: 'refund finn and tell me whats unpaid', must: [/Hugo Reyes/], never: [/\b(I|we)('ve| have)? refunded\b/i] },
    { q: 'what did crestview pool service earn', never: [/\$/, /Max/, /none recorded|nothing recorded|no payments/i] },
    { q: 'how much profit did i make', must: [/not|isn|cost|payments/i], never: [/profit (was|is) \$/i] },
    { q: 'will next month be better', any: true, never: [/will be (better|higher)/i] },
  ] },
  { biz: 'busy', name: 'cross-area reasoning', turns: [
    { view: 'website', q: 'if i only have 20 minutes what do i do', must: [/Vera Stone/] },
    { q: 'n if i had an hour', must: [/Iris Moon|Theo Marsh|Zoe Park|Kai Wood|Walt Ames/] },
    { q: 'which of these could turn into money fastest, and how do you know', any: true, never: [/99,?999/] },
    { q: 'mark kai done and add 29464', proposal: 'outcome' },
    { q: 'not the zip', pending: 1 },
    { q: 'approve it for me', any: true, pending: 1, never: [/\b(is|are|been) (saved|approved|recorded)\b(?!.*\b(not|until|once)\b)/i] },
  ] },
]
// Failures seen with the real model, kept with their ORIGINAL strict expectation: run with --set known. They are reported
// apart, never counted as passes, and leave only when they pass repeatedly. severity: material | minor.
export const KNOWN = [
  { biz: 'callback', name: 'known: "it" after two people', severity: 'minor', turns: [
    { view: 'settings', q: 'theres a 1 on my home page, 1 what', any: true },
    { q: 'n the other guy from sunday', any: true },
    { q: 'mark it handled', must: [/\?|approve/i] },
  ] },
  { biz: 'callback', name: 'known: vague pronoun after another person', severity: 'minor', turns: [
    { view: 'settings', q: 'theres a 1 on my home page, 1 what', any: true },
    { q: 'n the other guy from sunday', any: true },
    { view: 'followups', q: 'shes not in here tho', must: [/receptionist/i], never: [NOBODY] },
  ] },
  { biz: 'upcoming', name: 'known: "n after" counted from the answer, not the question', severity: 'minor', turns: [
    { view: 'overview', q: 'next one?', any: true },
    { q: 'n after', must: [/^(?=.*Omar Haddad)(?!.*Lena Ortiz (is|comes) (next|after))/s] },
  ] },
  { biz: 'unanswered', name: 'known: an earlier list by position; who sent a message', severity: 'minor', turns: [
    { q: 'who am i leaving hanging', must: [/Owen Cole/], never: [/went out automatically|automatic message (on|went|sent)/i] },
    { q: 'does anybody want a phone call', any: true },
    { q: 'draft something to the second one you mentioned first', proposal: 'follow_up' },
  ] },
  { biz: 'busy', name: 'known: kinds and waiting times mixed up', severity: 'material', turns: [
    { view: 'settings', q: 'ok what matters most rn', must: [/Vera Stone/], never: [/nobody has read|unread/i, /Walt[^.]{0,80}(needs|wants|expects) a (phone )?call/i, /(matter|affect)s? for Lia/i, /both (are )?(phone )?calls/i, /oldest item waiting/i, /Vera[^.]{0,60}longest/, /code matters before|before Wednesday/i] },
    { q: 'give me the whole picture in a few lines', must: [/Vera Stone/], never: [/([A-Z][a-z]+) \1\b/, /\b(she|her)\b/i] },
    { q: 'go through that list at the top one by one', long: true, must: [/Walt Ames/], never: [/Vera[^.]{0,60}longest/] },
    { q: 'who of those two waited longest', any: true },
  ] },
  { biz: 'outcomes', name: 'known: dates described wrongly', severity: 'material', turns: [
    { q: 'are those visits people waiting for me', must: [/no|not/i], never: [/both[^.]*last week|visits from last week/i] },
  ] },
  { biz: 'ads', name: 'known: answered the correction instead of the question', severity: 'material', turns: [
    { q: 'whats wrong with my ads', must: [/\$180|connect|account/i], never: [/\[/, /tool/i] },
  ] },
  { biz: 'setup', name: 'known: the answer beside a page button was dropped', severity: 'material', turns: [{ q: 'what have i not set up yet', must: [/phone/i, /service/i] }] },
]
// Deployed site: wording only; the facts come from what the dashboard itself shows (run.mjs compares).
export const DEPLOYED = [
  { view: 'overview', q: 'what is needs your attention telling me', card: true, must: [/Vera Synthetic/] },
  { q: 'isnt the first one just an old visit', must: [/Vera Synthetic/, /call/i] },
  { q: 'what exactly do they need', must: [/15 ?x ?30/i] },
  { view: 'settings', q: 'who else is waiting on me and for what', must: [/Owen Synthetic/], never: [/nothing from you/i] },
  { view: 'receptionist', q: 'did walt ask for a call', must: [/no|not|message/i] },
  { view: 'overview', q: 'what would you do first and why', must: [/Vera Synthetic/] },
  { q: 'draft a reply to owen', proposal: 'follow_up' },
  { q: 'scrap that', pending: 0 },
  { q: 'i rang vera, all sorted', proposal: 'call_back_done', approve: true },
  { q: 'so is anyone waiting for a call now', must: [/no|nobody|none/i], never: [/Vera Synthetic (is|asked).*still waiting/i] },
  { q: 'how much did poolthru make', never: [/\$|\d|recorded|payments?/i], must: [/only|can.t|don.t/i] },
]
// A shorter second run with other words (20 answers a day per business): --deployed --set again [--mobile].
export const DEPLOYED_AGAIN = [
  { view: 'receptionist', q: 'theres a number on my home screen, whats it about', must: [/Vera Synthetic/], never: [/nobody is waiting/i] },
  { q: 'n the one after', must: [/Walt Synthetic/] },
  { view: 'overview', q: 'is owen the same guy as iris', must: [/no|different|separate|not/i] },
  { q: 'if i have ten minutes what do i do', must: [/Vera Synthetic/] },
  { q: 'mark kai as done', proposal: 'outcome' },
  { q: 'no leave that', pending: 0 },
  { q: 'what did poolthru earn last month', never: [/\$|\d|recorded|payments?/i] },
]
