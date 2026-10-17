// TESTS-VS-DERIVED-DATA-EXEMPT: live-corpus venue-complex checks, run by
// check-corpus-drift.yml (data-health), not test.yml's code-CI unit batch.
/**
 * Live data/shows.json venue-complex checks, moved out of
 * scripts/audit-venue-complex-slugs.test.mjs on 2026-09-30 (BRO-3425): shows
 * are added and retired by bots many times a day, so these turned main's Test
 * Suite red with no code change (09-29: orphans after S8-T2 retirements; 09-30:
 * the candidate-gap heuristic matched a Roundabout black box to Signature's
 * Jewel Box on the shared word "box"). Orphans are still gated at data-write
 * time by validate-data.js.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { findCandidateGaps, findOrphanSubVenueSlugs, slugify, normalizeVenueName, VENUE_COMPLEX_MARKETS } =
  require('../../scripts/lib/venue-complex-audit.js');

const showsData = require('../../data/shows.json');
const complexDefs = require('../../data/venue-complexes.json').complexes;

const isOffBroadway = (show) => show.category === 'off-broadway';

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
const westEndComplexDefs = require('../../data/venue-complexes-west-end.json').complexes;

test('every West End venue-complex subVenueSlugs entry resolves to a real shows.json venue', () => {
  const orphans = findOrphanSubVenueSlugs(showsData.shows, westEndComplexDefs, isLondonShow);
  assert.deepEqual(orphans, {}, `orphaned subVenueSlugs (typo or venue no longer in corpus): ${JSON.stringify(orphans)}`);
});

test('every registered market is orphan-free — covers a third market with no new test', () => {
  // Count the iterations and assert the count. A bare `for (... of REGISTRY)`
  // with assertions only INSIDE the loop passes trivially when the registry is
  // empty — the vacuity shape a reviewer's mutation pass found here. Empty the
  // registry and this fails on the count, not silently on nothing.
  let checked = 0;
  for (const market of VENUE_COMPLEX_MARKETS) {
    const defs = require(`../../${market.defsFile}`).complexes;
    assert.ok(defs && Object.keys(defs).length > 0, `${market.defsFile} has no complexes to check`);
    const orphans = findOrphanSubVenueSlugs(showsData.shows, defs, market.matches);
    assert.deepEqual(orphans, {}, `${market.defsFile}: orphaned subVenueSlugs ${JSON.stringify(orphans)}`);
    checked++;
  }
  assert.equal(checked, VENUE_COMPLEX_MARKETS.length);
  assert.ok(checked >= 2, `expected at least the two known markets to be checked, checked ${checked}`);
});

test('an emptied subVenueSlugs array is legitimate when the complex slug is itself a venue', () => {
  // Pins the shape of the actual 2026-09-05 fix so nobody "restores" the slug.
  // new-world-stages carries subVenueSlugs: [] and that is CORRECT: four shows
  // use the venue string "New World Stages" verbatim, so data-core.ts's
  // buildComplexIndex renders the complex from ownTheater and still groups all
  // four. An empty array is therefore never on its own evidence of a problem —
  // which is why no "dead complex" check ships here (see the note in
  // venue-complex-audit.js: data-core.ts:885 emits zero-show complexes by design).
  const def = complexDefs['new-world-stages'];
  assert.ok(def, 'new-world-stages complex must still exist');
  assert.deepEqual(def.subVenueSlugs, [], 'new-world-stages.subVenueSlugs must stay empty — the Stage 5 slug was orphaned by a core-data merge');
  const nwsShows = showsData.shows.filter(s => isOffBroadway(s) && slugify(normalizeVenueName(s.venue || '')) === 'new-world-stages');
  assert.ok(nwsShows.length > 0, 'the complex now depends entirely on ownTheater, so at least one show must use the bare "New World Stages" venue string');
});
