import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { skipSbAggregator } = require('./sb-market-gate');

test('market-only aggregators skip SB without affecting Broadway hosts or rollback', () => {
  for (const host of ['theatre.reviews', 'www.theatre.reviews', 'westendtheatre.com', 'www.londonboxoffice.co.uk']) {
    assert.equal(skipSbAggregator(`https://${host}/anything`, {}), true, host);
  }
  for (const host of ['broadwayworld.com', 'broadwaynews.com', 'didtheylikeit.com', 'thestage.co.uk', 'theatre.reviews.example.com']) {
    assert.equal(skipSbAggregator(`https://${host}/anything`, {}), false, host);
  }
  assert.equal(skipSbAggregator('https://theatre.reviews/x', { SB_MARKET_GATE_DISABLED: '1' }), false);
  // BRO-8325: The Stage gates only its London aggregator surfaces, never single reviews.
  for (const u of [
    'https://www.thestage.co.uk/review-round-ups',
    'https://www.thestage.co.uk/review-round-ups/review-round-ups',
    'https://www.thestage.co.uk/review-round-ups/paddington-the-musical-at-the-savoy-theatre-review-round-up',
  ]) assert.equal(skipSbAggregator(u, {}), true, u);
  for (const u of [
    'https://www.thestage.co.uk/reviews',
    'https://www.thestage.co.uk/SiteMap_TheStage_index.xml', // NYC review census walks it (outlet-census-sources.js)
    'https://www.thestage.co.uk/reviews/hamlet-rsc-stratford',
    'https://www.thestage.co.uk/news/review-round-ups-are-back',
    'https://www.thestage.co.uk/',
  ]) assert.equal(skipSbAggregator(u, {}), false, u);
  assert.equal(skipSbAggregator('https://www.thestage.co.uk/review-round-ups/x', { SB_MARKET_GATE_DISABLED: '1' }), false);
  assert.equal(skipSbAggregator('bad url', {}), false);
});
