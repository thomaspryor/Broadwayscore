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
