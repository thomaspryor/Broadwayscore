// BRO-6872: Google News wrapper unwraps in the opening-night lane. In the 2026-11-04 five-show replays every Playwright
// unwrap that reached a publisher settled at about 18 s and was cut off by the 15 s per-fetch cap, so the New York Sun's
// A Few Good Men review (and Gold Derby, Culture Sauce, 1 Minute Critic) was resolved and then thrown away three times.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const d = require('../../scripts/lib/opening-night-lane/discovery.js');

const SHOW = { id: 'other-desert-cities-2026', title: 'Other Desert Cities', openingDate: '2026-10-18' };
const NIGHT = '2026-10-18';
const T0 = Date.parse('2026-10-18T21:00:00Z');
const HOUR = 3600000;
const FEED_URL = 'https://news.google.com/rss/search?q=%22Other+Desert+Cities%22+review&hl=en-US&gl=US&ceid=US%3Aen';
const link = (i) => `https://news.google.com/rss/articles/CBMiT${i}?oc=5`;
const article = (i) => `https://www.nytimes.com/2026/10/19/theater/other-desert-cities-review-${i}.html`;
const feed = (n) => `<rss><channel>${Array.from({ length: n }, (_, i) => `<item><title>Other Desert Cities review ${i} - The New York Times</title><link>${link(i)}</link><pubDate>Mon, 19 Oct 2026 03:00:00 GMT</pubDate><source url="https://www.nytimes.com">The New York Times</source></item>`).join('')}</channel></rss>`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const quiet = { log: () => {} };

// A wrapper fetch that lands on the publisher after `delayMs`, the way Playwright's waitForSelector run does.
function slowWrappers(n, delayMs, seen = { inFlight: 0, maxInFlight: 0, calls: [] }) {
  const fetchText = async (url) => {
    if (url === FEED_URL) return feed(n);
    if (/rss\/search/.test(url)) return '<rss></rss>'; // the site:nysun.com search
    const m = url.match(/CBMiT(\d+)/);
    if (!m) throw new Error(`404 ${url}`);
    seen.calls.push(url);
    seen.inFlight++; seen.maxInFlight = Math.max(seen.maxInFlight, seen.inFlight);
    try { await sleep(delayMs); } finally { seen.inFlight--; }
    return { content: '', finalUrl: article(m[1]) };
  };
  return { fetchText, seen };
}
const pass = (adapter, fetchText, extra = {}) => d.runDiscoveryPass({ show: SHOW, night: NIGHT, now: T0 + 2 * HOUR, startedAt: T0, fetchText, adapters: [adapter], ...extra });

test('the adapter cap is longer than a Playwright unwrap (navigation + the scraper\'s 15 s selector wait)', () => {
  const a = d.googleNewsAdapter(quiet);
  assert.equal(a.fetchTimeoutMs, d.GOOGLE_NEWS_FETCH_TIMEOUT_MS);
  // Recorded unwraps settled at 17.9-18.5 s; the pass default is 15 s.
  assert.ok(a.fetchTimeoutMs >= 30000, `${a.fetchTimeoutMs}`);
});

test('a wrapper slower than the pass default cap still resolves under the adapter cap', async () => {
  const { fetchText } = slowWrappers(1, 120);
  // Pass default 50 ms stands in for 15 s; the adapter's own 400 ms stands in for 35 s.
  const r = await pass(d.googleNewsAdapter({ ...quiet, fetchTimeoutMs: 400 }), fetchText, { fetchTimeoutMs: 50 });
  assert.deepEqual(r.admitted.map((a) => a.url), [article(0)]);
});

test('wrappers are opened GOOGLE_NEWS_UNWRAP_CONCURRENCY at a time, so a full budget fits the pass', async () => {
  const { fetchText, seen } = slowWrappers(8, 80);
  const started = Date.now();
  const r = await pass(d.googleNewsAdapter({ ...quiet, fetchTimeoutMs: 1000 }), fetchText);
  const took = Date.now() - started;
  assert.equal(r.admitted.length, 8);
  assert.equal(seen.maxInFlight, d.GOOGLE_NEWS_UNWRAP_CONCURRENCY);
  assert.ok(took < 8 * 80, `took ${took} ms; one at a time would be at least 640`);
  // Output keeps feed order whichever wrapper came back first.
  assert.deepEqual(r.admitted.map((a) => a.url).sort(), Array.from({ length: 8 }, (_, i) => article(i)).sort());
});

test('a wrapper cut off by the pass deadline is no strike: it is opened again on later passes', async () => {
  const adapter = d.googleNewsAdapter({ ...quiet, fetchTimeoutMs: 1000 });
  const { fetchText, seen } = slowWrappers(1, 150);
  // Passes whose deadline stops the wrapper before its own cap, more of them than MAX_UNWRAP_TRIES (3). A pass whose
  // deadline is spent before the wrapper starts (first-pass module loading) does not open it at all.
  for (let i = 0; i < 6; i++) {
    const r = await pass(adapter, fetchText, { deadlineMs: 40 });
    assert.equal(r.admitted.length, 0);
  }
  assert.ok(seen.calls.length > 3, `opened ${seen.calls.length} times; struck, it would stop at 3`);
  const ok = await pass(adapter, fetchText);
  assert.deepEqual(ok.admitted.map((a) => a.url), [article(0)], 'still resolved once a pass has time');
});

test('a wrapper that fails on its own is still given up after three tries', async () => {
  const adapter = d.googleNewsAdapter({ ...quiet, fetchTimeoutMs: 1000 });
  let calls = 0;
  const fetchText = async (url) => { if (url === FEED_URL) return feed(1); if (!/CBMiT/.test(url)) return '<rss></rss>'; calls++; return { content: '<p>nothing</p>', finalUrl: null }; };
  for (let i = 0; i < 6; i++) await pass(adapter, fetchText);
  assert.equal(calls, 3);
});

test('each pass logs decoded and unwrapped counts, so a decoder Google refuses shows in the job log', async () => {
  const lines = [];
  const { fetchText } = slowWrappers(2, 1);
  await pass(d.googleNewsAdapter({ log: (m) => lines.push(m), decodeImpl: async () => null, fetchTimeoutMs: 1000 }), fetchText);
  assert.deepEqual(lines, ['  google-news: decoded 0/2, unwrapped 2/2 wrapper link(s)']);
});

test('a wrapper fetch that errors (not a deadline cut) is a strike', async () => {
  const adapter = d.googleNewsAdapter({ ...quiet, fetchTimeoutMs: 1000 });
  let calls = 0;
  const fetchText = async (url) => {
    if (url === FEED_URL) return feed(1);
    if (!/CBMiT/.test(url)) return '<rss></rss>';
    calls++; throw new Error('All scraping methods failed');
  };
  for (let i = 0; i < 6; i++) await pass(adapter, fetchText);
  assert.equal(calls, 3);
});
