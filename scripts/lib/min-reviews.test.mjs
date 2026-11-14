// Parity guard: scripts/lib/min-reviews.js (CommonJS, consumed by the slim-file
// generator under plain node) MUST equal the canonical TS constants in
// src/config/score-buckets.ts (consumed by the browser bundle). If these drift,
// the live list/show pages and the slim files disagree on which shows show a
// score — exactly the 3-vs-5 West End bug this fixes.
//
// Runs under plain `node --test` (the colocated scripts/lib/*.test.mjs glob in
// test.yml), so we parse score-buckets.ts as TEXT rather than importing it — a
// .ts import would need the tsx batch and explicit path-listing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const minReviews = require('./min-reviews.js');

const bucketsSrc = readFileSync(
  join(here, '../../src/config/score-buckets.ts'),
  'utf8',
);

function tsConst(name) {
  const m = bucketsSrc.match(new RegExp(`export const ${name}\\s*=\\s*(\\d+)`));
  assert.ok(m, `could not find "export const ${name}" in score-buckets.ts`);
  return Number(m[1]);
}

test('JS mirror constants equal the TS canonical in score-buckets.ts', () => {
  assert.equal(minReviews.MIN_REVIEWS, tsConst('MIN_REVIEWS_FOR_SCORE'), 'default/Broadway');
  assert.equal(minReviews.MIN_REVIEWS_OFF_BROADWAY, tsConst('MIN_REVIEWS_FOR_SCORE_OFF_BROADWAY'), 'off-broadway');
  assert.equal(minReviews.MIN_REVIEWS_WEST_END, tsConst('MIN_REVIEWS_FOR_SCORE_WEST_END'), 'west-end');
  assert.equal(minReviews.MIN_REVIEWS_OFF_WEST_END, tsConst('MIN_REVIEWS_FOR_SCORE_OFF_WEST_END'), 'off-west-end');
  assert.equal(minReviews.MIN_REVIEWS_CURATED_HISTORICAL, tsConst('MIN_REVIEWS_FOR_SCORE_CURATED_HISTORICAL'), 'curated-historical');
  assert.equal(minReviews.T3_ONLY_EXTRA, tsConst('T3_ONLY_EXTRA_REVIEWS'), 'T3-only extra');
});

test('getMarketMinReviews returns the right base per market', () => {
  assert.equal(minReviews.getMarketMinReviews('west-end'), 5);
  assert.equal(minReviews.getMarketMinReviews('off-west-end'), 3);
  assert.equal(minReviews.getMarketMinReviews('off-broadway'), 3);
  assert.equal(minReviews.getMarketMinReviews('regional'), 3);
  assert.equal(minReviews.getMarketMinReviews('broadway'), 5);
  assert.equal(minReviews.getMarketMinReviews(undefined), 5);
});

// BRO-159: an unhandled category value used to fall through `default` and get
// the Broadway threshold (5) instead of the Off-Broadway one (3) — a
// Broadway-shaped default for a market nobody wrote a case for. Enumerated
// off-off-broadway (owner decision 2026-08-03, Option A) must get the
// Off-Broadway threshold, same as its parent market.
test('getMarketMinReviews: off-off-broadway gets the Off-Broadway threshold, not the Broadway default', () => {
  assert.equal(minReviews.getMarketMinReviews('off-off-broadway'), 3);
});
