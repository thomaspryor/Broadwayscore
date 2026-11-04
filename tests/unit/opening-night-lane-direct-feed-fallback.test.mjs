// BRO-6872: a direct-only lane feed the runner cannot reach (JK's, Bob's and four more failed "fetch failed" on every
// pass of the 2026-11-03 shadows while answering from elsewhere) gets a rested Bright Data read. Real adapter, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const d = require('../../scripts/lib/opening-night-lane/discovery.js');

const SHOW = { id: 'a-few-good-men-2026', title: 'A Few Good Men', category: 'broadway' };
const FEED = 'https://www.jkstheatrescene.com/feeds/posts/default?alt=rss';
const ITEM = 'https://www.jkstheatrescene.com/2026/10/review-a-few-good-men.html';
const XML = `<rss><channel><item><title>A Few Good Men</title><link>${ITEM}</link><pubDate>Fri, 30 Oct 2026 03:00:00 GMT</pubDate></item></channel></rss>`;
const feeds = [{ url: FEED, outletId: 'jks-theatre-scene', name: "JK's Theatre Scene", directOnly: true }];

const networkError = () => Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });

function fetcher(direct) {
  const calls = [];
  const fetchText = async (url, opts = {}) => {
    calls.push(opts.directOnly ? 'direct' : (opts.tiers || []).join('+') || 'chain');
    if (opts.directOnly) throw direct();
    return XML;
  };
  return { calls, fetchText };
}

test('a feed the runner cannot reach is read through Bright Data and its review is found', async () => {
  const { calls, fetchText } = fetcher(networkError);
  const out = await d.rssAdapter({ feeds }).discover({ show: SHOW, fetchText });
  assert.deepEqual(calls, ['direct', 'brightdata']);
  assert.ok(out.some((r) => r.url === ITEM && r.vettedOutlet), JSON.stringify(out));
});

test('the paid read rests between passes, then comes back', async () => {
  const { calls, fetchText } = fetcher(networkError);
  const adapter = d.rssAdapter({ feeds });
  const found = [];
  for (let i = 0; i < d.PAID_FEED_REST_PASSES + 1; i++) found.push((await adapter.discover({ show: SHOW, fetchText })).length);
  assert.equal(calls.filter((c) => c === 'brightdata').length, 2, calls.join(','));
  assert.equal(calls.filter((c) => c === 'direct').length, d.PAID_FEED_REST_PASSES + 1);
  assert.deepEqual(found.map((n) => n > 0), [true, ...Array(d.PAID_FEED_REST_PASSES - 1).fill(false), true]);
});

test('an HTTP refusal or a challenge page stays free and unfound', async () => {
  for (const msg of ['Direct fetch failed: 403', 'Direct fetch returned empty or blocked content']) {
    const { calls, fetchText } = fetcher(() => new Error(msg));
    const out = await d.rssAdapter({ feeds }).discover({ show: SHOW, fetchText });
    assert.deepEqual(calls, ['direct'], msg);
    assert.equal(out.length, 0);
  }
});

test('a direct timeout counts as unreachable; the pass deadline does not', () => {
  assert.equal(d.unreachableFromRunner(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })), true);
  assert.equal(d.unreachableFromRunner(new TypeError('fetch failed (ENOTFOUND)')), true);
  assert.equal(d.unreachableFromRunner(new Error('pass deadline reached before fetching x')), false);
  assert.equal(d.unreachableFromRunner(new Error('fetch timed out after 15000ms: x')), false);
  assert.equal(d.unreachableFromRunner(null), false);
});

test('feeds with the regular chain are never sent to the paid fallback twice', async () => {
  const calls = [];
  const fetchText = async (url, opts = {}) => { calls.push(opts); throw networkError(); };
  await d.rssAdapter({ feeds: [{ url: 'https://variety.com/feed', outletId: 'variety', name: 'Variety' }] }).discover({ show: SHOW, fetchText });
  assert.deepEqual(calls, [{}]);
});

test('fetchTextFrom names the network cause so the shadow recording says why', async () => {
  const fetchText = d.fetchTextFrom(async () => { throw networkError(); });
  await assert.rejects(fetchText(FEED, { directOnly: true }), (e) => e.message === 'fetch failed (ECONNRESET)' && d.unreachableFromRunner(e));
});
