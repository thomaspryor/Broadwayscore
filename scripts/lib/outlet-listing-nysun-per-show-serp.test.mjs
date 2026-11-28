// BRO-8189: new-york-sun was missed by the first pass on A Few Good Men, 2:22 and Blue Man Group.
// NY Sun slugs often omit the show ("a-blue-streak-of-staleness") and the culture listing is a
// 429-ing Next.js shell, so the listing cannot find these. Per-show SERP (by title) must.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const helpers = require('./outlet-listing-helpers.js');
const poller = require('../outlet-listing-poller.js');
const shows = [
  { id: 'a-few-good-men-2026', title: 'A Few Good Men', openingDate: '2026-10-30', category: 'broadway' },
  { id: 'blue-man-group-a-new-holiday-surprise-2026', title: 'Blue Man Group “A New Holiday Surprise”', openingDate: '2026-11-18', category: 'broadway' },
];
const NOW = Date.parse('2026-11-23');
const BLUE = 'https://www.nysun.com/article/a-blue-streak-of-staleness';
test('new-york-sun config runs per-show SERP beside the listing', () => {
  assert.equal(poller.OUTLET_STRATEGY_CONFIG['new-york-sun'].perShowSerp, true);
});
test('listing failing (429) still yields the review via per-show SERP, headline names the show', async () => {
  const serp = async (q) => q.includes('Blue Man Group')
    ? [{ url: BLUE, title: 'A Blue Streak of Staleness | Blue Man Group “A New Holiday Surprise” review' }, { url: 'https://www.nysun.com/section/culture', title: 'x' }]
    : [];
  const sc = { ...poller.OUTLET_STRATEGY_CONFIG['new-york-sun'], url: 'http://127.0.0.1:9/none', usePlainFetch: true };
  const items = await poller.fetchViaListingConfigWithSerp('new-york-sun', sc, 'nysun.com', new Date('2026-10-01'), {}, false, shows, serp, NOW);
  assert.deepEqual(items.map(i => i.url), [BLUE]);
  const m = helpers.findMatchingShows(items[0].headline, new URL(BLUE).pathname, shows, '', { publishDate: null });
  assert.deepEqual(m.map(x => x.id), ['blue-man-group-a-new-holiday-surprise-2026']);
});
test('opening-window mode stays free: no SERP calls', async () => {
  let calls = 0;
  const sc = { ...poller.OUTLET_STRATEGY_CONFIG['new-york-sun'], url: 'http://127.0.0.1:9/none', usePlainFetch: true };
  await assert.rejects(poller.fetchViaListingConfigWithSerp('new-york-sun', sc, 'nysun.com', new Date(), {}, true, shows, async () => { calls++; return []; }, NOW));
  assert.equal(calls, 0);
});
test('listing failed and SERP empty: throws so the outlet counts as failed', async () => {
  const sc = { ...poller.OUTLET_STRATEGY_CONFIG['new-york-sun'], url: 'http://127.0.0.1:9/none', usePlainFetch: true };
  await assert.rejects(poller.fetchViaListingConfigWithSerp('new-york-sun', sc, 'nysun.com', new Date('2026-10-01'), {}, false, shows, async () => [], NOW));
});
test('listing returns the URL with a show-less headline: SERP headline is merged in', async () => {
  const sc = { ...poller.OUTLET_STRATEGY_CONFIG['new-york-sun'], url: 'http://x.invalid/', usePlainFetch: true };
  const http = require('node:http');
  const srv = http.createServer((q, r) => { r.setHeader('content-type', 'text/html'); r.end(`<html><body>${'x'.repeat(600)}<a href="${BLUE}">A Blue Streak of Staleness</a></body></html>`); });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  sc.url = `http://127.0.0.1:${srv.address().port}/`;
  try {
    const serp = async (q) => q.includes('Blue Man') ? [{ url: BLUE, title: 'Blue Man Group “A New Holiday Surprise” review' }] : [];
    const items = await poller.fetchViaListingConfigWithSerp('new-york-sun', sc, 'nysun.com', new Date('2026-10-01'), {}, false, shows, serp, NOW);
    const hit = items.find(i => i.url === BLUE);
    assert.ok(hit && /Blue Man Group/.test(hit.headline), JSON.stringify(items));
  } finally { srv.close(); }
});
