// BRO-6588: a review file for a pre-opening news/feature page on a review
// outlet is refused at the writer chokepoint, on create and on a merge that
// would swap a stub's url for the news page; the opening-night review writes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createOrMergeReviewFile } = require('./review-file-writer.js');

const SHOW = 'a-few-good-men-2026'; // opens 2026-10-29 in data/shows.json
const write = (dir, url, publishDate, source = 'serp-discovery', extra = {}) => createOrMergeReviewFile(SHOW, {
  outletId: 'ew', outlet: 'Entertainment Weekly', criticName: 'Unknown', url, source,
  fields: { publishDate, ...extra },
}, { reviewTextsDir: dir });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'preopen-guard-'));
const withDir = (fn) => { const dir = tmp(); try { fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); } };
const NEWS = 'https://ew.com/a-few-good-men-broadway-first-look-photos-11823456';

test('refuses a NEW pre-opening EW first-look page', () => withDir((dir) => {
  const r = write(dir, NEWS, '2026-10-08');
  assert.equal(r.guardRefused, true);
  assert.equal(r.reason, 'pre-opening-non-review');
  assert.equal(fs.existsSync(path.join(dir, SHOW)), false, 'nothing written');
}));

test('writes the opening-night review', () => withDir((dir) => {
  const r = write(dir, 'https://ew.com/a-few-good-men-broadway-review-11830000', '2026-10-29');
  assert.equal(r.action, 'new');
}));

test('allowNonReviewUrl and a roundup score are exempt', () => {
  withDir((dir) => assert.equal(write(dir, NEWS, '2026-10-08', 'serp-discovery', { allowNonReviewUrl: true }).action, 'new'));
  withDir((dir) => assert.equal(write(dir, NEWS, '2026-10-08', 'bww-roundup', { originalScore: 'B+' }).action, 'new'));
});

test('refuses a merge that would swap a stub url for the news page', () => withDir((dir) => {
  const review = 'https://ew.com/a-few-good-men-broadway-review-11830000';
  assert.equal(write(dir, review, '2026-10-29').action, 'new');
  const r = write(dir, NEWS, '2026-10-08');
  assert.equal(r.reason, 'pre-opening-non-review');
  const files = fs.readdirSync(path.join(dir, SHOW)).filter(f => f.endsWith('.json'));
  const kept = files.map(f => JSON.parse(fs.readFileSync(path.join(dir, SHOW, f), 'utf8')).url);
  assert.deepEqual(kept, [review]);
}));
