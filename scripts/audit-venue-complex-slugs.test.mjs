// Regression guard for the off-Broadway venue-complexes.json audit (task #1475),
// cousin of the West End National Theatre bare-form-slug bug fixed in e0a63053ec6.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { findCandidateGaps, findOrphanSubVenueSlugs, slugify, normalizeVenueName } =
  require('./lib/venue-complex-audit.js');

const showsData = require('../data/shows.json');
const complexDefs = require('../data/venue-complexes.json').complexes;

const isOffBroadway = (show) => show.category === 'off-broadway';

test('slugify/normalizeVenueName match the site helpers exactly (data-core.ts:593,758)', () => {
  assert.equal(slugify("Joe's Pub"), 'joe-s-pub');
  assert.equal(slugify('Delacorte Theater'), 'delacorte-theater');
  assert.equal(normalizeVenueName('  Greenwich House Theater  '), 'Greenwich House Theater');
  assert.equal(normalizeVenueName('New  World   Stages'), 'New World Stages');
});

test('every off-Broadway venue-complex subVenueSlugs entry resolves to a real shows.json venue', () => {
  const orphans = findOrphanSubVenueSlugs(showsData.shows, complexDefs, isOffBroadway);
  assert.deepEqual(orphans, {}, `orphaned subVenueSlugs (typo or venue no longer in corpus): ${JSON.stringify(orphans)}`);
});

test('no off-Broadway venue-complex has an unlinked bare-form/keyword-overlap sub-venue slug', () => {
  const candidates = findCandidateGaps(showsData.shows, complexDefs, isOffBroadway);
  assert.deepEqual(
    candidates,
    {},
    `unlinked candidate sub-venue slugs found (same class as the West End National Theatre bug): ${JSON.stringify(candidates, null, 2)}`
  );
});

test('the-public-theater complex covers Joe\'s Pub and bare Delacorte Theater (task #1475 fix)', () => {
  const def = complexDefs['the-public-theater'];
  for (const slug of ['delacorte-theater', 'joe-s-pub', 'joe-s-pub-at-the-public-theatre']) {
    assert.ok(def.subVenueSlugs.includes(slug), `expected the-public-theater.subVenueSlugs to include "${slug}"`);
  }
});

test('lincoln-center-theater complex covers Claire Tow Theater / LCT3 (task #1475 fix)', () => {
  const def = complexDefs['lincoln-center-theater'];
  for (const slug of ['claire-tow-theater', 'lct3-at-the-claire-tow-theater']) {
    assert.ok(def.subVenueSlugs.includes(slug), `expected lincoln-center-theater.subVenueSlugs to include "${slug}"`);
  }
});

// West End orphan check (/what-else follow-up to task #1475 — the file that
// originated this bug class had no regression guard at all). getAllLondonTheaters()
// sources from BOTH 'west-end' and 'off-west-end' categories (data-core.ts
// getAllLondonShows), not 'west-end' alone — using the narrower filter here
// would falsely flag every West End complex's subVenueSlugs as orphaned.
//
// Only the orphan check runs here, not findCandidateGaps: a first pass over
// London venue strings surfaced heavy false-positive noise (e.g. "Old Vic" vs
// "Young Vic", "Theatre Royal Haymarket" vs "Royal Court" — distinct real
// venues that share a word) because GENERIC_TOKENS in venue-complex-audit.js
// was tuned against the off-Broadway corpus's noise words (hall/house/space/
// stage), not London's (royal/east/vic). Porting the candidate-gap check to
// this market needs its own tuning pass, not a blind reuse — tracked as a
// separate roadmap item rather than shipped half-verified here.
const isLondonShow = (show) => show.category === 'west-end' || show.category === 'off-west-end';
const westEndComplexDefs = require('../data/venue-complexes-west-end.json').complexes;

test('every West End venue-complex subVenueSlugs entry resolves to a real shows.json venue', () => {
  const orphans = findOrphanSubVenueSlugs(showsData.shows, westEndComplexDefs, isLondonShow);
  assert.deepEqual(orphans, {}, `orphaned subVenueSlugs (typo or venue no longer in corpus): ${JSON.stringify(orphans)}`);
});
