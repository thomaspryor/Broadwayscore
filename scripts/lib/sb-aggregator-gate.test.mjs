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
  assert.equal(skipSbAggregator('bad url', {}), false);
});
