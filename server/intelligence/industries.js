// What differs between kinds of business, in ONE place: how one is recognised, useful questions, what is usually urgent, and
// the starting rules of a new draft. Defaults only: the owner's published rules and records always win, and a business no
// entry fits uses `general`. No prices, seasons, job values or claims here: those are the owner's to state.
const visit = (...items) => items
const person = [{ when: 'person', action: 'callback' }]
export const INDUSTRIES = {
  // People come to the business. First: "med spa" must never be read as a pool spa.
  appointment: {
    match: /\b(med(ical)?[- ]?spa|day spa|salon|barber|dent(al|ist)|clinic|massage|chiropract\w*|physio\w*|acupunct\w*|veterinar\w*|groom(er|ing)|tutor\w*|fitness|yoga|pilates|nail|lash|brow|aesthetic\w*|optomet\w*|photograph\w*)\b/i,
    atBusiness: true,
    qualify: ['what they would like to come in for', 'whether they have been before', 'what day or time suits them'],
    urgent: [],
    template: { intake: visit(['need', true], ['existing_customer', false], ['preferred_time', false], ['location', true], ['contact', true], ['address', true]), emergency: { triggers: [], action: 'urgent_callback' }, escalation: person },
    needs: /\b(hair ?cut|colou?r|highlights?|facial|massage|manicure|pedicure|check[- ]?up|cleaning|consultation|adjustment|session|lesson|class|fitting|exam|treatment|trim|shave|botox|filler|lashes|brows|whitening|groom(?:ing)?)\b/i,
  },
  pool: {
    match: /pool|spa|hot tub/i,
    qualify: ['pool type and rough size (in-ground or above-ground)', 'what is wrong now (green water, equipment, routine care)', 'one-time visit or recurring service'],
    urgent: ['electrical sparks or burning smell from pool equipment', 'a child or pet in danger', 'major water leak flooding property'],
    template: {
      intake: visit(['need', true], ['location', true], ['preferred_time', false], ['equipment', false], ['urgency', false], ['existing_customer', false], ['contact', true], ['address', true]),
      emergency: { triggers: [], action: 'urgent_callback' },
      escalation: person,
    },
  },
  hvac: {
    match: /hvac|heating|cooling|air condition|furnace|heat pump|a\/c|\bac\b/i,
    qualify: ['heating or cooling problem, or maintenance', 'system type and rough age if known', 'what it is doing (not turning on, blowing warm, noises, leaks)'],
    urgent: ['smell of gas', 'carbon monoxide alarm going off', 'no heat in freezing weather with vulnerable people at home', 'no cooling in extreme heat with vulnerable people at home', 'electrical burning smell'],
    template: {
      intake: visit(['need', true], ['urgency', true, true], ['location', true], ['equipment', false], ['preferred_time', false], ['existing_customer', false], ['contact', true], ['address', true]),
      emergency: { triggers: ['no heat', 'no cooling', 'water leaking'], action: 'callback_and_book' },
      escalation: person,
    },
  },
  electrical: {
    match: /electric/i,
    qualify: ['what is happening (no power, tripping breaker, installation, lights)', 'where in the building', 'whether anything is hot, sparking or smells burnt'],
    urgent: ['sparks or a burning smell', 'a hot outlet or panel', 'water near electricity', 'a downed line'],
    template: {
      intake: visit(['need', true], ['urgency', true, true], ['location', true], ['preferred_time', false], ['existing_customer', false], ['contact', true], ['address', true]),
      emergency: { triggers: ['power out', 'breaker keeps tripping', 'hot outlet'], action: 'urgent_callback' },
      escalation: [...person, { when: 'complex', action: 'callback' }],
    },
  },
  plumbing: {
    match: /plumb|drain|sewer|water heater|pipe/i,
    qualify: ['what is happening (leak, clog, no hot water, installation)', 'where in the home', 'whether water is shut off'],
    urgent: ['burst pipe or active flooding', 'sewage backing up into the home', 'no water at all', 'water heater leaking heavily', 'smell of gas near the water heater'],
    template: {
      intake: visit(['need', true], ['urgency', true, true], ['location', true], ['preferred_time', false], ['existing_customer', false], ['contact', true], ['address', true]),
      emergency: { triggers: ['burst pipe', 'flooding', 'sewage backup', 'no water'], action: 'callback_and_book' },
      escalation: person,
    },
    needs: /\b(leak(?:s|ing|y)?(?: \w+)?|clog(?:ged)?(?: \w+)?|drain(?: \w+)?|toilet(?: \w+)?|water heater(?: \w+)?|no hot water|burst pipe|sewage(?: backup)?|faucet|garbage disposal|sump pump|low (?:water )?pressure|sink|pipe(?:s)?)\b/i,
    equipment: /\b(water heater|tankless|toilet|faucet|sump pump|garbage disposal|boiler|septic)\b/i,
  },
  cleaning: {
    match: /clean|maid|janitor|housekeep/i,
    qualify: ['home size (bedrooms/bathrooms or square feet)', 'one-time, move-in/out, deep clean or recurring', 'pets and any areas to skip or focus on'],
    urgent: [],
    template: { intake: visit(['need', true], ['location', true], ['preferred_time', false], ['existing_customer', false], ['contact', true], ['address', true]), emergency: { triggers: [], action: 'urgent_callback' }, escalation: person },
  },
  general: {
    match: /.*/,
    qualify: ['what they need done', 'where (if the business comes to them)'],
    urgent: ['anything that sounds like immediate danger to people or property'],
    template: { intake: visit(['need', true], ['location', true], ['preferred_time', false], ['contact', true], ['address', true]), emergency: { triggers: [], action: 'urgent_callback' }, escalation: person },
  },
}
// The stated trade is read before the list of services, so one odd service doesn't change the kind of business.
export function industryKey(...texts) {
  for (const t of texts) for (const [k, v] of Object.entries(INDUSTRIES)) if (k !== 'general' && t && v.match.test(String(t))) return k
  return 'general'
}

// Owner-facing words per kind of business (Teach Your AI): the label of the "equipment" question, the example placeholders,
// and plain-words requests the fixed patterns of teach.js understand without a model (a unit test runs every one of them,
// so an example shown to an owner always works when typed). Wording only: nothing here reaches a customer conversation.
export const TRADE_WORDS = {
  appointment: { equipment: 'What it’s for (details)', equipmentAsk: 'Anything we should know before you come in?', excluded: 'Home visits', urgent: 'severe pain', teach: ['We don’t do home visits.', 'Always ask if it is their first visit.', 'If they ask for a person, take a message.'] },
  pool: { equipment: 'Pool type or equipment', equipmentAsk: 'What kind of pool or equipment is it?', excluded: 'Commercial pools', urgent: 'a child or pet in danger', teach: ['We don’t do commercial pools.', 'Remember that a green pool cleanup is usually worth $450.', 'Always ask if there is a dog in the yard.'] },
  hvac: { equipment: 'Equipment or system type', equipmentAsk: 'What kind of equipment or system is it?', excluded: 'New installations', urgent: 'no heat', teach: ['We don’t install equipment, only repair it.', 'Treat a carbon monoxide alarm as an emergency.', 'Remember that a tune-up is usually worth $150.'] },
  electrical: { equipment: 'Equipment involved', equipmentAsk: 'What equipment is involved?', excluded: 'Commercial work', urgent: 'a hot outlet', teach: ['We don’t do commercial work.', 'Treat a burning smell as an emergency.', 'Always ask if the power is out in the whole house.'] },
  plumbing: { equipment: 'Fixture or equipment', equipmentAsk: 'Which fixture or equipment is it?', excluded: 'Septic work', urgent: 'a burst pipe', teach: ['We don’t do septic work.', 'Treat a leaking water heater as an emergency.', 'Always ask if the water is shut off.'] },
  cleaning: { equipment: 'Equipment involved', equipmentAsk: 'Is there any equipment we should know about?', excluded: 'Commercial cleaning', urgent: 'a move-out clean due tomorrow', teach: ['We don’t do commercial cleaning.', 'Always ask if there are pets in the home.', 'Remember that a deep clean is usually worth $300.'] },
  general: { equipment: 'Equipment involved', equipmentAsk: 'What equipment is involved?', excluded: 'Commercial work', urgent: 'something unsafe at the property', teach: ['We don’t do commercial work.', 'Always ask if anyone will be home.', 'If they ask for a person, take a message.'] },
}
export const tradeWords = (key) => TRADE_WORDS[key] || TRADE_WORDS.general
