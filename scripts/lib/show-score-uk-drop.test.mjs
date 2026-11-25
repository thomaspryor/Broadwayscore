import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { dropUkShowScoreRating } = require('./show-score-uk-drop');

const mk = () => ({ sources: { mezzanine: { score: 78, reviewCount: 25 }, showScore: { score: 85, reviewCount: 40 } }, combinedScore: 82.31, designation: 'Liking' });

test('removes the stored rating when it equals the UK page rating, recomputes the combined score', () => {
  const rec = mk();
  const r = dropUkShowScoreRating(rec, { score: 85, count: 40 }, { status: 'closed', category: 'broadway' });
  assert.equal(r.removed, true);
  assert.equal(rec.sources.showScore, undefined);
  assert.equal(rec.combinedScore, r.combinedScore);
  assert.notEqual(rec.combinedScore, 82.31);
});
test('keeps a rating scraped earlier from the right page', () => {
  const rec = mk();
  assert.equal(dropUkShowScoreRating(rec, { score: 92, count: 351 }, {}).removed, false);
  assert.deepEqual(rec.sources.showScore, { score: 85, reviewCount: 40 });
});
test('no record, no showScore, or no page rating is a no-op', () => {
  assert.equal(dropUkShowScoreRating(undefined, { score: 85, count: 40 }).removed, false);
  assert.equal(dropUkShowScoreRating({ sources: {} }, { score: 85, count: 40 }).removed, false);
  assert.equal(dropUkShowScoreRating(mk(), null).removed, false);
});

// Wiring guard (BRO-7434): the shard scraper hands the UK-page finding to the merge, and the merge applies it.
import fs from 'node:fs';
import path from 'node:path';
const scripts = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
test('shard scraper records ukPage and merge-show-score-shards applies it through dropUkShowScoreRating', () => {
  const scraper = fs.readFileSync(path.join(scripts, 'scrape-show-score-audience.js'), 'utf8');
  const merge = fs.readFileSync(path.join(scripts, 'merge-show-score-shards.js'), 'utf8');
  assert.match(scraper, /shardOutput\.ukPage\[show\.id\]\s*=/);
  assert.match(merge, /data\.ukPage/);
  assert.match(merge, /dropUkShowScoreRating\(/);
});
