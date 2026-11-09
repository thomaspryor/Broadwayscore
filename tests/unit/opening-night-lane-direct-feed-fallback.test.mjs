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

test('a feed Bright Data also fails stops paying after PAID_FEED_MAX_FAILS reads in a row', async () => {
  let paidCalls = 0;
  const fetchText = async (url, opts = {}) => { if (opts.directOnly) throw networkError(); paidCalls += 1; throw new Error('All scraping methods failed'); };
  const adapter = d.rssAdapter({ feeds });
  for (let i = 0; i < d.PAID_FEED_REST_PASSES * (d.PAID_FEED_MAX_FAILS + 3); i++) await adapter.discover({ show: SHOW, fetchText });
  assert.equal(paidCalls, d.PAID_FEED_MAX_FAILS);
});

test('one run pays for at most PAID_FEED_RUN_MAX rested reads across all feeds', async () => {
  const many = Array.from({ length: 12 }, (_, i) => ({ url: `https://blog${i}.example.com/feed`, outletId: `b${i}`, directOnly: true }));
  let paidCalls = 0;
  const fetchText = async (url, opts = {}) => { if (opts.directOnly) throw networkError(); paidCalls += 1; return '<rss><channel></channel></rss>'; };
  const adapter = d.rssAdapter({ feeds: many });
  for (let i = 0; i < 200; i++) await adapter.discover({ show: SHOW, fetchText });
  assert.equal(paidCalls, d.PAID_FEED_RUN_MAX);
});

test('the paid read gets the slow budget, not the cheap 15 s cap (a cut-off Bright Data read is billed anyway)', async () => {
  const fetchText = async (url, opts = {}) => {
    if (opts.directOnly) throw networkError();
    await new Promise((r) => setTimeout(r, 120));
    return url === FEED ? XML : '<html><head><meta property="article:published_time" content="2026-10-30T03:00:00Z"></head><body><article><h1>Review: A Few Good Men</h1><p>review</p></article></body></html>';
  };
  const T0 = Date.parse('2026-10-30T02:00:00Z');
  const r = await d.runDiscoveryPass({ show: SHOW, night: '2026-10-29', now: T0 + 3600e3, startedAt: T0, adapters: [d.rssAdapter({ feeds })], fetchText, fetchTimeoutMs: 50 });
  assert.ok(JSON.stringify(r).includes(ITEM), JSON.stringify(r).slice(0, 400));
});

test('a recorded timeout replayed from its message alone still counts as unreachable', () => {
  assert.equal(d.unreachableFromRunner(new Error('The operation was aborted due to timeout')), true);
  assert.equal(d.unreachableFromRunner(new Error('This operation was aborted')), true);
});

test('the cause code is added to direct reads only (Talkin\' Broadway reads ECONNRESET as blocked)', async () => {
  const fetchText = d.fetchTextFrom(async () => { throw networkError(); });
  await assert.rejects(fetchText('https://www.talkinbroadway.com/page/world/x.html'), (e) => e.message === 'fetch failed');
});

test('a regular feed that keeps failing rests between reads instead of paying on every pass (WaPo 502, BRO-6872)', async () => {
  const WAPO = 'https://feeds.washingtonpost.com/rss/entertainment';
  const reads = [];
  const fetchText = async (url) => { reads.push(url); if (url === WAPO) throw new Error('All scraping methods failed'); return XML; };
  const adapter = d.rssAdapter({ feeds: [{ url: WAPO, outletId: 'washpost' }, { url: 'https://variety.com/feed', outletId: 'variety' }] });
  const passes = d.CHAIN_FEED_MAX_FAILS + d.CHAIN_FEED_REST_PASSES * 2;
  for (let i = 0; i < passes; i++) await adapter.discover({ show: SHOW, fetchText });
  const wapo = reads.filter((u) => u === WAPO).length;
  assert.equal(wapo, d.CHAIN_FEED_MAX_FAILS + 2, `read ${wapo} times in ${passes} passes`);
  assert.equal(reads.filter((u) => u !== WAPO).length, passes, 'the other feed is read every pass');
});

test('a regular feed that answers again is read every pass again', async () => {
  const FEED = 'https://variety.com/feed';
  let down = true; const reads = [];
  const fetchText = async (url) => { reads.push(url); if (down) throw new Error('All scraping methods failed'); return XML; };
  const adapter = d.rssAdapter({ feeds: [{ url: FEED, outletId: 'variety' }] });
  for (let i = 0; i < d.CHAIN_FEED_MAX_FAILS; i++) await adapter.discover({ show: SHOW, fetchText });
  down = false;
  for (let i = 0; i < d.CHAIN_FEED_REST_PASSES + 4; i++) await adapter.discover({ show: SHOW, fetchText });
  // 3 failures, a rest of CHAIN_FEED_REST_PASSES - 1 skipped passes, then a good read and every pass after it.
  assert.equal(reads.length, d.CHAIN_FEED_MAX_FAILS + 5, reads.length);
});

test('two failures in a row do not rest a feed', async () => {
  const FEED = 'https://variety.com/feed';
  let n = 0;
  const fetchText = async () => { n += 1; if (n % 3 !== 0) throw new Error('All scraping methods failed'); return XML; };
  const adapter = d.rssAdapter({ feeds: [{ url: FEED, outletId: 'variety' }] });
  for (let i = 0; i < 12; i++) await adapter.discover({ show: SHOW, fetchText });
  assert.equal(n, 12);
});
