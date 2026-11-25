import { test } from 'node:test'
import assert from 'node:assert/strict'
import { whoIsMeant } from '../server/who-is-meant.js'

const t = (words, ...refs) => ({ words, people: refs.map((r) => (Array.isArray(r) ? { ref: r[0], person: r[1] } : { ref: r, person: r })) })
test('“she/he” follows the owner’s own words, never a name; only a sole other person is inferred, as probable', () => {
  for (const [q, turns, want] of [
    ['shes not in here tho', [t('n the other guy from sunday', 'A1'), t('1 what', 'R1')], 'R1?'],
    ['when is she coming', [t('the lady with the dog', 'A1')], 'A1'],
    ['when is she coming', [t('who else', 'A2'), t('the lady with the dog', 'A1')], null], // the newer person could be meant
    ['did she confirm', [t('tell me about the 29401 booking', 'L2'), t('that lady', 'L1')], null],
    ['the second one, did she confirm', [t('the lady', 'L1')], null],
    ['did he pay', [t('who is behind him in the list', 'L2'), t('that guy', 'L1')], null],
    ['did he pay', [t('and what about his brother', 'L2'), t('that guy', 'L1')], null],
    ['did he pay', [t('when is he coming', 'L1'), t('that guy', 'L1')], 'L1'],
    ['mark him done', [t('that guy from sunday', 'A1'), t('she called', 'R1')], 'A1'],
    ['mark him done', [t('all of them', 'A1', 'R1'), t('that guy from sunday', 'A1')], 'A1'], // an earlier clear cue survives a list
    ['is she waiting', [t('next one?', 'A1'), t('who called', 'R1')], null],
    ['is she waiting', [t('that guy', 'A1'), t('next', 'A2'), t('who', 'R1')], null], // two left
    ['did she call', [t('the guy', 'A1', 'R1')], null],
    ['what did i miss today', [t('the lady', 'A1')], null],
    ['man, that is a lot of calls', [t('that guy', 'A1'), t('who', 'R1')], null],
    ['who is the new lady, is she in my area', [t('that guy', 'A1'), t('who', 'R1')], null],
    ['did he pay', [t('and who comes after him', 'L2'), t('the guy on top', 'L1')], null],
    ['did she confirm', [t('has the guy booked', ['A1', 'x']), t('who asked', ['L1', 'x'])], null], // one person, two references
    ['he and she both came?', [t('the guy', 'A1'), t('who', 'R1')], null],
    ['she', [], null],
  ]) {
    const r = whoIsMeant(q, turns)
    assert.equal(r && r.ref + (r.sure ? '' : '?'), want, q)
  }
})
