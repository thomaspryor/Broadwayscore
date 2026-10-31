/**
 * BRO-2619: merge-aggregator-excerpts.js findMatchingReviewFile() used to
 * return the first readdir file at the same outlet when either critic name
 * was missing, so an excerpt could be merged into the wrong critic's review.
 * It must return null unless exactly one file matches.
 * Per CLAUDE.md §15: require() the real function.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { findMatchingReviewFile } = require('./merge-aggregator-excerpts.js');

function showDir(t, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mae-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [name, data] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), JSON.stringify(data));
  return dir;
}

const TWO_NYT = {
  'nytimes--ben-brantley.json': { outletId: 'nytimes', criticName: 'Ben Brantley' },
  'nytimes--jesse-green.json': { outletId: 'nytimes', criticName: 'Jesse Green' },
};

test('excerpt with no critic name at a two-critic outlet matches nothing', (t) => {
  const dir = showDir(t, TWO_NYT);
  assert.equal(findMatchingReviewFile(dir, { outletId: 'nytimes', criticName: '' }), null);
});

test('excerpt with a critic name matches that critic, not the first file', (t) => {
  const dir = showDir(t, TWO_NYT);
  const m = findMatchingReviewFile(dir, { outletId: 'nytimes', criticName: 'Jesse Green' });
  assert.equal(path.basename(m.filePath), 'nytimes--jesse-green.json');
});

test('single file at the outlet with no critic still matches', (t) => {
  const dir = showDir(t, { 'nytimes--unknown.json': { outletId: 'nytimes' } });
  const m = findMatchingReviewFile(dir, { outletId: 'nytimes', criticName: 'Jesse Green' });
  assert.equal(path.basename(m.filePath), 'nytimes--unknown.json');
});
