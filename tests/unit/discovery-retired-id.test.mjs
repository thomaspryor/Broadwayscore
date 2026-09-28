// Discovery refuses retired ids (2026 data audit, S0-T3).
//
// The phantom "?tab=dates" row was deleted by hand and re-minted by the next
// discover-new-shows.js run, because none of the dedup checks can see a row
// that no longer exists. The candidate loop now asks the retired-id registry
// FIRST, on the id it would mint or the archived row's normalized
// title+venue.
//
// Per CLAUDE.md §15 this requires the real predicate (matchesRetired) and the
// real id-minting helper (mintCandidateId, exported from discover-new-shows.js)
// with in-memory retired entries, and then asserts the loop is actually wired
// to them — a passing predicate proves nothing if the loop never calls it.
//
// Run: node --test tests/unit/discovery-retired-id.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = join(import.meta.dirname, '..', '..');
const { matchesRetired, _resetCache } = require(join(ROOT, 'scripts/lib/retired-show-ids.js'));
const { mintCandidateId } = require(join(ROOT, 'scripts/discover-new-shows.js'));

// In-memory registry — exactly the entry S0-T9 will write for the phantom
// row, plus a legacy id-only entry.
const RETIRED = [
  {
    id: 'tabdates-off-west-end-2026',
    reason: 'phantom row minted from a ?tab=dates listing URL (2026 audit)',
    retiredAt: '2026-09-28T00:00:00.000Z',
    title: '?tab=dates',
    venue: 'Southwark Playhouse',
  },
  { id: 'old-legacy-off-broadway-2019', reason: 'dup', retiredAt: '2026-09-28T00:00:00.000Z' },
];

function candidateFor(show) {
  const minted = mintCandidateId(show);
  return { id: minted.showId, title: show.title, venue: show.venue };
}

test('a candidate whose minted id is retired is refused (fixture: the phantom ?tab=dates row)', () => {
  const show = { title: '?tab=dates', venue: 'Southwark Playhouse', category: 'off-west-end', openingDate: '2026-03-01' };
  const minted = mintCandidateId(show);
  assert.equal(minted.showId, 'tabdates-off-west-end-2026', 'sanity: the real minting helper produces the retired id');
  assert.deepEqual(matchesRetired(candidateFor(show), RETIRED), { id: 'tabdates-off-west-end-2026', matchedBy: 'id' });
});

test('a re-discovered listing with a different id-year is refused on title+venue', () => {
  // Same listing, but the source now reports a 2027 start, so the minted id
  // differs from the retired one. The archived title+venue still names it.
  const show = { title: '?TAB=DATES', venue: 'southwark playhouse', category: 'off-west-end', previewsStartDate: '2027-01-10' };
  assert.equal(mintCandidateId(show).showId, 'tabdates-off-west-end-2027');
  assert.deepEqual(matchesRetired(candidateFor(show), RETIRED), { id: 'tabdates-off-west-end-2026', matchedBy: 'title+venue' });
});

test('an unrelated candidate is NOT refused', () => {
  const show = { title: 'Hamilton', venue: 'Richard Rodgers Theatre', category: 'broadway', openingDate: '2026-11-01' };
  assert.equal(matchesRetired(candidateFor(show), RETIRED), null);
});

test('a legacy id-only retired entry matches by id but never by (empty) title+venue', () => {
  const byId = { title: 'Old Legacy', venue: 'Somewhere', category: 'off-broadway', openingDate: '2019-05-01' };
  assert.equal(mintCandidateId(byId).showId, 'old-legacy-off-broadway-2019');
  assert.equal(matchesRetired(candidateFor(byId), RETIRED)?.matchedBy, 'id');

  const noVenue = { title: '', venue: '', category: 'off-broadway', openingDate: '2020-05-01' };
  assert.equal(matchesRetired({ id: 'x-off-broadway-2020', title: noVenue.title, venue: noVenue.venue }, RETIRED), null);
});

test('mintCandidateId mirrors the id-year rule the loop used to inline (opening > previews > unconfirmed > now)', () => {
  const now = new Date('2026-06-01T00:00:00Z');
  assert.equal(mintCandidateId({ title: 'A Show', category: 'broadway', openingDate: '2027-02-01', previewsStartDate: '2026-12-01' }, now).showId, 'a-show-2027');
  assert.equal(mintCandidateId({ title: 'A Show', category: 'broadway', previewsStartDate: '2026-12-01' }, now).showId, 'a-show-2026');
  assert.equal(mintCandidateId({ title: 'A Show', category: 'off-broadway', unconfirmedStartDate: '2027-03-01' }, now).showId, 'a-show-off-broadway-2027');
  assert.equal(mintCandidateId({ title: 'A Show', category: 'off-broadway' }, now).showId, 'a-show-off-broadway-2026');
  // ISO dates are normalized; garbage dates become null rather than throwing.
  const minted = mintCandidateId({ title: 'A Show', category: 'west-end', openingDate: 'not a date', closingDate: '2026-12-31T00:00:00Z' }, now);
  assert.equal(minted.openingDate, null);
  assert.equal(minted.closingDate, '2026-12-31');
  assert.equal(minted.showId, 'a-show-west-end-2026');
});

test('discover-new-shows.js is wired: the candidate loop calls matchesRetired on the minted id before any dedup check and logs retired-skip', () => {
  const src = readFileSync(join(ROOT, 'scripts/discover-new-shows.js'), 'utf8');
  assert.match(src, /require\('\.\/lib\/retired-show-ids'\)/, 'must require the real registry module');

  const loopStart = src.indexOf('for (const show of discoveredShows) {');
  assert.ok(loopStart > 0, 'candidate loop must exist');
  const todaytixDedup = src.indexOf('existingTodaytixIds.has(show.todaytixId)', loopStart);
  const retiredCall = src.indexOf('matchesRetired({ id: minted.showId, title: show.title, venue: show.venue })', loopStart);
  const mintCall = src.indexOf('const minted = mintCandidateId(show);', loopStart);
  assert.ok(mintCall > loopStart && mintCall < retiredCall, 'the id must be minted before the retired check');
  assert.ok(retiredCall > loopStart && retiredCall < todaytixDedup, 'retired check must run before the first dedup step');

  const loopBody = src.slice(loopStart, src.indexOf('resolveReconciliationProposals();', loopStart));
  assert.match(loopBody, /retired-skip: \$\{minted\.showId\}/, 'must log retired-skip: <id>');
  assert.match(loopBody, /retiredSkipped\.push\(/, 'must count the skip');
  assert.ok(!/const showId = `\$\{marketSlug\}-\$\{idYear\}`;/.test(loopBody),
    'the loop must not re-derive the id inline — one minting site only');
  assert.match(loopBody, /\} = minted;/, 'the row must use the same minted id/dates');

  assert.match(src, /retiredSkippedCount: retiredSkipped\.length/, 'run summary must report the count');
});
