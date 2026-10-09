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

test('a candidate only for a Broadway, Off-Broadway or regional show with no tour entry of its title', () => {
  const dbh = { id: 'death-becomes-her-2024', title: 'Death Becomes Her', category: 'broadway' };
  const bj19 = { id: 'beetlejuice-2019', title: 'Beetlejuice', category: 'broadway' };
  const bj25 = { id: 'beetlejuice-2025', title: 'Beetlejuice', category: 'broadway' };
  const bjTour = { id: 'beetlejuice-tour-2022', title: 'Beetlejuice', category: 'tour', tourOf: 'beetlejuice-2019' };
  const shows = [dbh, bj19, bj25, bjTour];
  const slug = 'Review-Roundup-X-Launches-National-Tour-20260915';
  assert.deepEqual(tourCandidateFor(slug, dbh, shows), { broadwayShowId: 'death-becomes-her-2024', title: 'Death Becomes Her' });
  assert.equal(tourCandidateFor(slug, bj25, shows), null, 'a tour of the same title already exists');
  assert.equal(tourCandidateFor('Review-Roundup-X-Opens-on-Broadway-20260101', dbh, shows), null);
  // Off-Broadway and regional productions can be toured from too (BRO-4931); West End cannot.
  assert.deepEqual(tourCandidateFor(slug, { id: 'x-off-broadway-2026', title: 'X', category: 'off-broadway' }, shows), { broadwayShowId: 'x-off-broadway-2026', title: 'X' });
  assert.deepEqual(tourCandidateFor(slug, { id: 'x-regional-2026', title: 'X', category: 'regional' }, shows), { broadwayShowId: 'x-regional-2026', title: 'X' });
  assert.equal(tourCandidateFor(slug, { id: 'x-west-end-2026', title: 'X', category: 'west-end' }, shows), null);
  assert.equal(tourCandidateFor(slug, { id: 'x-owe-2026', title: 'X', category: 'off-west-end' }, shows), null);
  assert.equal(tourCandidateFor(slug, { id: 'x-tour-2026', title: 'X', category: 'tour' }, shows), null);
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
    'Review-Roundup-X-National-Tour-with-Asian-American-Cast-20260930',
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
  assert.equal(roundupDateFromSlug('Review-Roundup-X-Tour-20260230'), null, 'not a calendar date');
  assert.equal(roundupDateFromSlug('Review-Roundup-X-Tour-20261399'), null);
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

    // The owner was asked about the roundup row: the merged row isn't asked again.
    fs.writeFileSync(file, JSON.stringify([{ ...roundup, firstSeen: '2026-10-01T00:00:00Z', notifiedAt: '2026-10-01T01:00:00Z' }]));
    recordTourCandidates(file, [sched], '2026-10-02T00:00:00Z');
    [row] = read();
    assert.equal(row.notifiedAt, '2026-10-01T01:00:00Z');
    assert.equal(row.roundupUrl, roundupUrl);

    // A roundup whose tour was already created belongs to that earlier tour:
    // a later schedule row starts fresh, without it.
    fs.writeFileSync(file, JSON.stringify([{ ...roundup, firstSeen: '2024-10-01T00:00:00Z', notifiedAt: '2024-10-01T01:00:00Z', createdTourId: 'operation-mincemeat-tour-2024' }]));
    recordTourCandidates(file, [sched], '2026-10-02T00:00:00Z');
    [row] = read();
    assert.equal(row.source, 'tourstoyou');
    assert.equal(row.roundupUrl, undefined);
    assert.equal(row.createdTourId, undefined);
    assert.equal(row.notifiedAt, undefined);
    assert.equal(row.firstSeen, '2026-10-02T00:00:00Z');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('a national-tour roundup never matches a West End production of the title (BRO-4924)', () => {
  const { roundupMatchPool } = require('../../scripts/lib/tour-roundup-candidate.js');
  const { matchBwwRoundupSlugToShow } = require('../../scripts/lib/show-matching.js');
  const shows = [
    { id: 'dirty-dancing-2027', title: 'Dirty Dancing', category: 'broadway', status: 'announced', openingDate: null },
    { id: 'dirty-dancing-the-classic-story-on-stage-west-end-2026', title: 'Dirty Dancing: The Classic Story on Stage', category: 'off-west-end', status: 'upcoming', openingDate: '2026-10-16' },
  ];
  const tourSlug = 'Review-Roundup-DIRTY-DANCING-Launches-North-American-Tour-20260923';
  assert.equal(isNationalTourRoundupSlug(tourSlug), true);
  // Unfiltered, the token tie breaks on openingDate and the West End show wins.
  assert.equal(matchBwwRoundupSlugToShow(tourSlug, shows).show.id, 'dirty-dancing-the-classic-story-on-stage-west-end-2026');
  assert.equal(matchBwwRoundupSlugToShow(tourSlug, roundupMatchPool(tourSlug, shows)).show.id, 'dirty-dancing-2027');
  // A West End-only title has no Broadway show to tour from: unmatched, not mis-filed.
  assert.equal(matchBwwRoundupSlugToShow(tourSlug, roundupMatchPool(tourSlug, shows.slice(1))), null);
  // Other slugs keep matching every show.
  const plain = 'Review-Roundup-DIRTY-DANCING-Opens-in-the-West-End-20261016';
  assert.equal(roundupMatchPool(plain, shows), shows);
});

test('the roundup pool adds Off-Broadway and regional shows but still excludes West End (BRO-4931)', () => {
  const { roundupMatchPool } = require('../../scripts/lib/tour-roundup-candidate.js');
  const { matchBwwRoundupSlugToShow } = require('../../scripts/lib/show-matching.js');
  const shows = [
    { id: 'the-brightest-off-broadway-2026', title: 'The Brightest Star', category: 'off-broadway', status: 'open', openingDate: '2026-03-01' },
    { id: 'harbor-lights-regional-2026', title: 'Harbor Lights', category: 'regional', status: 'open', openingDate: '2026-02-01' },
    { id: 'moonlit-garden-west-end-2026', title: 'Moonlit Garden', category: 'west-end', status: 'open', openingDate: '2026-01-01' },
    { id: 'moonlit-garden-off-west-end-2026', title: 'Moonlit Garden', category: 'off-west-end', status: 'open', openingDate: '2026-01-01' },
    { id: 'sample-show-2026', title: 'Sample Show', category: 'broadway', status: 'open', openingDate: '2026-01-01' },
  ];
  const slug = (t) => `Review-Roundup-${t}-Launches-National-Tour-20261007`;
  assert.deepEqual(roundupMatchPool(slug('X'), shows).map(s => s.category), ['off-broadway', 'regional', 'broadway']);
  // An Off-Broadway-only title's national-tour roundup now matches that show.
  assert.equal(matchBwwRoundupSlugToShow(slug('THE-BRIGHTEST-STAR'), roundupMatchPool(slug('THE-BRIGHTEST-STAR'), shows)).show.id, 'the-brightest-off-broadway-2026');
  assert.equal(matchBwwRoundupSlugToShow(slug('HARBOR-LIGHTS'), roundupMatchPool(slug('HARBOR-LIGHTS'), shows)).show.id, 'harbor-lights-regional-2026');
  // A West End-only title still does not.
  assert.equal(matchBwwRoundupSlugToShow(slug('MOONLIT-GARDEN'), roundupMatchPool(slug('MOONLIT-GARDEN'), shows)), null);
  // Non-tour slugs are unfiltered.
  assert.equal(roundupMatchPool('Review-Roundup-MOONLIT-GARDEN-Opens-in-the-West-End-20261016', shows), shows);
});

test('Oh, Mary! national-tour roundup resolves through the pool to the tour entry (BRO-4929 + BRO-4931)', () => {
  const { roundupMatchPool } = require('../../scripts/lib/tour-roundup-candidate.js');
  const { matchBwwRoundupSlugToShow } = require('../../scripts/lib/show-matching.js');
  const shows = [
    { id: 'oh-mary-2024', title: 'Oh, Mary!', category: 'broadway', status: 'open', openingDate: '2024-07-11' },
    { id: 'oh-mary-off-broadway-2024', title: 'Oh, Mary!', category: 'off-broadway', status: 'closed', openingDate: '2024-02-08' },
    { id: 'oh-mary-west-end-2025', title: 'Oh, Mary!', category: 'west-end', status: 'open', openingDate: '2025-12-18' },
    { id: 'oh-mary-tour-2026', title: 'Oh, Mary!', category: 'tour', status: 'open', openingDate: '2026-09-19' },
  ];
  const slug = 'Review-Roundup-OH-MARY-Opens-National-Tour-20261007';
  const m = matchBwwRoundupSlugToShow(slug, roundupMatchPool(slug, shows));
  assert.equal(m.show.id, 'oh-mary-tour-2026');
  assert.equal(m.via, 'slug-exact-title');
  // Without the tour entry it resolves to a US parent, never the West End run.
  const noTour = shows.filter(s => s.category !== 'tour');
  assert.equal(matchBwwRoundupSlugToShow(slug, roundupMatchPool(slug, noTour)).show.id, 'oh-mary-2024');
});

test('roundupOnlyCandidate: a documented row shape, a title hint only, null for non-tour slugs (BRO-4931)', () => {
  const { roundupOnlyCandidate } = require('../../scripts/lib/tour-roundup-candidate.js');
  const url = 'https://www.broadwayworld.com/article/Review-Roundup-THE-GREAT-LUMINA-Launches-North-American-Tour-20261005';
  const row = roundupOnlyCandidate('Review-Roundup-THE-GREAT-LUMINA-Launches-North-American-Tour-20261005', url);
  assert.deepEqual(row, {
    key: 'roundup:review-roundup-the-great-lumina-launches-north-american-tour-20261005',
    source: 'bww-roundup',
    slug: 'Review-Roundup-THE-GREAT-LUMINA-Launches-North-American-Tour-20261005',
    url,
    roundupUrl: url,
    title: 'The Great Lumina',
  });
  assert.equal('broadwayShowId' in row, false);
  assert.equal(roundupOnlyCandidate('Review-Roundup-X-Opens-on-Broadway-20260101', url), null);
  assert.equal(roundupOnlyCandidate('Review-Roundup-SIX-Launches-UK-and-Ireland-Tour-20250110', url), null);
  assert.equal(roundupOnlyCandidate('Review-Roundup-SHUCKED-on-Tour-20241106', url).title, 'Shucked');
});

test('roundup-only rows are recorded beside show rows, old rows still read, and openTourCandidates skips them (BRO-4931)', async () => {
  const { recordTourCandidates, openTourCandidates, roundupOnlyCandidate } = require('../../scripts/lib/tour-roundup-candidate.js');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tour-cand-'));
  try {
    const file = path.join(dir, 'c.json');
    const read = () => JSON.parse(fs.readFileSync(file, 'utf8'));
    // An old row (no key field) as written before this change.
    fs.writeFileSync(file, JSON.stringify([{ broadwayShowId: 'death-becomes-her-2024', title: 'Death Becomes Her', url: 'https://x/a', slug: 'Review-Roundup-DEATH-BECOMES-HER-Launches-National-Tour-20260915', firstSeen: '2026-09-01T00:00:00Z', notifiedAt: '2026-09-02T00:00:00Z' }]));
    const slug = 'Review-Roundup-THE-GREAT-LUMINA-Launches-North-American-Tour-20261005';
    const only = roundupOnlyCandidate(slug, 'https://www.broadwayworld.com/article/' + slug);
    assert.equal(recordTourCandidates(file, [only], '2026-10-06T00:00:00Z'), 2);
    assert.equal(recordTourCandidates(file, [only], '2026-10-07T00:00:00Z'), 2, 'same roundup seen again is the same row');
    let rows = read();
    const old = rows.find(r => r.broadwayShowId === 'death-becomes-her-2024');
    assert.equal(old.notifiedAt, '2026-09-02T00:00:00Z', 'old row untouched');
    const ro = rows.find(r => r.key === only.key);
    assert.equal(ro.firstSeen, '2026-10-06T00:00:00Z');
    assert.equal(ro.lastSeen, '2026-10-07T00:00:00Z');
    assert.equal(ro.source, 'bww-roundup');
    // An old show row updates in place (keyed by broadwayShowId) beside the new kind.
    recordTourCandidates(file, [{ broadwayShowId: 'death-becomes-her-2024', title: 'Death Becomes Her', url: 'https://x/a', slug: old.slug }], '2026-10-08T00:00:00Z');
    rows = read();
    assert.equal(rows.length, 2);
    assert.equal(rows.find(r => r.broadwayShowId === 'death-becomes-her-2024').notifiedAt, '2026-09-02T00:00:00Z');
    // Roundup-only rows are not suggestions; old rows still are.
    const dbh = { id: 'death-becomes-her-2024', title: 'Death Becomes Her', category: 'broadway' };
    assert.deepEqual(openTourCandidates(rows, [dbh]).map(r => r.broadwayShowId), ['death-becomes-her-2024']);
    // Two different standalone roundups are two rows.
    const other = 'Review-Roundup-ANOTHER-SHOW-Opens-National-Tour-20261009';
    assert.equal(recordTourCandidates(file, [roundupOnlyCandidate(other, 'https://x/' + other)], '2026-10-09T00:00:00Z'), 3);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});

// ---- BRO-4931: tours with no Broadway parent ----------------------------------

test('hasOpenTour: a tour with no tourOf is matched by its own title; a parented one by parent id or title', () => {
  const { hasOpenTour, candidateParentId } = require('../../scripts/lib/tour-roundup-candidate.js');
  const standalone = { id: 'the-bodyguard-tour-2026', title: 'The Bodyguard', category: 'tour', status: 'open', closingDate: null, tourScheduleSlug: 'the-bodyguard' };
  const parent = { id: 'mexodus-off-broadway-2026', title: 'Mexodus', category: 'off-broadway' };
  const parented = { id: 'mexodus-tour-2026', title: 'Mexodus', category: 'tour', tourOf: parent.id, status: 'open', closingDate: null };
  assert.equal(hasOpenTour({ id: null, title: 'The Bodyguard' }, [standalone]), true);
  assert.equal(hasOpenTour({ id: null, title: 'Clue' }, [standalone]), false);
  assert.equal(hasOpenTour(parent, [parented]), true);
  assert.equal(hasOpenTour({ id: null, title: 'Mexodus' }, [parent, parented]), true, 'a standalone page for a title whose tour has a parent still finds it through the parent');
  // A closed tour does not block the next one.
  assert.equal(hasOpenTour({ id: null, title: 'The Bodyguard' }, [{ ...standalone, status: 'closed', closingDate: '2026-12-01' }]), false);
  assert.equal(candidateParentId({ parentId: 'a', broadwayShowId: 'b' }), 'a');
  assert.equal(candidateParentId({ broadwayShowId: 'b' }), 'b');
  assert.equal(candidateParentId({ key: 'page:x' }), null);
});

test('a roundup for a Broadway show is not a candidate while a standalone tour of that title runs', () => {
  const { tourCandidateFor } = require('../../scripts/lib/tour-roundup-candidate.js');
  const show = { id: 'foo-2024', title: 'Foo', category: 'broadway' };
  const standalone = { id: 'foo-tour-2026', title: 'Foo', category: 'tour', status: 'open', closingDate: null, tourScheduleSlug: 'foo' };
  const slug = 'Review-Roundup-FOO-Launches-National-Tour-20260915';
  assert.equal(tourCandidateFor(slug, show, [show, standalone]), null);
  assert.deepEqual(tourCandidateFor(slug, show, [show]), { broadwayShowId: 'foo-2024', title: 'Foo' });
});

test('openTourCandidates judges parentless page rows by title, parented rows by their parent, any market (BRO-4931)', () => {
  const { openTourCandidates } = require('../../scripts/lib/tour-roundup-candidate.js');
  const westEnd = { id: 'woman-in-black-west-end-1989', title: 'The Woman in Black', category: 'west-end' };
  const offB = { id: 'mexodus-off-broadway-2026', title: 'Mexodus', category: 'off-broadway' };
  const shows = [westEnd, offB];
  const page = { key: 'page:the-bodyguard', title: 'The Bodyguard', source: 'tourstoyou', pageClass: 'production', type: 'musical', tourScheduleSlug: 'the-bodyguard', segmentStart: '2026-10-15' };
  const unclassified = { key: 'page:clue', title: 'Clue', source: 'tourstoyou', pageClass: 'unclassified', needsClassification: true, tourScheduleSlug: 'clue' };
  const offRow = { key: offB.id, parentId: offB.id, title: 'Mexodus', source: 'tourstoyou', segmentStart: '2026-07-08' };
  const weRow = { key: westEnd.id, parentId: westEnd.id, title: westEnd.title, source: 'tourstoyou', segmentStart: '2026-10-01' };
  const gone = { key: 'x-2020', parentId: 'x-2020', title: 'X', source: 'tourstoyou' };
  const roundupOnly = { key: 'roundup:review-roundup-lumina-national-tour-20261005', source: 'bww-roundup', title: 'Lumina', roundupUrl: 'https://x' };
  const rows = [page, unclassified, offRow, weRow, gone, roundupOnly];
  assert.deepEqual(openTourCandidates(rows, shows).map(r => r.key), ['page:the-bodyguard', 'page:clue', offB.id, westEnd.id],
    'a West End parent is fine for a Tours To You page (a roundup never matches one); a missing parent and a roundup-only row are not suggestions');
  // Once a standalone tour carries the title, the page row is settled.
  const tour = { id: 'the-bodyguard-tour-2026', title: 'The Bodyguard', category: 'tour', status: 'open', closingDate: null, tourScheduleSlug: 'the-bodyguard' };
  assert.deepEqual(openTourCandidates(rows, [...shows, tour]).map(r => r.key), ['page:clue', offB.id, westEnd.id]);
  // A created row is settled whatever its shape.
  assert.equal(openTourCandidates([{ ...page, createdTourId: tour.id }], shows).length, 0);
  // A parentless row that is not from a Tours To You page has no title to stand on.
  assert.equal(openTourCandidates([{ key: 'page:q', title: 'Q' }], shows).length, 0);
});

test('page rows are recorded by key: two standalone pages are two rows, the same page seen again keeps firstSeen and notifiedAt (BRO-4931)', async () => {
  const { recordTourCandidates } = require('../../scripts/lib/tour-roundup-candidate.js');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tour-cand-'));
  try {
    const file = path.join(dir, 'c.json');
    const a = { key: 'page:the-bodyguard', title: 'The Bodyguard', source: 'tourstoyou', slug: 'tourstoyou:the-bodyguard:2026-10-15', tourScheduleSlug: 'the-bodyguard', segmentStart: '2026-10-15' };
    const b = { key: 'page:clue', title: 'Clue', source: 'tourstoyou', slug: 'tourstoyou:clue:2024-02-27', tourScheduleSlug: 'clue', segmentStart: '2024-02-27', needsClassification: true };
    assert.equal(recordTourCandidates(file, [a, b], '2026-10-09T00:00:00Z'), 2);
    let rows = JSON.parse(fs.readFileSync(file, 'utf8'));
    rows.find(r => r.key === 'page:the-bodyguard').notifiedAt = '2026-10-10T00:00:00Z';
    fs.writeFileSync(file, JSON.stringify(rows));
    assert.equal(recordTourCandidates(file, [a], '2026-10-12T00:00:00Z'), 2);
    rows = JSON.parse(fs.readFileSync(file, 'utf8'));
    const row = rows.find(r => r.key === 'page:the-bodyguard');
    assert.deepEqual([row.firstSeen, row.lastSeen, row.notifiedAt], ['2026-10-09T00:00:00Z', '2026-10-12T00:00:00Z', '2026-10-10T00:00:00Z']);
    assert.equal(rows.find(r => r.key === 'page:clue').lastSeen, '2026-10-09T00:00:00Z', 'a row not seen this run is untouched');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('a row the create step classified as an event stops being a suggestion; a stale needsClassification is dropped when the page is read again (BRO-4931)', async () => {
  const { openTourCandidates, recordTourCandidates } = require('../../scripts/lib/tour-roundup-candidate.js');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const base = { title: 'Some Show', source: 'tourstoyou', tourScheduleSlug: 'some-show', segmentStart: '2026-09-01' };
  assert.equal(openTourCandidates([{ ...base, key: 'page:some-show', pageClass: 'event' }], []).length, 0);
  assert.equal(openTourCandidates([{ ...base, key: 'page:some-show', pageClass: 'production' }], []).length, 1);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tour-cand-'));
  try {
    const file = path.join(dir, 'c.json');
    const unclassified = { ...base, key: 'page:some-show', slug: 'tourstoyou:some-show:2026-09-01', pageClass: 'unclassified', needsClassification: true };
    recordTourCandidates(file, [unclassified], '2026-10-01T00:00:00Z');
    // A person classified the page since: the same segment is read again with an override.
    const classified = { ...base, key: 'page:some-show', slug: 'tourstoyou:some-show:2026-09-01', pageClass: 'production', type: 'musical' };
    recordTourCandidates(file, [classified], '2026-10-02T00:00:00Z');
    const [row] = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual([row.pageClass, row.type, row.needsClassification, row.firstSeen], ['production', 'musical', undefined, '2026-10-01T00:00:00Z']);
    // And a tour no longer booked ahead is not left marked upcoming.
    recordTourCandidates(file, [{ ...classified, upcoming: true }], '2026-10-03T00:00:00Z');
    recordTourCandidates(file, [classified], '2026-10-04T00:00:00Z');
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8'))[0].upcoming, undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('P2: standalone pages dedupe by normalised title; the same show on two pages from different starts is ambiguous', () => {
  const { dedupeCandidates } = require('../../scripts/lib/tour-discovery.js');
  const a = { key: 'page:jersey-boys', title: 'Jersey Boys', segmentStart: '2026-09-01', tourScheduleSlug: 'jersey-boys' };
  const b = { key: 'page:jersey-boys-1', title: 'JERSEY BOYS!', segmentStart: '2026-09-01', tourScheduleSlug: 'jersey-boys-1' };
  const same = dedupeCandidates([a, b]);
  assert.deepEqual(same.candidates.map(c => c.key), ['page:jersey-boys'], 'one tour on two pages is one candidate');
  const later = dedupeCandidates([a, { ...b, segmentStart: '2027-02-01' }]);
  assert.equal(later.candidates.length, 1);
  assert.ok(later.candidates[0].ambiguous);
  assert.equal(dedupeCandidates([a, { key: 'page:other', title: 'Other Show', segmentStart: '2026-09-01' }]).candidates.length, 2);
});

test('P2: sortForCreate puts parented tours first and unclassified standalone pages last, keeping order within a group', () => {
  const { sortForCreate } = require('../../scripts/lib/tour-roundup-candidate.js');
  const rows = [
    { key: 'page:b', needsClassification: true }, { key: 'page:a' }, { key: 'x-2020', parentId: 'x-2020' },
    { key: 'page:c', needsClassification: true }, { broadwayShowId: 'y-2021', key: 'y-2021' }, { key: 'page:d' },
  ];
  assert.deepEqual(sortForCreate(rows).map(r => r.key), ['x-2020', 'y-2021', 'page:a', 'page:d', 'page:b', 'page:c']);
  assert.equal(rows[0].key, 'page:b', 'the input is not reordered');
});

test('P2: a row keeps the class the create step gave it while the same segment is rediscovered as unclassified', async () => {
  const { recordTourCandidates, openTourCandidates } = require('../../scripts/lib/tour-roundup-candidate.js');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tour-cand-'));
  try {
    const file = path.join(dir, 'c.json');
    const read = () => JSON.parse(fs.readFileSync(file, 'utf8'));
    const base = { key: 'page:some-show', title: 'Some Show', source: 'tourstoyou', slug: 'tourstoyou:some-show:2026-09-01', tourScheduleSlug: 'some-show', segmentStart: '2026-09-01' };
    const discovered = { ...base, pageClass: 'unclassified', needsClassification: true };
    recordTourCandidates(file, [discovered], '2026-10-01T00:00:00Z');
    // The create step reads Wikipedia: a stage musical.
    const rows = read();
    Object.assign(rows[0], { pageClass: 'production', type: 'musical' });
    delete rows[0].needsClassification;
    fs.writeFileSync(file, JSON.stringify(rows));
    // Next day discovery, with no Wikipedia, calls it unclassified again: the answer stays.
    recordTourCandidates(file, [discovered], '2026-10-02T00:00:00Z');
    let [row] = read();
    assert.deepEqual([row.pageClass, row.type, row.needsClassification, row.firstSeen], ['production', 'musical', undefined, '2026-10-01T00:00:00Z']);
    // An event answer stays too, so the row does not reopen daily.
    const events = read();
    events[0].pageClass = 'event';
    delete events[0].type;
    fs.writeFileSync(file, JSON.stringify(events));
    recordTourCandidates(file, [discovered], '2026-10-03T00:00:00Z');
    [row] = read();
    assert.equal(row.pageClass, 'event');
    assert.equal(openTourCandidates([row], []).length, 0);
    // A different segment is a different tour and starts again.
    recordTourCandidates(file, [{ ...discovered, slug: 'tourstoyou:some-show:2027-03-01', segmentStart: '2027-03-01' }], '2026-10-04T00:00:00Z');
    [row] = read();
    assert.deepEqual([row.pageClass, row.needsClassification], ['unclassified', true]);
    // A classifier answer (an override since) beats the earlier one.
    recordTourCandidates(file, [{ ...base, slug: 'tourstoyou:some-show:2027-03-01', segmentStart: '2027-03-01', pageClass: 'production', type: 'play' }], '2026-10-05T00:00:00Z');
    [row] = read();
    assert.deepEqual([row.pageClass, row.type, row.needsClassification], ['production', 'play', undefined]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('a standalone tour is already tracked despite apostrophe style or title drift (BRO-4931)', () => {
  const { openTourCandidates } = require('../../scripts/lib/tour-roundup-candidate.js');
  const shows = [
    { id: 'dolly-partons-smoky-mountain-christmas-carol-tour-2026', title: 'Dolly Parton\u2019s Smoky Mountain Christmas Carol', category: 'tour', status: 'upcoming', tourScheduleSlug: 'dolly-partons-smoky-mountain-christmas-carol' },
    { id: 'dr-seuss-the-cat-in-the-hat-tour-2027', title: 'Dr. Seuss\u2019 The Cat in the Hat', category: 'tour', status: 'upcoming', tourScheduleSlug: 'the-cat-in-the-hat' },
    { id: 'clue-tour-2025', title: 'Clue', category: 'tour', status: 'open', tourScheduleSlug: 'clue' },
  ];
  const rows = [
    // straight vs curly apostrophe
    { key: 'page:dolly-partons-smoky-mountain-christmas-carol', source: 'tourstoyou', title: "Dolly Parton's Smoky Mountain Christmas Carol", tourScheduleSlug: 'dolly-partons-smoky-mountain-christmas-carol' },
    // title differs but the schedule page is the same tour
    { key: 'page:the-cat-in-the-hat', source: 'tourstoyou', title: 'The Cat in the Hat', tourScheduleSlug: 'the-cat-in-the-hat' },
    // a different page that merely shares nothing is still a candidate
    { key: 'page:potted-potter', source: 'tourstoyou', title: 'Potted Potter', tourScheduleSlug: 'potted-potter' },
  ];
  assert.deepEqual(openTourCandidates(rows, shows).map(r => r.key), ['page:potted-potter']);
});
