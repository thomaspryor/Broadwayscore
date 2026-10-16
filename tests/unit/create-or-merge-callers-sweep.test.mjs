/**
 * BRO-3791: sweep guard for createOrMergeReviewFile callers.
 *
 * The writer's merge path only fills BLANK fields, so a caller that reports
 * action === 'updated' as success can hide a stale url/body (BRO-3790). The
 * single-URL and operator tools verify post-write via stale-merge-check.js.
 * The bulk scrapers below do not: they print per-batch counts, nobody reads a
 * per-URL line, and each already runs content-quality gates downstream. A NEW
 * caller that treats 'updated' as success must either verify or be added to
 * BULK_BATCH_CALLERS here with that decision made on purpose.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts');

const VERIFYING_CALLERS = ['ingest-manual-review.js', 'ingest-review-from-url.js', 'ingest-urls.js'];

const BULK_BATCH_CALLERS = new Set([
  // Poll/discover callers count any non-skipped action as success (no 'updated' literal).
  'poll-loureviews.js',
  'discover-opening-night-reviews.js',
  'convert-show-score-to-review-texts.js',
  'outlet-listing-poller.js',
  're-extract-aggregator-reviews.js',
  'scrape-bww-reviews.js',
  'scrape-dtli.js',
  'scrape-london-box-office-roundups.js',
  'scrape-nyc-theatre-roundups.js',
  'scrape-nysr-reviews.js',
  'scrape-playbill-verdict.js',
  'scrape-theatre-reviews.js',
  'scrape-thestage-roundups.js',
  'scrape-westendtheatre-roundups.js',
  'scrape-wp-theater-blogs.js',
]);

// Callers that only act on action === 'new' never report a merge as success.
const NEW_ONLY_CALLERS = new Set([
  'collect-outlet-reviews.js',
  'collect-west-end-reviews.js',
  'create-stubs-from-reviews-json.js',
]);

const isCallLine = (l) => /createOrMergeReviewFile\(/.test(l) && !/^\s*(\/\/|\*)/.test(l);
const callers = fs.readdirSync(scriptsDir)
  .filter((f) => f.endsWith('.js'))
  .map((f) => ({ f, src: fs.readFileSync(path.join(scriptsDir, f), 'utf8') }))
  .filter(({ src }) => src.split('\n').some(isCallLine) && !/dead code/.test(src.slice(0, 400)));

test('sweep finds the known callers', () => {
  assert.ok(callers.length >= 15, `only ${callers.length} callers found`);
});

test('verifying callers use the shared stale-merge helpers', () => {
  for (const f of VERIFYING_CALLERS) {
    const src = fs.readFileSync(path.join(scriptsDir, f), 'utf8');
    assert.match(src, /findStale(MergeFields|FieldsAfterUpdate)/, `${f} lost its post-write stale-merge check`);
  }
});

test('every caller verifies, or is a declared bulk or new-only caller', () => {
  const undecided = callers
    .filter(({ f }) => !VERIFYING_CALLERS.includes(f) && !BULK_BATCH_CALLERS.has(f) && !NEW_ONLY_CALLERS.has(f))
    .map(({ f }) => f);
  assert.deepEqual(undecided, [], `add post-write verification (scripts/lib/stale-merge-check.js) or list in BULK_BATCH_CALLERS / NEW_ONLY_CALLERS: ${undecided.join(', ')}`);
});

test('declared bulk callers still exist and still call the writer', () => {
  const names = new Set(callers.map(({ f }) => f));
  const gone = [...BULK_BATCH_CALLERS, ...NEW_ONLY_CALLERS].filter((f) => !names.has(f));
  assert.deepEqual(gone, [], `stale BULK_BATCH_CALLERS / NEW_ONLY_CALLERS entries: ${gone.join(', ')}`);
});
