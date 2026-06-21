/**
 * Unit tests for the aggregator-URL-mismatch guard (added 2026-06-21).
 *
 * Bug class: serp-discovery (and other ingest paths) in gather-reviews.js could
 * write a review-text stub whose `url` is on a known aggregator domain
 * (theatre.reviews, show-score.com, stagedoor.com, …) but whose `outletId` is a
 * real outlet (chichester-observer, guardian-uk, …). validate-review-texts.js
 * flags this as an `aggregator_url_mismatch` ERROR and it held main red for 2
 * days (one instance deleted 2026-06-15, commit 3d54cb4797).
 *
 * Prevention: lib/aggregator-domains.js exposes the canonical domain/outlet sets
 * + isAggregatorUrlMismatch(), shared by BOTH the writer (gather-reviews.js
 * createReviewFile) and the validator (validate-review-texts.js) so they agree by
 * construction.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const {
  AGGREGATOR_DOMAINS,
  AGGREGATOR_OUTLET_IDS,
  hostnameOf,
  isAggregatorUrlMismatch,
} = require('../../scripts/lib/aggregator-domains');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, '..', '..');

describe('isAggregatorUrlMismatch — pure predicate', () => {
  test('aggregator domain + real outlet → mismatch (the contamination class)', () => {
    // exactly the deleted-2026-06-15 case
    assert.equal(isAggregatorUrlMismatch('https://theatre.reviews/some-roundup', 'chichester-observer'), true);
    assert.equal(isAggregatorUrlMismatch('https://www.show-score.com/x', 'guardian-uk'), true);
    assert.equal(isAggregatorUrlMismatch('https://stagedoor.com/shows/y', 'standard'), true);
  });

  test('aggregator domain + aggregator outlet → legit (not a mismatch)', () => {
    assert.equal(isAggregatorUrlMismatch('https://theatre.reviews/x', 'theatre-reviews'), false);
    assert.equal(isAggregatorUrlMismatch('https://show-score.com/x', 'show-score'), false);
    assert.equal(isAggregatorUrlMismatch('https://stagedoor.com/x', 'stagedoor'), false);
    assert.equal(isAggregatorUrlMismatch('https://www.londonboxoffice.co.uk/x', 'lbo'), false);
  });

  test('non-aggregator domain → never a mismatch (real outlet URL is fine)', () => {
    assert.equal(isAggregatorUrlMismatch('https://www.nytimes.com/review', 'nytimes'), false);
    assert.equal(isAggregatorUrlMismatch('https://www.theguardian.com/x', 'guardian-uk'), false);
  });

  test('www. prefix and casing are normalized before matching', () => {
    assert.equal(isAggregatorUrlMismatch('https://WWW.Theatre.Reviews/X', 'chichester-observer'), true);
  });

  test('missing/blank/unparseable inputs are not mismatches (innocent until provable)', () => {
    assert.equal(isAggregatorUrlMismatch(null, 'chichester-observer'), false);
    assert.equal(isAggregatorUrlMismatch('https://theatre.reviews/x', null), false);
    assert.equal(isAggregatorUrlMismatch('not a url', 'chichester-observer'), false);
    assert.equal(isAggregatorUrlMismatch('', ''), false);
  });

  test('hostnameOf strips www. and lowercases; null on garbage', () => {
    assert.equal(hostnameOf('https://WWW.Show-Score.com/path'), 'show-score.com');
    assert.equal(hostnameOf('garbage'), null);
    assert.equal(hostnameOf(null), null);
  });
});

describe('lockstep — validator and writer share the same canonical sets', () => {
  test('the validator imports AGGREGATOR_DOMAINS/OUTLET_IDS from the shared lib', () => {
    const src = fs.readFileSync(path.join(REPO, 'scripts', 'validate-review-texts.js'), 'utf8');
    assert.match(src, /require\(['"]\.\/lib\/aggregator-domains['"]\)/,
      'validate-review-texts.js must import the shared sets, not redefine them');
  });

  test('gather-reviews.js wires the guard into createReviewFile', () => {
    const src = fs.readFileSync(path.join(REPO, 'scripts', 'gather-reviews.js'), 'utf8');
    assert.match(src, /require\(['"]\.\/lib\/aggregator-domains['"]\)/,
      'gather-reviews.js must import the shared predicate');
    assert.match(src, /isAggregatorUrlMismatch\(reviewData\.url, normalizedOutletId\)/,
      'createReviewFile must call the guard');
    assert.match(src, /return 'aggregatorUrlMismatch'/,
      'the guard must short-circuit the write with a rejection code');
  });

  test('the canonical sets are non-empty (import did not silently fail)', () => {
    assert.ok(AGGREGATOR_DOMAINS.size > 0);
    assert.ok(AGGREGATOR_OUTLET_IDS.size > 0);
    assert.ok(AGGREGATOR_DOMAINS.has('theatre.reviews'));
    assert.ok(AGGREGATOR_OUTLET_IDS.has('theatre-reviews'));
  });
});
