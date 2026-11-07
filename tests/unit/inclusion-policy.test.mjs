// docs/show-inclusion-policy.md, asserted against the REAL discovery gate.
//
// tests/fixtures/inclusion-policy/examples.json holds 40 real rows from the
// 2026 data audit's non-theatre accounting (BRO-4204): 20 discovery must admit
// and 20 it must refuse at ingest. Each is fed to isNonTheaterContent() from
// scripts/discover-new-shows.js in the TodayTix shape the pipeline itself
// builds, with the market the row came from — no gate logic is re-implemented
// here (CLAUDE.md §15), so a change to the rule changes this verdict.
//
// Run: node --test tests/unit/inclusion-policy.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { isNonTheaterContent } = require('../../scripts/discover-new-shows.js');
const { NON_THEATRE_VENUE_RE, isNonTheatreVenue } = require('../../scripts/lib/venue-classification.js');

const fixture = JSON.parse(readFileSync(new URL('../fixtures/inclusion-policy/examples.json', import.meta.url), 'utf8'));

// The shape fetchShowsFromTodayTix / fetchShowsFromTodayTixLondon hand to the
// gate: displayName, venue { name }, category { name }, subcategories.
function toCandidate(ex) {
  return {
    displayName: ex.title,
    name: ex.title,
    venue: { name: ex.venue },
    category: ex.todayTixCategory ? { name: ex.todayTixCategory } : null,
    subcategories: ex.market === 'London' ? [{ name: 'Off West End' }] : [{ name: 'Off Broadway' }],
    description: '',
  };
}
const marketOf = (ex) => (ex.market === 'London' ? 'london' : 'nyc');

test('fixture holds 20 keep and 20 reject examples, all with real audit fields', () => {
  assert.equal(fixture.keep.length, 20);
  assert.equal(fixture.reject.length, 20);
  for (const ex of [...fixture.keep, ...fixture.reject]) {
    for (const field of ['id', 'title', 'venue', 'market', 'category', 'decision', 'why']) {
      assert.ok(ex[field], `${ex.title}: missing ${field}`);
    }
    assert.ok(['NYC', 'London'].includes(ex.market), `${ex.title}: market`);
    assert.ok(['broadway', 'off-broadway', 'west-end', 'off-west-end'].includes(ex.category), `${ex.title}: category`);
  }
  const ids = [...fixture.keep, ...fixture.reject].map(ex => ex.id);
  assert.equal(new Set(ids).size, ids.length, 'no example listed twice');
});

for (const ex of fixture.keep) {
  test(`keep: ${ex.title} @ ${ex.venue} [${ex.market}, ${ex.todayTixCategory || 'no TodayTix category'}] — ${ex.why}`, () => {
    assert.equal(isNonTheaterContent(toCandidate(ex), { market: marketOf(ex) }), false);
  });
}

for (const ex of fixture.reject) {
  test(`reject: ${ex.title} @ ${ex.venue} [${ex.market}, ${ex.todayTixCategory || 'no TodayTix category'}] — ${ex.why}`, () => {
    assert.equal(isNonTheaterContent(toCandidate(ex), { market: marketOf(ex) }), true);
  });
}

test('no admitted example sits at a NON_THEATRE_VENUE_RE venue (the Met, Sadler\'s Wells, Park Theatre, Park Avenue Armory are theatres)', () => {
  for (const ex of fixture.keep) {
    assert.equal(NON_THEATRE_VENUE_RE.test(ex.venue), false, `${ex.venue} must not match`);
    assert.equal(isNonTheatreVenue(ex.venue), false);
  }
});

test('every venue-rule rejection is at a venue NON_THEATRE_VENUE_RE matches', () => {
  const venueRule = fixture.reject.filter(ex => ex.rule && ex.rule.startsWith('venue'));
  assert.ok(venueRule.length >= 10, 'fixture covers the venue rule broadly');
  for (const ex of venueRule) {
    assert.equal(NON_THEATRE_VENUE_RE.test(ex.venue), true, `${ex.venue} must match`);
  }
});

test('the reject list exercises every rule class the policy names', () => {
  const rules = new Set(fixture.reject.map(ex => ex.rule));
  for (const rule of ['venue', 'venue+category', 'title', 'receiving-house']) {
    assert.ok(rules.has(rule), `no reject example for rule "${rule}"`);
  }
});

test('the Plays/Musicals override is NYC-only: the same concert-hall row is admitted in NYC and refused in London', () => {
  const row = { displayName: 'Sylvia', name: 'Sylvia', venue: { name: 'Royal Albert Hall' }, category: { name: 'Musicals' }, subcategories: [], description: '' };
  assert.equal(isNonTheaterContent(row, { market: 'london' }), true);
  assert.equal(isNonTheaterContent(row, { market: 'nyc' }), false);
  assert.equal(isNonTheaterContent(row), false, 'default market is nyc');
});
