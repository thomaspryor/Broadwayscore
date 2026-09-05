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

// ---------------------------------------------------------------------------
// The market registry, and the two guards that stop this audit from turning a
// cosmetic finding into a hard failure.
//
// Context: on 2026-09-05 a core-data commit deleted the only show at venue
// "New World Stages – Stage 5", orphaning the new-world-stages-stage-5 slug.
// Nothing failed at the data change; main went red 4h42m later on an unrelated
// push (Test Suite runs 33980744001 and 33981854174) where the failure looked
// like it belonged to whoever pushed. scripts/validate-data.js now runs the same
// pure functions at the moment the data changes, which is why they need to be
// robust against a malformed def instead of throwing.
// ---------------------------------------------------------------------------

const { findMalformedComplexDefs, VENUE_COMPLEX_MARKETS } =
  require('./lib/venue-complex-audit.js');

test('VENUE_COMPLEX_MARKETS is the audit-side market/defs-file pairing', () => {
  // Anti-drift: this test file and scripts/validate-data.js both consume the
  // registry, so adding a market to the AUDIT is one edit. It is deliberately
  // not a claim about the site — src/lib/data-core.ts keeps its own membership
  // predicates and JSON imports, and a third market needs edits there too.
  assert.deepEqual(
    VENUE_COMPLEX_MARKETS.map(m => m.defsFile),
    ['data/venue-complexes.json', 'data/venue-complexes-west-end.json']
  );
  const [ob, london] = VENUE_COMPLEX_MARKETS;
  assert.equal(ob.matches({ category: 'off-broadway' }), true);
  assert.equal(ob.matches({ category: 'west-end' }), false);
  assert.equal(london.matches({ category: 'west-end' }), true);
  assert.equal(london.matches({ category: 'off-west-end' }), true);
  assert.equal(london.matches({ category: 'off-broadway' }), false);
});

test('every registered market is orphan-free — covers a third market with no new test', () => {
  // Count the iterations and assert the count. A bare `for (... of REGISTRY)`
  // with assertions only INSIDE the loop passes trivially when the registry is
  // empty — the vacuity shape a reviewer's mutation pass found here. Empty the
  // registry and this fails on the count, not silently on nothing.
  let checked = 0;
  for (const market of VENUE_COMPLEX_MARKETS) {
    const defs = require(`../${market.defsFile}`).complexes;
    assert.ok(defs && Object.keys(defs).length > 0, `${market.defsFile} has no complexes to check`);
    const orphans = findOrphanSubVenueSlugs(showsData.shows, defs, market.matches);
    assert.deepEqual(orphans, {}, `${market.defsFile}: orphaned subVenueSlugs ${JSON.stringify(orphans)}`);
    checked++;
  }
  assert.equal(checked, VENUE_COMPLEX_MARKETS.length);
  assert.ok(checked >= 2, `expected at least the two known markets to be checked, checked ${checked}`);
});

test('findOrphanSubVenueSlugs tolerates a def with no subVenueSlugs key instead of throwing', () => {
  // Regression guard: the unguarded `def.subVenueSlugs.filter(...)` threw a
  // TypeError here, and validate-data.js:85-91 converts any throw into a
  // push-refusal sentinel — so one missing JSON key hard-blocked every automated
  // core-data push with a stack trace. Revert the Array.isArray guard in
  // venue-complex-audit.js and this test throws.
  const shows = [{ category: 'off-broadway', venue: 'Real Venue' }];
  const defs = { broken: { name: 'Broken' }, fine: { name: 'Fine', subVenueSlugs: ['real-venue'] } };
  const orphans = findOrphanSubVenueSlugs(shows, defs, isOffBroadway);
  assert.deepEqual(orphans, {}, 'a def missing subVenueSlugs must be skipped, not throw, and not be reported as an orphan');
});

test('findMalformedComplexDefs names every def whose subVenueSlugs is not an array', () => {
  const defs = {
    missing: { name: 'Missing' },
    stringy: { name: 'Stringy', subVenueSlugs: 'a-slug' },
    nulled: null,
    fine: { name: 'Fine', subVenueSlugs: [] },
  };
  assert.deepEqual(findMalformedComplexDefs(defs), {
    missing: 'missing',
    stringy: 'string',
    nulled: 'null',
  });
});

test('the live venue-complex files have a usable top-level complexes object and no malformed defs', () => {
  let checked = 0;
  for (const market of VENUE_COMPLEX_MARKETS) {
    const parsed = require(`../${market.defsFile}`);
    const defs = parsed && parsed.complexes;
    // The top-level shape, not just the per-def shape. With `complexes` renamed,
    // absent or a top-level array, every per-def check below passes clean while
    // src/lib/data-core.ts reads undefined and the site build breaks.
    assert.ok(defs && typeof defs === 'object' && !Array.isArray(defs), `${market.defsFile} has no usable top-level "complexes" object`);
    assert.deepEqual(findMalformedComplexDefs(defs), {}, `${market.defsFile} has a def whose subVenueSlugs is not an array`);
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
