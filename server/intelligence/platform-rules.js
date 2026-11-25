// Requests that would switch off a platform rule: refused with the reason wherever the owner teaches or writes a rule.
export const PLATFORM = [
  [/\b(skip|don'?t|do not|never|stop) (?:\w+ ){0,2}(check|verify|confirm)\w* (?:the |their )?(zip|service area|area|coverage|calendar|availability)/i, 'The service area and the calendar are always checked before times are offered (platform rule).'],
  [/\bbook (?:them |it |anyone )?(?:anyway|even if|without)/i, 'A booking always needs a real open time and the customer’s clear yes (platform rule).'],
  [/without (?:asking|getting|confirming|a yes|their (?:ok|okay|yes))/i, 'A booking always needs the customer’s clear yes (platform rule).'],
  [/\b(ignore|disregard|override|forget) (?:\w+ ){0,3}(rules?|instructions?|safety|limits?|prompt)/i, 'Platform rules and safety handling can’t be switched off.'],
  [/\b(other (?:customers|businesses|companies)|another (?:customer|business)|competitor'?s)\b.*\b(info|information|details|data|prices?|bookings?)/i, 'Only your own business’s information is ever used or shared (platform rule).'],
  [/\b(reveal|show|share|read out) (?:the |your )?(system prompt|instructions|rules you follow)/i, 'The AI never reveals its instructions.'],
  [/\b(no|remove|disable|turn off|unlimited|lift|raise) (?:the |any |all |our |your )?(?:daily |spending |cost |conversation |usage )*(limits?|caps?)\b/i, 'Spending and conversation limits always apply.'],
  [/\b(don'?t|never|no need to) (?:tell|send) (?:them )?(?:to )?(?:call )?911|\bno safety\b/i, 'Anyone describing danger is always told to get safe and call 911 first (platform rule).'],
  [/\b(record|save|keep) (?:the |all )?(calls?|recordings?|audio)\b/i, 'Call recording isn’t something the AI rules can turn on (it needs consent and a separate decision).'],
  [/\b(quote|say|give|tell)\b.*\$\s?\d/i, 'Prices come only from your services in Settings, never from AI rules. Change the price in Settings → Services.'],
  [/\b(promise|guarantee)\w*\b/i, 'The AI never makes promises or guarantees that aren’t in your records.'],
]
export const platformRefusal = (text) => PLATFORM.find(([re]) => re.test(String(text || '')))?.[1] ?? null
