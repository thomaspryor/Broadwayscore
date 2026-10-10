// Regression guard for the off-Broadway venue-complexes.json audit (task #1475),
// cousin of the West End National Theatre bare-form-slug bug fixed in e0a63053ec6.
//
// 2026-09-30 (BRO-3425): every test that reads data/shows.json moved to
// tests/unit/venue-complex-live-data.test.mjs, run by check-corpus-drift.yml.
// Bots add and retire shows many times a day, so a live-corpus finding (a new
// venue sharing the word "box" with Signature's Jewel Box; an orphan left by a
// retired show) turned main's code CI red with no code change. What stays here
// checks the pure functions and the hand-edited venue-complex files only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { findOrphanSubVenueSlugs, findCandidateGaps, slugify, normalizeVenueName } =
  require('./lib/venue-complex-audit.js');

const complexDefs = require('../data/venue-complexes.json').complexes;

const isOffBroadway = (show) => show.category === 'off-broadway';

test('slugify/normalizeVenueName match the site helpers exactly (data-core.ts:593,758)', () => {
  assert.equal(slugify("Joe's Pub"), 'joe-s-pub');
  assert.equal(slugify('Delacorte Theater'), 'delacorte-theater');
  assert.equal(normalizeVenueName('  Greenwich House Theater  '), 'Greenwich House Theater');
  assert.equal(normalizeVenueName('New  World   Stages'), 'New World Stages');
});

// 2026-09-29 (BRO-4204 S8-T2): the long spelling "Joe's Pub at The Public
// Theatre" left the corpus when its only rows (four TodayTix concert/cabaret
// listings) were retired as non-shows, so its slug was dropped from the map —
// the orphan check above is what guards that. The bare spelling still has a
// live row and stays pinned here.
test('the-public-theater complex covers Joe\'s Pub and bare Delacorte Theater (task #1475 fix)', () => {
  const def = complexDefs['the-public-theater'];
  for (const slug of ['delacorte-theater', 'joe-s-pub']) {
    assert.ok(def.subVenueSlugs.includes(slug), `expected the-public-theater.subVenueSlugs to include "${slug}"`);
  }
});

test('lincoln-center-theater complex covers Claire Tow Theater / LCT3 (task #1475 fix)', () => {
  const def = complexDefs['lincoln-center-theater'];
  for (const slug of ['claire-tow-theater', 'lct3-at-the-claire-tow-theater']) {
    assert.ok(def.subVenueSlugs.includes(slug), `expected lincoln-center-theater.subVenueSlugs to include "${slug}"`);
  }
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


// BRO-447: "players" alone is a troupe-name word. Gallery Players (Brooklyn) is
// not a sub-venue of The Players Theatre (Greenwich Village). Synthetic rows,
// so this does not depend on the live corpus.
test('findCandidateGaps does not link unrelated venues on the shared word "players"', () => {
  const shows = [
    { venue: 'The Players Theatre', category: 'off-broadway' },
    { venue: 'The Steve & Marie Sgouros Theatre (The Players Theatre Loft)', category: 'off-broadway' },
    { venue: 'Gallery Players', category: 'off-broadway' },
  ];
  const defs = {
    'the-players-theatre': {
      name: 'The Players Theatre',
      subVenueSlugs: ['the-steve-marie-sgouros-theatre-the-players-theatre-loft'],
    },
  };
  assert.deepEqual(findCandidateGaps(shows, defs, isOffBroadway), {});
});

test('findCandidateGaps still flags a real distinguishing-token gap', () => {
  const shows = [
    { venue: 'Sgouros Hall East', category: 'off-broadway' },
    { venue: 'The Steve & Marie Sgouros Theatre (The Players Theatre Loft)', category: 'off-broadway' },
  ];
  const defs = {
    'the-players-theatre': {
      name: 'The Players Theatre',
      subVenueSlugs: ['the-steve-marie-sgouros-theatre-the-players-theatre-loft'],
    },
  };
  assert.deepEqual(Object.keys(findCandidateGaps(shows, defs, isOffBroadway)), ['the-players-theatre']);
});
