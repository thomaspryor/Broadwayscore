/**
 * BRO-2023: discover-new-shows.js's title cross-reference detected a revival
 * whenever a new show's title matched ANY existing shows.json entry,
 * regardless of market — a same-title West End production transferring to
 * Broadway (Inter Alia 2026) got flagged isRevival:true solely because the
 * West End entry already existed. Fixed 2026-08-14 by requiring a
 * same-market match; this test locks that fix against regression using the
 * REAL function (extracted here from discover-new-shows.js so it's testable
 * in isolation, CLAUDE.md §15) rather than a re-implementation.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  normalizeTitle, buildExistingTitleMap, detectRevivalByTitleCrossReference,
} = require('../../scripts/lib/revival-cross-reference.js');

test('normalizeTitle strips leading article + punctuation, case-folds', () => {
  assert.equal(normalizeTitle('The Seagull'), 'seagull');
  assert.equal(normalizeTitle("Schmigadoon!"), 'schmigadoon');
});

test('buildExistingTitleMap skips very short titles', () => {
  const map = buildExistingTitleMap([{ title: 'Art', id: 'art-1998', type: 'play', category: null }]);
  assert.equal(map.size, 0);
});

test('a same-title WE->BW transfer does NOT set isRevival (Inter Alia)', () => {
  const existing = [
    { title: 'Inter Alia', id: 'inter-alia-london-2025', type: 'play', category: 'west-end' },
  ];
  const map = buildExistingTitleMap(existing);
  const newShow = { title: 'Inter Alia', id: 'inter-alia-broadway-2026', category: 'broadway' };
  const result = detectRevivalByTitleCrossReference(newShow, map);
  assert.equal(result.isRevival, false);
  assert.equal(result.isTransfer, true);
});

test('a same-title, same-market match IS a revival (same-market evidence)', () => {
  const existing = [
    { title: 'Chicago', id: 'chicago-1996', type: 'musical', category: null }, // legacy Broadway = null category
  ];
  const map = buildExistingTitleMap(existing);
  const newShow = { title: 'Chicago', id: 'chicago-2030', category: 'broadway' };
  const result = detectRevivalByTitleCrossReference(newShow, map);
  assert.equal(result.isRevival, true);
  assert.equal(result.confidence, 'high');
  assert.equal(result.detectedType, 'musical');
});

test('legacy null-category Broadway entry vs explicit "broadway" string still matches as same-market', () => {
  // isBroadwayCategory folds absent/null/'broadway' together — a match against
  // a legacy null-category entry must not be misread as cross-market (2026-08-14 review).
  const existing = [{ title: 'Gutenberg! The Musical', id: 'gutenberg-2023', type: 'musical', category: null }];
  const map = buildExistingTitleMap(existing);
  const newShow = { title: 'Gutenberg! The Musical', id: 'gutenberg-2030', category: 'broadway' };
  const result = detectRevivalByTitleCrossReference(newShow, map);
  assert.equal(result.isRevival, true);
  assert.equal(result.isTransfer, false);
});

test('no match at all → neither revival nor transfer', () => {
  const map = buildExistingTitleMap([{ title: 'Some Other Show', id: 'x-2020', type: 'play', category: 'broadway' }]);
  const newShow = { title: 'A Brand New Play', id: 'y-2026', category: 'broadway' };
  const result = detectRevivalByTitleCrossReference(newShow, map);
  assert.equal(result.isRevival, false);
  assert.equal(result.isTransfer, false);
  assert.equal(result.match, null);
});

test('a same-market prior production is found even when a cross-market entry has the same title (ship-check finding)', () => {
  // buildExistingTitleMap used to keep only the FIRST same-titled entry — if
  // that first one happened to be cross-market, a real same-market prior
  // production later in the list was shadowed and misread as a transfer.
  const existing = [
    { title: 'Network', id: 'network-london-2017', type: 'play', category: 'west-end' }, // seen first
    { title: 'Network', id: 'network-1958', type: 'play', category: null }, // real Broadway prior production
  ];
  const map = buildExistingTitleMap(existing);
  const newShow = { title: 'Network', id: 'network-2030', category: 'broadway' };
  const result = detectRevivalByTitleCrossReference(newShow, map);
  assert.equal(result.isRevival, true);
  assert.equal(result.isTransfer, false);
  assert.equal(result.match.id, 'network-1958');
});

test('matching against itself (same id already in the map) is not a match', () => {
  const existing = [{ title: 'Gloria', id: 'gloria-2026', type: 'play', category: 'broadway' }];
  const map = buildExistingTitleMap(existing);
  const result = detectRevivalByTitleCrossReference({ title: 'Gloria', id: 'gloria-2026', category: 'broadway' }, map);
  assert.equal(result.isRevival, false);
  assert.equal(result.isTransfer, false);
});

// --- Wiring lock: discover-new-shows.js must call the real function ---
test('discover-new-shows.js calls the extracted cross-reference detector', () => {
  const src = require('fs').readFileSync(
    require('path').join(import.meta.dirname, '..', '..', 'scripts/discover-new-shows.js'), 'utf8');
  assert.match(src, /require\(['"]\.\/lib\/revival-cross-reference['"]\)/);
  assert.match(src, /detectRevivalByTitleCrossReference\(show, existingTitleMap\)/);
});
