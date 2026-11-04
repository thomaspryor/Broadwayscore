// BRO-6965: the daily outlet-listing poller reads every feed the opening-night lane reads, on the lane's rules.
// TESTS-VS-DERIVED-DATA-EXEMPT: structural coverage check plus rule checks on headline strings; pins no review facts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { LANE_FEEDS } = require('../../scripts/lib/opening-night-lane/lane-sources.js');
const poller = require('../../scripts/outlet-listing-poller.js');
const { dailyLaneFeedConfigs, laneFeedAccepts } = require('../../scripts/lib/daily-lane-feeds.js');

const BROADWAY = { id: 'a-few-good-men-2026', title: 'A Few Good Men', category: 'broadway' };
const WEST_END = { id: 'x-west-end', title: 'X', category: 'west-end', market: 'west-end' };

test('every LANE_FEEDS outlet is read by the daily poller', () => {
  const missing = LANE_FEEDS.filter((f) => !poller.OUTLET_STRATEGY_CONFIG[f.outletId] && !poller.WP_API_CONFIG[f.outletId]
    && !poller.SKIP_OUTLETS.has(f.outletId)).map((f) => f.outletId);
  assert.deepEqual(missing, [], `LANE_FEEDS outlets the daily poller does not read: ${missing.join(', ')}. `
    + 'dailyLaneFeedConfigs (scripts/lib/daily-lane-feeds.js) should add them; check SKIP_OUTLETS.');
});

test('a daily rss config for a lane outlet reads the lane feed url', () => {
  for (const f of LANE_FEEDS) {
    const c = poller.OUTLET_STRATEGY_CONFIG[f.outletId];
    if (c && c.strategy === 'rss') assert.equal(c.url, f.url, `${f.outletId}: daily poller and lane read different feeds`);
  }
});

test('the lane-derived config carries titledReviews for Bob\'s and is skipped for outlets already configured', () => {
  const derived = dailyLaneFeedConfigs({ guardian: { strategy: 'rss' } });
  assert.equal(derived.guardian, undefined);
  assert.equal(derived['bobs-theater-blog'].titledReviews, true);
  assert.equal(derived['bobs-theater-blog'].laneRules, true);
  assert.equal(derived['jks-theatre-scene'].titledReviews, undefined);
});

test('Bob\'s: only a headline that is the show title alone counts', () => {
  const cfg = poller.OUTLET_STRATEGY_CONFIG['bobs-theater-blog'];
  const item = (headline) => ({ url: 'https://gotham-playgoer.blogspot.com/2026/10/x.html', headline });
  assert.equal(laneFeedAccepts(cfg, 'bobs-theater-blog', item('A Few Good Men'), BROADWAY), true);
  assert.equal(laneFeedAccepts(cfg, 'bobs-theater-blog', item('A Few Good Men (Broadway)'), BROADWAY), true);
  assert.equal(laneFeedAccepts(cfg, 'bobs-theater-blog', item('Theater Bulletin: "A Few Good Men" Extends'), BROADWAY), false);
  assert.equal(laneFeedAccepts(cfg, 'bobs-theater-blog', item('A Few Good Men Meets the Press'), BROADWAY), false);
});

test('a feed without reviewsOnly needs a review word in the headline or url', () => {
  const cfg = poller.OUTLET_STRATEGY_CONFIG['jks-theatre-scene'];
  assert.equal(laneFeedAccepts(cfg, 'jks-theatre-scene', { url: 'https://www.jkstheatrescene.com/2026/10/review-few-good-men.html', headline: 'Review: A Few Good Men' }, BROADWAY), true);
  assert.equal(laneFeedAccepts(cfg, 'jks-theatre-scene', { url: 'https://www.jkstheatrescene.com/2026/10/games.html', headline: 'Broadway Games: A Few Good Men Quiz' }, BROADWAY), false);
});

test('outlets that already had a poller config keep their old rules', () => {
  assert.equal(laneFeedAccepts(poller.OUTLET_STRATEGY_CONFIG.guardian, 'guardian', { url: 'u', headline: 'anything' }, BROADWAY), true);
});

test('market: a lane feed never files a show in a market the outlet is not in', () => {
  const cfg = { laneRules: true };
  assert.equal(laneFeedAccepts(cfg, 'westendtheatre', { url: 'https://westend.example/review-x', headline: 'Review: X' }, BROADWAY), false);
  assert.equal(laneFeedAccepts(cfg, 'westendtheatre', { url: 'https://westend.example/review-x', headline: 'Review: X' }, WEST_END), true);
});
