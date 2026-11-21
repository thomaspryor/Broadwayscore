// BRO-6872: Exeunt's 2026-10-22 review of The Imaginary Invalid reached the site but never the lane: no aggregator
// cited it and the Google News link did not decode. Exeunt's reviews feed is now one of the lane's default feeds.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const d = require('../../scripts/lib/opening-night-lane/discovery.js');

const FEED_URL = 'https://exeuntnyc.com/reviews/feed/';
const SHOW = { id: 'the-imaginary-invalid-2026', title: 'The Imaginary Invalid', category: 'broadway' };
// Titles and links only, in the feed's own shape.
const FEED = `<?xml version="1.0"?><rss version="2.0"><channel><title>Reviews - Exeunt Magazine NYC</title>
<item><title>Review: The Imaginary Invalid at Todd Haimes Theatre</title><link>https://exeuntnyc.com/reviews/review-the-imaginary-invalid-at-todd-haimes-theatre/</link><pubDate>Thu, 23 Oct 2026 02:05:00 +0000</pubDate></item>
<item><title>Review: Legerdemain at The Tank</title><link>https://exeuntnyc.com/reviews/review-legerdemain-at-the-tank/</link><pubDate>Sun, 01 Nov 2026 01:00:52 +0000</pubDate></item>
</channel></rss>`;

test('a Broadway night reads the Exeunt reviews feed by default', () => {
  const feeds = d.defaultLaneFeeds(SHOW);
  assert.ok(feeds.some((f) => f.url === FEED_URL && f.outletId === 'exeunt-magazine'));
  assert.ok(!d.defaultLaneFeeds({ ...SHOW, market: 'west-end' }).some((f) => f.url === FEED_URL), 'not on a West End night');
});

test('the feed item for the show is discovered as Exeunt; other shows are not', async () => {
  const out = await d.rssAdapter({ feeds: [{ url: FEED_URL, outletId: 'exeunt-magazine', name: 'Exeunt Magazine' }] })
    .discover({ show: SHOW, fetchText: async (u) => { if (u !== FEED_URL) throw new Error('404'); return FEED; } });
  assert.deepEqual(out.map((c) => [c.url, c.outletId]), [['https://exeuntnyc.com/reviews/review-the-imaginary-invalid-at-todd-haimes-theatre/', 'exeunt-magazine']]);
});
