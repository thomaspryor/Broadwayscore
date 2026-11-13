// BRO-7435: Theater Scene moved to theaterscene.com/reviews/; the first pass still read the dead .net feed
// and filtered on /plays|musicals/, so The Morbs, Parcel from America, Tristan & Yseult and 2:22 were found
// only by the audit sweep. Requires the real poller config and lane sources (no copied logic).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const poller = require('../../scripts/outlet-listing-poller.js');
const lane = require('../../scripts/lib/opening-night-lane/lane-sources.js');

const cfg = poller.OUTLET_STRATEGY_CONFIG['theater-scene'];

test('listing poller reads the live theaterscene.com feed', () => {
  assert.equal(cfg.url, 'https://theaterscene.com/feed/');
});

test('urlFilter keeps the /reviews/ URLs of the four missed shows and the older .net paths', () => {
  for (const u of [
    'https://theaterscene.com/reviews/parcel-from-america/',
    'https://theaterscene.com/reviews/222-a-ghost-story/',
    'https://www.theaterscene.net/plays/offbway-plays/the-morbs/victor-gluck/',
    'https://www.theaterscene.net/plays/offbway-plays/tristan-and-yseult/tony-marinelli/',
  ]) assert.ok(cfg.urlFilter.test(u), u);
  assert.ok(!cfg.urlFilter.test('https://www.theaterscene.net/features/some-column/'));
});

test('opening-night lane feed list carries the live theater-scene feed, not the dead one', () => {
  const feeds = (lane.LANE_FEEDS || []).filter((f) => f.outletId === 'theater-scene');
  assert.ok(feeds.length >= 1);
  assert.ok(feeds.every((f) => f.url === 'https://theaterscene.com/feed/'), JSON.stringify(feeds));
});
