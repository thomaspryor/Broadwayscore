/**
 * Regression test: mergeReviews() must refuse an in-place URL swap onto
 * ANOTHER show's review. On 2026-09-17 a mis-matched WET roundup merged The
 * Stage's Fences review (fences-review-leeds-playhouse, Matt Barton, 4 stars)
 * into man-to-man-west-end-2026/thestage--*.json; the Fences score, date and
 * critic went live on the Man to Man page. maybeUpgradeUrl already had a
 * cross-show guard; mergeReviews had none. Per CLAUDE.md rule 15 this
 * require()s the real functions.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { mergeReviews, reviewSlugNamesDifferentShow } = require('./review-normalization.js');

const MAN_TO_MAN = { id: 'man-to-man-west-end-2026', title: 'Man to Man', category: 'west-end' };

test('reviewSlugNamesDifferentShow: structured "<show>-review" slugs', () => {
  assert.equal(reviewSlugNamesDifferentShow('https://www.thestage.co.uk/reviews/fences-review-leeds-playhouse', 'Man to Man'), true);
  assert.equal(reviewSlugNamesDifferentShow('https://www.standard.co.uk/culture/theatre/burlesque-savoy-theatre-review-b1239600.html', 'Kinky Boots The Musical'), true);
  assert.equal(reviewSlugNamesDifferentShow('https://www.thestage.co.uk/reviews/man-to-man-review-jerwood-theatre-downstairs-royal-court-london-tilda-swinton', 'Man to Man'), false);
  // title after "review", compound slugs, headline slugs with no review-prefix show
  assert.equal(reviewSlugNamesDifferentShow('https://www.ny1.com/content/lifestyles/theater_reviews/206401/ny1-theater-review---a-raisin-in-the-sun-', 'A Raisin in the Sun'), false);
  assert.equal(reviewSlugNamesDifferentShow('https://www.thestage.co.uk/reviews/electrapersona-review-lyttelton-theatre-national-theatre-london', 'Electra / Persona'), false);
  assert.equal(reviewSlugNamesDifferentShow('https://www.nytimes.com/2003/10/31/movies/theater-review-there-s-trouble-in-emerald-city.html', 'Wicked'), false);
  assert.equal(reviewSlugNamesDifferentShow('https://example.com/2026/01/a-great-night-out', 'Wicked'), false);
  assert.equal(reviewSlugNamesDifferentShow('https://www.thestage.co.uk/reviews/fences-review-leeds-playhouse', null), false);
});

test('mergeReviews refuses a cross-show URL swap and keeps every existing field', () => {
  const existing = {
    showId: MAN_TO_MAN.id, outletId: 'thestage', outlet: 'The Stage', criticName: 'Unknown',
    url: 'https://www.thestage.co.uk/reviews/man-to-man-review-jerwood-theatre-downstairs-royal-court-london-tilda-swinton',
    contentTier: 'stub',
  };
  const incoming = {
    outletId: 'thestage', outlet: 'The Stage', criticName: 'Matt Barton',
    url: 'https://www.thestage.co.uk/reviews/fences-review-leeds-playhouse',
    publishDate: '2026-09-17', originalScore: '4/5 stars', source: 'westendtheatre',
  };
  const merged = mergeReviews(existing, incoming, {}, { script: 'test', showId: MAN_TO_MAN.id, show: MAN_TO_MAN });
  assert.equal(merged.url, existing.url);
  assert.equal(merged.criticName, 'Unknown');
  assert.equal(merged.originalScore, undefined);
  assert.equal(merged.publishDate, undefined);
  assert.equal(merged.urlUpdatedFrom, undefined);
});

test('mergeReviews still applies a same-show URL change', () => {
  const existing = {
    showId: MAN_TO_MAN.id, outletId: 'thestage', outlet: 'The Stage', criticName: 'Unknown',
    url: 'https://www.thestage.co.uk/reviews/man-to-man-review-royal-court',
  };
  const incoming = {
    outletId: 'thestage', outlet: 'The Stage', criticName: 'Sam Marlowe',
    url: 'https://www.thestage.co.uk/reviews/man-to-man-review-jerwood-theatre-downstairs-royal-court-london-tilda-swinton',
  };
  const merged = mergeReviews(existing, incoming, {}, { script: 'test', showId: MAN_TO_MAN.id, show: MAN_TO_MAN });
  assert.equal(merged.url, incoming.url);
  assert.equal(merged.criticName, 'Sam Marlowe');
});
