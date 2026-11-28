/**
 * BRO-8451: Australian productions use the Critical Gold cutoff 85 (like the West End);
 * US regional shows stay at 83. AU shows are `category: 'regional'`, so the tier functions
 * take a tier-market key from getTierMarket(show) ('regional-au' for an AU venue).
 * Real functions only: TS seam (src/lib/market-utils.ts) and its JS twin (market-label.js).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { getTierMarket, getMarketMinReviews } from '../../src/lib/market-utils';
import { getScoreTier, getScoreTierRange } from '../../src/components/show-cards/ScoreBadge';
import { getScoreBucket, isCriticalGold, getGoldThreshold } from '../../src/config/score-buckets';

const require = createRequire(import.meta.url);
const twin = require('../../scripts/lib/market-label.js');
const tiers = require('../../scripts/lib/score-tiers.js');
const { reviewsRemainingForScore } = require('../../scripts/lib/min-reviews.js');

const AU_VENUE = 'Regent Theatre, Melbourne, VIC';
const US_VENUE = 'Goodman Theatre, Chicago, IL';
const au = { category: 'regional', venue: AU_VENUE };
const us = { category: 'regional', venue: US_VENUE };

test('AU regional gold is 85, US regional stays 83, West End stays 85', () => {
  assert.equal(getGoldThreshold(getTierMarket(au)), 85);
  assert.equal(getGoldThreshold(getTierMarket(us)), 83);
  assert.equal(getGoldThreshold('regional'), 83);
  assert.equal(getGoldThreshold('west-end'), 85);
  assert.equal(tiers.getGoldThreshold(twin.getTierMarket(au)), 85);
  assert.equal(tiers.getGoldThreshold(twin.getTierMarket(us)), 83);
});

test('BRO-8451 live scores: Fiddler 83.72, A Beautiful Noise 83.92 and A Room with a View 82.57 are not Gold in AU (rounded, US Gold at 83)', () => {
  for (const [score, auGold, usGold] of [[88.57, true, true], [90, true, true], [83.92, false, true], [83.72, false, true], [82.57, false, true]]) {
    const r = Math.round(score);
    assert.equal(isCriticalGold(r, getTierMarket(au)), auGold, `AU ${score}`);
    assert.equal(getScoreTier(r, getTierMarket(au))?.label === 'Critical Gold', auGold, `AU tier ${score}`);
    assert.equal(getScoreBucket(r, getTierMarket(us)).id === 'must-see', usGold, `US ${score}`);
    assert.equal(tiers.getScoreTierLabel(score, twin.getTierMarket(au)) === 'Critical Gold', auGold, `JS AU ${score}`);
  }
  assert.equal(tiers.getScoreTierLabel(83.72, twin.getTierMarket(au)), 'Recommended');
  assert.match(getScoreTierRange('mustSee', 'regional-au'), /85/);
});

test('TS getTierMarket and its JS twin agree; only regional AU houses change', () => {
  const cases = [au, us, { category: 'regional', venue: 'Royal Shakespeare Theatre' }, { category: 'regional', venue: 'Roslyn Packer Theatre' },
    { category: 'broadway', venue: AU_VENUE }, { category: 'west-end', venue: 'Lyric Theatre, London' }, { category: 'regional' }, {}, { category: null, venue: null }];
  for (const s of cases) assert.equal(getTierMarket(s), twin.getTierMarket(s), JSON.stringify(s));
  assert.equal(getTierMarket(au), 'regional-au');
  assert.equal(getTierMarket(us), 'regional');
  assert.equal(getTierMarket({ category: 'broadway', venue: AU_VENUE }), 'broadway');
});

test('the tier key never changes the review-count gate: regional-au gates like regional', () => {
  assert.equal(getMarketMinReviews('regional-au'), getMarketMinReviews('regional'));
  for (const rc of [0, 2, 3, 4, 5]) {
    assert.equal(reviewsRemainingForScore(rc, 'regional-au', 0), reviewsRemainingForScore(rc, 'regional', 0), `rc ${rc}`);
  }
});
