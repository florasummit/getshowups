// Research programs are DATA, not code: the repository is public, and which questions GetShowUps researches is
// confidential. A program is a research_nodes row of kind 'program' (program id GS-XXX-000, question, what data it
// needs, what keeps it dormant), created in the vault or imported from a local file the founder keeps outside the repo.
// The code only knows the vocabulary of data requirements it can check against the records.
export const NEEDS = {
  spend: 'measured ad spend for a GetShowUps-owned business',
  leads: 'at least 10 leads in a GetShowUps-owned business',
  booked: 'at least 5 bookings in a GetShowUps-owned business',
  outcomes: 'at least 5 recorded visit outcomes',
  paidRevenue: 'recorded payments',
  experiments: 'a completed experiment',
  recommendations: 'recorded recommendations',
  customers: 'paying customers',
  crossAccount: 'a legal basis and customer permission for cross-account research',
  external: 'an authorized outside data source (none connected)',
}
