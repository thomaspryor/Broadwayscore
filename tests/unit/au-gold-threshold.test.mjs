// BRO-8433: Australian regional shows need 85 for Critical Gold; US/UK regional stay 83.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { getGoldThreshold, getScoreTierLabel } = require('../../scripts/lib/score-tiers.js');
const { getScoreMarketKey } = require('../../scripts/lib/market-label.js');
const { getMarketMinReviews } = require('../../scripts/lib/min-reviews.js');

test('AU regional venue maps to the regional-au score market', () => {
  assert.equal(getScoreMarketKey({ category: 'regional', venue: 'Capitol Theatre, Sydney, NSW' }), 'regional-au');
  assert.equal(getScoreMarketKey({ category: 'regional', venue: 'Princess Theatre, Melbourne, VIC' }), 'regional-au');
});

test('US/UK regional and other categories keep their own key', () => {
  assert.equal(getScoreMarketKey({ category: 'regional', venue: 'Goodman Theatre, Chicago, IL' }), 'regional');
  assert.equal(getScoreMarketKey({ category: 'west-end', venue: 'Lyric Theatre, London' }), 'west-end');
  assert.equal(getScoreMarketKey({ category: 'broadway', venue: 'Sydney Hall' }), 'broadway');
  assert.equal(getScoreMarketKey({}), undefined);
});

test('Gold bar: AU 85, US regional and Broadway 83', () => {
  assert.equal(getGoldThreshold('regional-au'), 85);
  assert.equal(getGoldThreshold('regional'), 83);
  assert.equal(getGoldThreshold('broadway'), 83);
  assert.equal(getScoreTierLabel(84.17, 'regional-au'), 'Recommended');
  assert.equal(getScoreTierLabel(84.17, 'regional'), 'Critical Gold');
  assert.equal(getScoreTierLabel(85, 'regional-au'), 'Critical Gold');
});

test('regional-au keeps the regional review minimum', () => {
  assert.equal(getMarketMinReviews('regional-au'), getMarketMinReviews('regional'));
});
