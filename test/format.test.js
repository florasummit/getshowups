// Text helpers every screen uses for counts, dates and money (src/lib/format.js, docs/DESIGN_SYSTEM.md "Copy").
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { humanDate, humanDateTime, money, plural, pluralWord } from '../src/lib/format.js'
import { savedHoldMs } from '../src/dashboard/ui-hooks.js'

const NOW = Date.UTC(2026, 10, 26, 15, 0) // Thu, Nov 26, 2026

test('plural: the noun agrees with the count (never "1 visits", never "(s)")', () => {
  assert.equal(plural(1, 'visit'), '1 visit')
  assert.equal(plural(2, 'visit'), '2 visits')
  assert.equal(plural(0, 'visit'), '0 visits')
  assert.equal(plural(1, 'photo'), '1 photo')
  assert.equal(plural(1, 'business'), '1 business')
  assert.equal(plural(3, 'business'), '3 businesses')
  assert.equal(plural(1, 'person'), '1 person')
  assert.equal(plural(4, 'person'), '4 people')
  assert.equal(plural(2, 'Person'), '2 People')
  assert.equal(plural(2, 'company'), '2 companies')
  assert.equal(plural(2, 'day'), '2 days')
  assert.equal(plural(2, 'match'), '2 matches')
  assert.equal(plural(2, 'box'), '2 boxes')
  assert.equal(plural(2, 'reply', 'replies'), '2 replies')
  assert.equal(plural(1200, 'visit'), '1,200 visits')
  for (const n of [0, 1, 2, 11]) assert.doesNotMatch(plural(n, 'visit'), /\(s\)/)
})

test('plural: a missing count reads as 0; pluralWord gives the noun alone', () => {
  assert.equal(plural(null, 'lead'), '0 leads')
  assert.equal(plural(undefined, 'lead'), '0 leads')
  assert.equal(plural('1', 'lead'), '1 lead')
  assert.equal(pluralWord(1, 'business'), 'business')
  assert.equal(pluralWord(2, 'business'), 'businesses')
  assert.equal(pluralWord(2, 'person lose', 'people lose'), 'people lose')
})

test('humanDate: an ISO date is never shown as typed', () => {
  assert.equal(humanDate('2026-11-26', { now: NOW }), 'Thu, Nov 26')
  assert.equal(humanDate('2026-11-26', { now: NOW, weekday: false }), 'Nov 26')
  assert.equal(humanDate('2026-11-26', { now: NOW, year: true }), 'Nov 26, 2026')
  assert.equal(humanDate('2026-11-26', { now: NOW, long: true }), 'Thursday, November 26')
  assert.equal(humanDate('2025-01-05', { now: NOW }), 'Jan 5, 2025') // another year: the year is shown
  for (const v of ['2026-11-26', '2026-01-01', '2025-12-31']) assert.doesNotMatch(humanDate(v, { now: NOW }), /\d{4}-\d{2}-\d{2}/)
})

test('humanDate: a calendar date names the same day in every time zone; an instant follows the zone asked for', () => {
  // Date-only: the time zone option never moves it to the day before.
  assert.equal(humanDate('2026-11-26', { now: NOW, timeZone: 'America/Los_Angeles' }), 'Thu, Nov 26')
  assert.equal(humanDate('2026-11-26', { now: NOW, timeZone: 'Pacific/Auckland' }), 'Thu, Nov 26')
  // An instant: 02:30 UTC on the 27th is still the 26th in New York.
  const instant = '2026-11-27T02:30:00Z'
  assert.equal(humanDate(instant, { now: NOW, timeZone: 'America/New_York' }), 'Thu, Nov 26')
  assert.equal(humanDate(instant, { now: NOW, timeZone: 'UTC' }), 'Fri, Nov 27')
  assert.equal(humanDate(Date.parse(instant), { now: NOW, timeZone: 'UTC' }), 'Fri, Nov 27')
  assert.equal(humanDate(new Date(instant), { now: NOW, timeZone: 'UTC' }), 'Fri, Nov 27')
})

test('humanDate / humanDateTime: unreadable input gives an empty string, never "Invalid Date"', () => {
  for (const v of [null, undefined, '', 'soon', '2026-13-45', Number.NaN]) {
    assert.equal(humanDate(v), '')
    assert.equal(humanDateTime(v), '')
  }
})

test('humanDateTime: day and time in the zone asked for; the year only when it is not this year', () => {
  assert.match(humanDateTime('2026-11-26T20:00:00Z', { now: NOW, timeZone: 'America/New_York' }), /^Thu, Nov 26, 3:00\sPM$/)
  assert.match(humanDateTime('2025-03-02T17:30:00Z', { now: NOW, timeZone: 'UTC' }), /^Sun, Mar 2, 2025, 5:30\sPM$/)
  assert.equal(humanDateTime('2026-11-26', { now: NOW }), 'Thu, Nov 26') // a date has no time
})

test('money: cents in, grouped dollars out, a real minus sign before the dollar sign', () => {
  assert.equal(money(123400), '$1,234')
  assert.equal(money(1250), '$12.50')
  assert.equal(money(0), '$0')
  assert.equal(money(49900, { cents: true }), '$499.00')
  assert.equal(money(1250, { cents: false }), '$13')
  assert.equal(money(-1026600), '−$10,266')
  assert.equal(money(-1250), '−$12.50')
  assert.doesNotMatch(money(-1026600), /\$-/)
  assert.equal(money(-0.2), '$0') // rounds to zero: no "−$0"
})

test('money: a missing amount is a dash (or the text asked for), never $NaN', () => {
  assert.equal(money(null), '—')
  assert.equal(money(undefined), '—')
  assert.equal(money(Number.NaN), '—')
  assert.equal(money('abc'), '—')
  assert.equal(money(null, { empty: 'none recorded' }), 'none recorded')
  assert.equal(money('1500'), '$15')
})

test('saved confirmation: about 2.5 s for the word, longer for a sentence, never over 8 s', () => {
  assert.equal(savedHoldMs('Saved.'), 2500)
  assert.equal(savedHoldMs(''), 2500)
  assert.equal(savedHoldMs('Saved. Customers see it now.'), 2500)
  assert.equal(savedHoldMs('x'.repeat(100)), 6000)
  assert.equal(savedHoldMs('x'.repeat(500)), 8000)
})
