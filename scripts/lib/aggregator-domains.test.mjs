// BRO-224: the live West End aggregator is westendtheatre.COM; the guard must carry it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { AGGREGATOR_DOMAINS, isAggregatorUrlMismatch } = require('./aggregator-domains.js');

test('AGGREGATOR_DOMAINS carries westendtheatre.com (BRO-224)', () => {
  assert.ok(AGGREGATOR_DOMAINS.has('westendtheatre.com'));
});

test('real-outlet id on a westendtheatre.com URL is flagged; the aggregator id is not', () => {
  const url = 'https://www.westendtheatre.com/reviews-roundup/x/';
  assert.equal(isAggregatorUrlMismatch(url, 'guardian'), true);
  assert.equal(isAggregatorUrlMismatch(url, 'westendtheatre'), false);
});

// BRO-6742: theatre.reviews publishes its own critic's reviews under /review/;
// round-ups live under /reviews-roundup/.
test('theatre.reviews own review under /review/ is not a mismatch for its own outlet only', () => {
  const { isAggregatorOwnReviewUrl } = require('./aggregator-domains.js');
  const own = 'https://theatre.reviews/review/cherry-orchard-kristin-scott-thomas-review/';
  const roundup = 'https://theatre.reviews/reviews-roundup/martin-guerre-old-vic-reviews/';
  assert.equal(isAggregatorUrlMismatch(own, 'theatre-reviews-paul-seven'), false);
  assert.equal(isAggregatorOwnReviewUrl(own, 'theatre-reviews-paul-seven'), true);
  assert.equal(isAggregatorUrlMismatch(own, 'guardian'), true);
  assert.equal(isAggregatorUrlMismatch(roundup, 'theatre-reviews-paul-seven'), true);
  assert.equal(isAggregatorOwnReviewUrl('not a url', 'theatre-reviews-paul-seven'), false);
});

test('validator-side hasAggregatorUrlMismatch agrees on the own-review path', () => {
  const { hasAggregatorUrlMismatch } = require('./aggregator-url-latent.js');
  const own = 'https://theatre.reviews/review/cherry-orchard-kristin-scott-thomas-review/';
  assert.equal(hasAggregatorUrlMismatch({ url: own, outletId: 'theatre-reviews-paul-seven' }), false);
  assert.equal(hasAggregatorUrlMismatch({ url: own, outletId: 'guardian' }), true);
});

test('own-review exemption: www/upper-case host and the outlet\'s display-name alias', () => {
  const { isAggregatorOwnReviewUrl } = require('./aggregator-domains.js');
  const own = 'https://WWW.Theatre.Reviews/review/cherry-orchard-kristin-scott-thomas-review/';
  assert.equal(isAggregatorOwnReviewUrl(own, 'theatre-reviews-paul-seven'), true);
  assert.equal(isAggregatorUrlMismatch(own, 'Theatre.Reviews with Paul Seven'), false);
});
