// BRO-7435: Theater Scene publishes reviews on theaterscene.net (/plays|musicals/...) AND theaterscene.com
// (/reviews/<slug>/). The first pass read only .net with a /plays|musicals/ filter, so Parcel from America and
// 2:22 - A Ghost Story (both .com only) were found later by audit-aggregator-gap. Real URLs from reviews on disk.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const poller = require('../../scripts/outlet-listing-poller.js');
const { laneFeeds } = require('../../scripts/lib/opening-night-lane/lane-sources.js');
const { hostSignalsReview } = require('../../scripts/lib/opening-night-lane/discovery.js');

const URLS = {
  'the-morbs-off-broadway-2026': 'https://www.theaterscene.net/plays/offbway-plays/the-morbs/victor-gluck/',
  'parcel-from-america-off-broadway-2026': 'https://theaterscene.com/reviews/parcel-from-america/',
  'tristan-and-yseult-off-broadway-2026': 'https://www.theaterscene.net/plays/offbway-plays/tristan-and-yseult/tony-marinelli/',
  '222-a-ghost-story-off-broadway-2026': 'https://theaterscene.com/reviews/222-a-ghost-story/',
};

test('daily poller theater-scene config accepts every known review URL shape', () => {
  const c = poller.OUTLET_STRATEGY_CONFIG['theater-scene'];
  for (const [id, u] of Object.entries(URLS)) assert.ok(c.urlFilter.test(u), `${id}: filtered out ${u}`);
});

test('daily poller reads the theaterscene.com feed', () => {
  const c = poller.OUTLET_STRATEGY_CONFIG['theater-scene'];
  assert.ok([c.url, ...(c.extraUrls || [])].some((u) => /theaterscene\.com\/feed/.test(u)));
});

test('opening-night lane polls both Theater Scene feeds', () => {
  const urls = laneFeeds({ id: 'x', title: 'X', category: 'off-broadway' }).filter((f) => f.outletId === 'theater-scene').map((f) => f.url);
  assert.ok(urls.some((u) => /theaterscene\.net/.test(u)) && urls.some((u) => /theaterscene\.com/.test(u)), urls.join(','));
});

test('lane treats a theaterscene.com show-titled page as a review without a review word', () => {
  assert.ok(hostSignalsReview(URLS['parcel-from-america-off-broadway-2026'], 'Parcel from America', 'Parcel from America'));
  assert.ok(hostSignalsReview(URLS['222-a-ghost-story-off-broadway-2026'], '2:22 - A Ghost Story', '2:22 - A Ghost Story'));
});
