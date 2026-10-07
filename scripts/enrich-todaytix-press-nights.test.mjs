// Tests for BRO-626 todaytix press-night enrichment. Runs under plain
// `node --test` (see package.json test script / test.yml wiring).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  findTodaytixCollapsedShows,
  computeTodaytixPressNightChanges,
} = require('./lib/enrich-todaytix-press-nights.js');

function weShow(overrides) {
  return {
    id: 'fixture-we-2026',
    title: 'Fixture Show',
    slug: 'fixture-we-2026',
    category: 'west-end',
    status: 'closed',
    openingDate: '2026-03-01',
    previewsStartDate: '2026-03-01',
    openingDateSource: 'todaytix',
    ...overrides,
  };
}

test('findTodaytixCollapsedShows: matches WE/OWE shows with collapsed dates + todaytix source', () => {
  const shows = [
    weShow({ id: 'a' }),
    weShow({ id: 'b', category: 'off-west-end' }),
    weShow({ id: 'c', openingDateSource: 'theatremonkey' }), // trusted source, excluded
    weShow({ id: 'd', previewsStartDate: '2026-02-20' }), // not collapsed, excluded
    weShow({ id: 'e', category: 'broadway' }), // wrong market, excluded
    weShow({ id: 'f', openingDate: null }), // missing date, excluded
  ];
  const result = findTodaytixCollapsedShows(shows);
  assert.deepEqual(result.map((s) => s.id).sort(), ['a', 'b']);
});

test('findTodaytixCollapsedShows: non-array input returns empty array', () => {
  assert.deepEqual(findTodaytixCollapsedShows(null), []);
  assert.deepEqual(findTodaytixCollapsedShows(undefined), []);
});

test('computeTodaytixPressNightChanges: applies a date correction from the verified map', () => {
  const shows = [weShow({ id: 'the-hunger-games-on-stage-west-end-2025', openingDate: '2025-11-28', previewsStartDate: '2025-11-28' })];
  const { applied, unresolved } = computeTodaytixPressNightChanges(shows);
  assert.equal(unresolved.length, 0);
  assert.equal(applied.length, 1);
  const openingChange = applied[0].changes.find((c) => c.field === 'openingDate');
  assert.equal(openingChange.new, '2025-11-12');
  const prevChange = applied[0].changes.find((c) => c.field === 'previewsStartDate');
  assert.equal(prevChange.new, '2025-10-20');
  const sourceChange = applied[0].changes.find((c) => c.field === 'openingDateSource');
  assert.equal(sourceChange.new, 'manual:bro-626-2026-08-21');
});

test('computeTodaytixPressNightChanges: confirmOnly entries upgrade source without touching dates', () => {
  const shows = [weShow({ id: 'broken-glass-west-end-2026', openingDate: '2026-03-03', previewsStartDate: '2026-03-03' })];
  const { applied } = computeTodaytixPressNightChanges(shows);
  assert.equal(applied.length, 1);
  assert.equal(applied[0].changes.length, 1, 'confirmOnly should only touch openingDateSource');
  assert.equal(applied[0].changes[0].field, 'openingDateSource');
});

test('computeTodaytixPressNightChanges: unresolved shows report a reason, never a fabricated date', () => {
  const shows = [weShow({ id: 'as-you-like-it-globe-west-end-2026', status: 'open' })];
  const { applied, unresolved } = computeTodaytixPressNightChanges(shows);
  assert.equal(applied.length, 0);
  assert.equal(unresolved.length, 1);
  assert.match(unresolved[0].reason, /no review of the 2026 production/);
});

test('computeTodaytixPressNightChanges: unrecognized upcoming show gets the not-yet-opened reason', () => {
  const shows = [weShow({ id: 'some-future-show-west-end-2027', status: 'upcoming' })];
  const { unresolved } = computeTodaytixPressNightChanges(shows);
  assert.equal(unresolved.length, 1);
  assert.match(unresolved[0].reason, /not-yet-opened/);
});

test('computeTodaytixPressNightChanges: unrecognized closed show gets the no-source reason', () => {
  const shows = [weShow({ id: 'some-obscure-show-west-end-2026', status: 'closed' })];
  const { unresolved } = computeTodaytixPressNightChanges(shows);
  assert.equal(unresolved.length, 1);
  assert.match(unresolved[0].reason, /no-reliable-independent-source-found/);
});

test('computeTodaytixPressNightChanges: a non-collapsed show is never touched', () => {
  const shows = [weShow({ id: 'trusted-show-2026', previewsStartDate: '2026-02-01' })];
  const { applied, unresolved } = computeTodaytixPressNightChanges(shows);
  assert.equal(applied.length, 0);
  assert.equal(unresolved.length, 0);
});

test('computeTodaytixPressNightChanges: full current cohort resolves with no throw and no fabricated entries', () => {
  // All 19 shows found collapsed in shows.json as of 2026-08-21 (BRO-626
  // research pass) — asserts the whole set partitions cleanly into
  // applied/unresolved with no crash, mirroring the real dataset shape.
  const ids = [
    'midnight-in-the-toyshop-west-end-2026',
    'austentatious-an-improvised-jane-austen-novel-west-end-2025',
    'murder-she-didnt-write-west-end-2025',
    'black-is-the-color-of-my-voice-west-end-2026',
    'the-boy-at-the-back-of-the-class-west-end-2026',
    'as-you-like-it-globe-west-end-2026',
    'dirty-dancing-the-classic-story-on-stage-west-end-2026',
    'the-enormous-crocodile-west-end-2026',
    'im-every-woman-the-chaka-khan-musical-west-end-2026',
    'garry-starr-classic-penguins-garrick-west-end-2026',
    'the-karate-kid-the-musical-west-end-2026',
    'i-was-a-teenage-shedevil-west-end-2026',
    'alice-in-wonderland-west-end-2026',
    'the-hunger-games-on-stage-west-end-2025',
    'broken-glass-west-end-2026',
    'bill-bailey-vaudevillean-west-end-2026',
    'anansi-the-spider-west-end-2026',
    'the-guy-who-didnt-like-musicals-west-end-2026',
    'the-snowman-west-end-2026',
  ];
  const shows = ids.map((id, i) => weShow({ id, openingDate: `2026-01-${String((i % 27) + 1).padStart(2, '0')}`, previewsStartDate: `2026-01-${String((i % 27) + 1).padStart(2, '0')}`, status: 'upcoming' }));
  const { applied, unresolved } = computeTodaytixPressNightChanges(shows);
  assert.equal(applied.length + unresolved.length, ids.length);
  assert.ok(applied.length >= 9, 'at least the 9 verified-map entries should apply regardless of injected dates');
  for (const u of unresolved) {
    assert.ok(typeof u.reason === 'string' && u.reason.length > 0);
  }
});
