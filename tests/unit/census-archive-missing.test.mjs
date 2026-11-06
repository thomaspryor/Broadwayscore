import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { publishedRoundupWithoutArchive } = require('../../scripts/lib/review-census.js');
const RU = 'https://www.broadwayworld.com/article/Review-Roundup-THE-UNBELIEVERS-Opens-Off-Broadway-20261105';

test('published roundup URL on a review file with no archived bww-roundup is a missing census (BRO-7050)', () => {
  const r = publishedRoundupWithoutArchive([{ bwwRoundupUrl: null }, { bwwRoundupUrl: RU }], []);
  assert.deepEqual(r, { missing: true, url: RU });
});
test('archived bww-roundup present: not missing', () => {
  assert.equal(publishedRoundupWithoutArchive([{ bwwRoundupUrl: RU }], ['bww-roundup']).missing, false);
});
test('no roundup URL on any file: still no-census-yet, not a gap', () => {
  assert.equal(publishedRoundupWithoutArchive([{ bwwRoundupUrl: null }, {}], []).missing, false);
});
test('roundup URL for a different show (cross-show misroute) is not a gap', () => {
  assert.equal(publishedRoundupWithoutArchive([{ bwwRoundupUrl: RU }], [], 'Hamilton').missing, false);
  assert.equal(publishedRoundupWithoutArchive([{ bwwRoundupUrl: RU }], [], 'The Unbelievers').missing, true);
});
test('audit wires the helper into the gap condition', async () => {
  const fs = require('node:fs');
  const src = fs.readFileSync(new URL('../../scripts/audit-opening-night-coverage.js', import.meta.url), 'utf8');
  assert.match(src, /publishedRoundupWithoutArchive/);
  assert.match(src, /censusMissing\.length > 0 \|\| censusExtractorBroken \|\| archiveMissingUrl/);
});
