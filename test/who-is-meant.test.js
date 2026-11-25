import { test } from 'node:test'
import assert from 'node:assert/strict'
import { whoIsMeant } from '../server/who-is-meant.js'

const d = (ref, words, alone = true) => ({ ref, words, alone })
test('“she/he” follows the owner’s own words for people, by elimination; never a name; null when it can’t be told', () => {
  for (const [q, people, want] of [
    ['shes not in here tho', [d('A1', 'n the other guy from sunday'), d('R1', '1 what')], 'R1'],
    ['did he pay', [d('R1', 'call her first?'), d('A1', 'and tuesday')], 'A1'],
    ['when is she coming', [d('A2', 'who else'), d('A1', 'the lady with the dog')], 'A1'],
    ['mark him done', [d('A1', 'that guy from sunday'), d('R1', 'she called')], 'A1'],
    ['is she waiting', [d('A1', 'next one?'), d('R1', 'who called')], null], // nothing said about either
    ['is she waiting', [d('A1', 'the guy'), d('A2', 'next'), d('R1', 'who')], null], // two left
    ['he and she both came?', [d('A1', 'the guy'), d('R1', 'who')], null],
    ['did she call', [d('A1', 'the guy', false), d('R1', 'the guy', false)], null], // words about two people settle nothing
    ['what is on the schedule', [d('A1', 'the guy')], null], // "the", "this", "here" are no cue
    ['she', [], null],
  ])
    assert.equal(whoIsMeant(q, people), want, q)
})
