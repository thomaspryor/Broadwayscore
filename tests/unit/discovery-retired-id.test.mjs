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
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = join(import.meta.dirname, '..', '..');
const { matchesRetired, retireId, loadRetiredIds, _resetCache } = require(join(ROOT, 'scripts/lib/retired-show-ids.js'));
const { mintCandidateId } = require(join(ROOT, 'scripts/discover-new-shows.js'));

// In-memory registry — exactly the entry S0-T9 will write for the phantom
// row (`retireId(..., { blockTitleVenue: true })`: junk that must never
// return under ANY id, the one form that records title/venue), plus a
// legacy id-only entry.
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

test('a duplicate retired the default way (id-only) refuses only its own id — a same-title+venue re-discovery under a new id is NOT refused; blockTitleVenue:true refuses it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'discovery-retired-'));
  const paths = { listPath: join(dir, 'retired-show-ids.json'), archivePath: join(dir, 'deleted-shows.json') };
  _resetCache();
  try {
    // hamlet-off-broadway-2025 was a duplicate of the kept hamlet-off-broadway-2024
    // row: same title, same venue. Retired the default way, through the real
    // retireId, so the entry is exactly what lands on disk.
    const dup = { id: 'hamlet-off-broadway-2025', title: 'Hamlet', venue: 'The Public Theater', category: 'off-broadway', openingDate: '2025-03-01' };
    retireId(dup.id, { reason: 'duplicate of hamlet-off-broadway-2024', archivedRow: dup, ...paths });
    let entries = loadRetiredIds(paths);
    assert.equal(entries[0].title, null, 'default retirement records no title');
    assert.equal(entries[0].venue, null, 'default retirement records no venue');

    const sameListing = { title: 'Hamlet', venue: 'The Public Theater', category: 'off-broadway', openingDate: '2025-03-01' };
    assert.equal(mintCandidateId(sameListing).showId, dup.id, 'sanity: the same listing mints the retired id');
    assert.deepEqual(matchesRetired(candidateFor(sameListing), entries), { id: dup.id, matchedBy: 'id' });

    const kept = { title: 'Hamlet', venue: 'The Public Theater', category: 'off-broadway', openingDate: '2024-03-01' };
    assert.equal(mintCandidateId(kept).showId, 'hamlet-off-broadway-2024');
    assert.equal(matchesRetired(candidateFor(kept), entries), null, 'the kept row (same title+venue) is never refused');

    const revival = { title: 'Hamlet', venue: 'The Public Theater', category: 'off-broadway', openingDate: '2031-03-01' };
    assert.equal(mintCandidateId(revival).showId, 'hamlet-off-broadway-2031');
    assert.equal(matchesRetired(candidateFor(revival), entries), null, 'a later same-title revival at the same house is not blocked by an id-only retirement');

    // Junk (a panel listing) retired with blockTitleVenue: true — no id may
    // bring it back, however the source re-dates it.
    const junk = { id: 'hamlet-panel-off-broadway-2025', title: 'Hamlet Panel', venue: 'The Public Theater', category: 'off-broadway', openingDate: '2025-03-01' };
    retireId(junk.id, { reason: 'panel discussion, not a production', archivedRow: junk, blockTitleVenue: true, ...paths });
    entries = loadRetiredIds(paths);
    const junkAgain = { title: 'HAMLET PANEL', venue: 'the public theater', category: 'off-broadway', openingDate: '2027-03-01' };
    assert.equal(mintCandidateId(junkAgain).showId, 'hamlet-panel-off-broadway-2027');
    assert.deepEqual(matchesRetired(candidateFor(junkAgain), entries), { id: junk.id, matchedBy: 'title+venue' });
    assert.equal(matchesRetired(candidateFor(revival), entries), null, 'the id-only entry still does not block the revival');
  } finally {
    _resetCache();
    rmSync(dir, { recursive: true, force: true });
  }
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
  const retiredCall = src.indexOf('matchesRetired({ id: minted.showId, title: show.title, venue: sanitizeVenueForWrite(show.venue) })', loopStart);
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
