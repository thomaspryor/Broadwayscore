/**
 * Structural guard for findSharedTicketIdentityDupes (BRO-2821 follow-up).
 *
 * WHY A STRUCTURAL TEST AND NOT A CORPUS SWEEP. The lesson the venue-token work
 * paid for twice: a sweep over TODAY'S catalog cannot prove a matcher correct.
 * The venue matcher passed a 355-venue sweep while being broken for every
 * accented venue, because the corpus happens to contain none. Here the same
 * hazard is sharper — the live catalog has exactly ONE shared-ticket pair
 * (AMAZE), so a corpus assertion would pass unchanged if the shape it depends
 * on (reading the id out of a ticketLinks URL) were deleted, as long as some
 * other field still matched. Every case below is therefore a fixture that
 * fails when the specific behaviour it names is removed.
 *
 * Per CLAUDE.md rule 15 this require()s the real exported function. No logic
 * is restated here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const { findSharedTicketIdentityDupes, ticketIdentityKeys } = require_('./show-duplicate-detection.js');

const pairIds = (dupes) => dupes.map((d) => [d.a, d.b].sort().join('|')).sort();

// The real AMAZE shape, reduced to the fields that decide the outcome. The
// 2025 entry carries todaytixId AND the URL; the 2026 entry carries ONLY the
// ticketLinks URL and NO todaytixId — which is why reading the numeric field
// alone would miss it.
const AMAZE_2025 = {
  id: 'amaze-magic-off-broadway-2025',
  title: 'AMAZE Magic',
  venue: 'New World Stages',
  openingDate: '2025-08-13',
  status: 'open',
  todaytixId: 44453,
  todaytixUrl: 'https://www.todaytix.com/nyc/shows/44453-amaze-magic',
  ticketLinks: [{ platform: 'TodayTix', url: 'https://www.todaytix.com/nyc/shows/44453-amaze-magic' }],
};
const AMAZE_2026 = {
  id: 'amaze-off-broadway-2026',
  title: 'AMAZE',
  venue: 'New World Stages – Stage 5',
  openingDate: null,
  previewsStartDate: null,
  status: 'open',
  ticketLinks: [{ platform: 'TodayTix', url: 'https://www.todaytix.com/nyc/shows/44453-amaze-magic' }],
};

test('catches the AMAZE pair: no shared title, no shared venue string, no dates at all', () => {
  const dupes = findSharedTicketIdentityDupes([AMAZE_2025, AMAZE_2026]);
  assert.equal(dupes.length, 1);
  assert.deepEqual(pairIds(dupes), ['amaze-magic-off-broadway-2025|amaze-off-broadway-2026']);
  assert.equal(dupes[0].key, 'todaytix:44453');
});

test('reads the id out of a ticketLinks URL when todaytixId is absent on BOTH sides', () => {
  // Strips the numeric field entirely, so the ONLY path to a match is the URL.
  // This is the case that fails if TODAYTIX_URL_ID or the ticketLinks scan is
  // removed, while the AMAZE test above would still pass via todaytixId.
  const a = { ...AMAZE_2025, todaytixId: undefined, todaytixUrl: undefined };
  const dupes = findSharedTicketIdentityDupes([a, AMAZE_2026]);
  assert.equal(dupes.length, 1, 'URL-only identity must still pair the two entries');
});

test('matches a numeric todaytixId against a URL-embedded id across entries', () => {
  const a = { id: 'x-2025', todaytixId: 44453 };
  const b = { id: 'x-2026', ticketLinks: [{ url: 'https://www.todaytix.com/london/shows/44453-whatever' }] };
  assert.equal(findSharedTicketIdentityDupes([a, b]).length, 1);
});

test('string and number forms of the same id are one identity', () => {
  const a = { id: 'a-1', todaytixId: 44453 };
  const b = { id: 'b-1', todaytixId: '44453' };
  assert.equal(findSharedTicketIdentityDupes([a, b]).length, 1);
});

test('different ticket ids are NOT a duplicate even at one venue with one title', () => {
  const a = { id: 'a-1', title: 'Hamlet', venue: 'A Theatre', todaytixId: 111 };
  const b = { id: 'b-1', title: 'Hamlet', venue: 'A Theatre', todaytixId: 222 };
  assert.deepEqual(findSharedTicketIdentityDupes([a, b]), []);
});

test('a declared transfer pair sharing one listing is NOT reported, in either direction', () => {
  const tryout = { id: 'show-regional-2024', todaytixId: 999, transferredTo: 'show-bway-2025' };
  const bway = { id: 'show-bway-2025', todaytixId: 999, transferOf: 'show-regional-2024' };
  assert.deepEqual(findSharedTicketIdentityDupes([tryout, bway]), [], 'both directions declared');

  // Declared from ONE side only — still a deliberate relationship.
  const oneSided = [{ id: 'p-2024', todaytixId: 998 }, { id: 'q-2025', todaytixId: 998, transferOf: 'p-2024' }];
  assert.deepEqual(findSharedTicketIdentityDupes(oneSided), [], 'one-sided transferOf');
});

test('a pair sharing TWO different ticket ids is reported ONCE, not twice', () => {
  // The audit baseline is keyed on the unordered id pair, so a double report
  // would also double-count the pair as "new" under --strict.
  //
  // The fixture has to give both entries the SAME TWO keys, which happens when
  // todaytixId and the ticketLinks URL disagree on both sides (a re-listing
  // updates one field and not the other). An earlier version of this test gave
  // both shows one id in both fields and asserted the same thing — and it
  // PASSED with the dedupe deleted, because ticketIdentityKeys returns a Set,
  // so one listing is one key and the pair could only ever be emitted once.
  // Caught by reverting the dedupe and watching this test NOT fail.
  const a = { id: 'a-1', todaytixId: 7, ticketLinks: [{ url: 'https://www.todaytix.com/nyc/shows/8-a' }] };
  const b = { id: 'b-1', todaytixId: 7, ticketLinks: [{ url: 'https://www.todaytix.com/nyc/shows/8-b' }] };
  assert.equal(ticketIdentityKeys(a).size, 2, 'fixture must produce two keys or the dedupe is never exercised');
  assert.equal(findSharedTicketIdentityDupes([a, b]).length, 1);
});

test('missing, empty and malformed ticket fields never pair anything', () => {
  const shows = [
    { id: 'none-1' },
    { id: 'none-2' },
    { id: 'empty-1', todaytixId: '', ticketLinks: [] },
    { id: 'empty-2', todaytixId: null, ticketLinks: [{ url: null }, null] },
    { id: 'other-1', ticketLinks: [{ url: 'https://www.telecharge.com/whatever' }] },
    { id: 'other-2', ticketLinks: [{ url: 'https://www.telecharge.com/whatever' }] },
  ];
  assert.deepEqual(findSharedTicketIdentityDupes(shows), [], 'absent/blank/non-TodayTix identity is not identity');
});

test('three entries on one listing yield all three pairs, each once', () => {
  const shows = [{ id: 'a' }, { id: 'b' }, { id: 'c' }].map((s) => ({ ...s, todaytixId: 5 }));
  assert.deepEqual(pairIds(findSharedTicketIdentityDupes(shows)), ['a|b', 'a|c', 'b|c']);
});

test('non-array and empty input are safe', () => {
  for (const bad of [null, undefined, 'nope', 42, {}]) {
    assert.deepEqual(findSharedTicketIdentityDupes(bad), []);
  }
  assert.deepEqual(findSharedTicketIdentityDupes([]), []);
});

test('ticketIdentityKeys dedupes the numeric field against its own URL', () => {
  const keys = ticketIdentityKeys(AMAZE_2025);
  assert.deepEqual([...keys], ['todaytix:44453'], 'one listing must produce exactly one key');
});
