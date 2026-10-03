/**
 * tour-roundup-candidate (BRO-4211 Phase E): which BroadwayWorld roundups
 * become "add this national tour?" digest suggestions.
 *
 * Run: node --test tests/unit/tour-roundup-candidate.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isNationalTourRoundupSlug, tourCandidateFor } = require('../../scripts/lib/tour-roundup-candidate.js');

test('national tour roundup slugs are recognised; UK tours and look-alike words are not', () => {
  for (const s of [
    'Review-Roundup-DIRTY-DANCING-Launches-North-AMERICAN-Tour-20260923',
    'Review-Roundup-DEATH-BECOMES-HER-Launches-National-Tour-20260915',
    'Review-Roundup-BEETLEJUICE-Haunts-Houses-Across-the-US-on-its-National-Tour-20221221',
    'Review-Roundup-SHUCKED-on-Tour-20241106',
    'Review-Roundup-HADESTOWN-Tour-Launches-in-Houston-20231010',
  ]) assert.equal(isNationalTourRoundupSlug(s), true, s);
  for (const s of [
    'Review-Roundup-HADESTOWN-Opens-on-Broadway-20190417',
    'Review-Roundup-SIX-Launches-UK-and-Ireland-Tour-20250110',
    'Review-Roundup-THE-TOURIST-Opens-Off-Broadway-20260101',
    'Review-Roundup-DETOUR-Opens-20260101',
    '',
  ]) assert.equal(isNationalTourRoundupSlug(s), false, s);
});

test('a candidate only for a Broadway show with no tour entry of its title', () => {
  const dbh = { id: 'death-becomes-her-2024', title: 'Death Becomes Her', category: 'broadway' };
  const bj19 = { id: 'beetlejuice-2019', title: 'Beetlejuice', category: 'broadway' };
  const bj25 = { id: 'beetlejuice-2025', title: 'Beetlejuice', category: 'broadway' };
  const bjTour = { id: 'beetlejuice-tour-2022', title: 'Beetlejuice', category: 'tour', tourOf: 'beetlejuice-2019' };
  const shows = [dbh, bj19, bj25, bjTour];
  const slug = 'Review-Roundup-X-Launches-National-Tour-20260915';
  assert.deepEqual(tourCandidateFor(slug, dbh, shows), { broadwayShowId: 'death-becomes-her-2024', title: 'Death Becomes Her' });
  assert.equal(tourCandidateFor(slug, bj25, shows), null, 'a tour of the same title already exists');
  assert.equal(tourCandidateFor('Review-Roundup-X-Opens-on-Broadway-20260101', dbh, shows), null);
  assert.equal(tourCandidateFor(slug, { id: 'x-off-broadway-2026', title: 'X', category: 'off-broadway' }, shows), null);
  assert.equal(tourCandidateFor(slug, null, shows), null);
});

test('recordTourCandidates keeps one row per show and its first-seen time; openTourCandidates drops tracked tours', async () => {
  const { recordTourCandidates, openTourCandidates } = require('../../scripts/lib/tour-roundup-candidate.js');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tour-cand-'));
  try {
    const file = path.join(dir, 'c.json');
    const slug = 'Review-Roundup-DEATH-BECOMES-HER-Launches-National-Tour-20260915';
    const c = { broadwayShowId: 'death-becomes-her-2024', title: 'Death Becomes Her', url: 'https://x/a', slug };
    assert.equal(recordTourCandidates(file, [c], '2026-09-01T00:00:00Z'), 1);
    assert.equal(recordTourCandidates(file, [c], '2026-09-02T00:00:00Z'), 1);
    const rows = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(rows[0].firstSeen, '2026-09-01T00:00:00Z');
    assert.equal(rows[0].lastSeen, '2026-09-02T00:00:00Z');
    const dbh = { id: 'death-becomes-her-2024', title: 'Death Becomes Her', category: 'broadway' };
    assert.equal(openTourCandidates(rows, [dbh]).length, 1);
    const tour = { id: 'death-becomes-her-tour-2026', title: 'Death Becomes Her', category: 'tour', tourOf: 'death-becomes-her-2024' };
    assert.equal(openTourCandidates(rows, [dbh, tour]).length, 0, 'a tour entry settles the row');
    assert.equal(openTourCandidates(rows, []).length, 0, 'a removed show settles the row');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('launch roundups with words before "Tour" count; overseas legs still do not (BRO-4563)', () => {
  for (const s of [
    'Review-Roundup-OPERATION-MINCEMEAT-Launches-North-American-Leg-of-World-Tour-20260930',
    'Review-Roundup-JERSEY-BOYS-Launches-20th-Anniversary-Tour-20260101',
    'Review-Roundup-MAYBE-HAPPY-ENDING-Launches-North-American-Tour-20260930',
  ]) assert.equal(isNationalTourRoundupSlug(s), true, s);
  for (const s of [
    'Review-Roundup-SIX-Launches-Australian-Tour-20260101',
    'Review-Roundup-SIX-Launches-European-Leg-of-World-Tour-20260101',
    'Review-Roundup-HAMILTON-Launches-International-Tour-20260101',
    'Review-Roundup-LAUNCH-Opens-Off-Broadway-20260101',
  ]) assert.equal(isNationalTourRoundupSlug(s), false, s);
});

test('roundupDateFromSlug reads the -YYYYMMDD tail only', () => {
  const { roundupDateFromSlug } = require('../../scripts/lib/tour-roundup-candidate.js');
  assert.equal(roundupDateFromSlug('https://www.broadwayworld.com/article/Review-Roundup-X-Launches-North-American-Leg-of-World-Tour-20260930'), '2026-09-30');
  assert.equal(roundupDateFromSlug('Review-Roundup-X-Tour-20260930/?utm=1'), '2026-09-30');
  assert.equal(roundupDateFromSlug('Review-Roundup-X-Tour'), null);
  assert.equal(roundupDateFromSlug(''), null);
  assert.equal(roundupDateFromSlug(null), null);
});

test('a roundup and a Tours To You row for one show merge into the schedule row (BRO-4563)', async () => {
  const { recordTourCandidates } = require('../../scripts/lib/tour-roundup-candidate.js');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tour-cand-'));
  try {
    const file = path.join(dir, 'c.json');
    const read = () => JSON.parse(fs.readFileSync(file, 'utf8'));
    const sched = { broadwayShowId: 'operation-mincemeat-2025', title: 'Operation Mincemeat', source: 'tourstoyou', slug: 'tourstoyou:operation-mincemeat:2026-09-20', url: 'https://tourstoyou.org/shows/operation-mincemeat/', tourScheduleSlug: 'operation-mincemeat', segmentStart: '2026-09-20' };
    const roundupUrl = 'https://www.broadwayworld.com/article/Review-Roundup-OPERATION-MINCEMEAT-Launches-North-American-Leg-of-World-Tour-20260930';
    const roundup = { broadwayShowId: 'operation-mincemeat-2025', title: 'Operation Mincemeat', url: roundupUrl, slug: 'Review-Roundup-OPERATION-MINCEMEAT-Launches-North-American-Leg-of-World-Tour-20260930' };

    // Schedule first, roundup later: the schedule row keeps its identity and gains the roundup.
    recordTourCandidates(file, [sched], '2026-09-29T00:00:00Z');
    recordTourCandidates(file, [roundup], '2026-10-04T00:00:00Z');
    let [row] = read();
    assert.equal(row.source, 'tourstoyou');
    assert.equal(row.segmentStart, '2026-09-20');
    assert.equal(row.url, sched.url);
    assert.equal(row.roundupUrl, roundupUrl);
    assert.equal(row.roundupSeen, '2026-10-04T00:00:00Z');
    assert.equal(row.firstSeen, '2026-09-29T00:00:00Z');

    // The daily schedule pass and the same roundup again keep both.
    recordTourCandidates(file, [sched], '2026-10-05T00:00:00Z');
    recordTourCandidates(file, [roundup], '2026-10-06T00:00:00Z');
    [row] = read();
    assert.equal(row.roundupUrl, roundupUrl);
    assert.equal(row.roundupSeen, '2026-10-04T00:00:00Z', 'same roundup keeps its first sighting');
    assert.equal(row.source, 'tourstoyou');
    assert.equal(row.firstSeen, '2026-09-29T00:00:00Z');

    // Roundup first, schedule later: same result.
    fs.rmSync(file);
    recordTourCandidates(file, [roundup], '2026-10-01T00:00:00Z');
    recordTourCandidates(file, [sched], '2026-10-02T00:00:00Z');
    [row] = read();
    assert.equal(row.source, 'tourstoyou');
    assert.equal(row.roundupUrl, roundupUrl);
    assert.equal(row.roundupSeen, '2026-10-01T00:00:00Z');
    assert.equal(read().length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});
