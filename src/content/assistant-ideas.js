// The questions the assistant panel suggests on each page (AskAbout.jsx shows them; server/assist-plain.js answers the
// ones that ask for a fact straight from the records, without a model). Change a wording here and nowhere else.
export const IDEAS = {
  overview: ['What should I fix first?', 'What’s coming up?'],
  appointments: ['What’s on this week?', 'Which visits still need an outcome?'],
  followups: ['Who hasn’t been answered?', 'Draft a follow-up for me'],
  receptionist: ['Who asked recently?', 'What should I fix first?'],
  teach: ['What do people ask me for?'],
  website: ['Who asked recently?'],
  ads: ['What did my ads bring in?', 'Compare the last 30 days with the 30 before'],
  settings: ['Who asks from outside my area?', 'What are my hours?'],
}
