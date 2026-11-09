// BRO-7171 Stage 2: gap-strategies outcome mapping (evidence vs non-evidence),
// with every network dependency stubbed. Run: node --test scripts/lib/gap-strategies.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const S = require('./gap-strategies.js');
const { earliestCaptureTimestamp, latestCaptureTimestamp } = require('./fetch-archive-fallback.js');

const ARTICLE = '<html><body><article>' + '<p>A real review paragraph about the show.</p>'.repeat(20) + '</article></body></html>';
const deps = (o = {}) => ({
  fetchPage: async () => ({ content: ARTICLE, source: 'cookies-plain' }),
  extractArticleText: (html) => (html.includes('<article>') ? 'A real review paragraph. '.repeat(30) : null),
  isNotFoundHtml: (html) => /page not found/i.test(html),
  earliestCaptureTimestamp: async () => '20200101000000',
  archiveSnapshotFetchUrl: (u, ts) => `https://web.archive.org/web/${ts}id_/${u}`,
  fetchText: async () => ARTICLE,
  discoverCorrectUrl: async () => 'https://example.com/new-review',
  ...o,
});
const c = { url: 'https://example.com/review', showId: 's-2025', outletId: 'x', criticName: 'A B' };

test('REFETCH_FREE asks fetchPage for the free tiers only', async () => {
  let opts;
  const r = await S.refetchFree(c, deps({ fetchPage: async (u, o) => { opts = o; return { content: ARTICLE, source: 'playwright-first' }; } }));
  assert.equal(r.ok, true);
  assert.deepEqual(opts.tiers, ['cookies-plain', 'playwright-first', 'playwright-last']);
});

test('fetch errors map through failed-fetch-policy: 404 is evidence, budget cap is not', async () => {
  const dead = await S.refetchFree(c, deps({ fetchPage: async () => { throw new Error('HTTP 404'); } }));
  assert.deepEqual(dead, { ok: false, outcome: 'no_evidence', reason: 'url_dead_404' });
  assert.equal(S.outcomeForFetchError('All tiers failed').outcome, 'no_evidence');
});

test('soft-404 template is non-evidence; an unextractable page is a rejection', async () => {
  const soft = await S.refetchFree(c, deps({ fetchPage: async () => ({ content: '<html>Page not found</html>' }) }));
  assert.deepEqual(soft, { ok: false, outcome: 'non_evidence', reason: 'soft_404' });
  const nul = await S.refetchFree(c, deps({ fetchPage: async () => ({ content: '<html><div>nav</div></html>' }) }));
  assert.equal(nul.outcome, 'rejected');
});

test('ARCHIVE: no capture is evidence, CDX down is not; the candidate keeps the stored url', async () => {
  const none = await S.archive(c, deps({ earliestCaptureTimestamp: async () => null }));
  assert.deepEqual(none, { ok: false, outcome: 'no_evidence', reason: 'no_snapshot' });
  const down = await S.archive(c, deps({ earliestCaptureTimestamp: async (u, o) => { o.onError(new Error('CDX HTTP 503')); return null; } }));
  assert.equal(down.outcome, 'non_evidence');
  const ok = await S.archive(c, deps());
  assert.equal(ok.ok, true);
  assert.equal(ok.url, c.url);
  assert.match(ok.via, /^archive:2020/);
});

test('earliest vs latest CDX capture', async () => {
  const rows = [['timestamp'], ['20190101000000'], ['20240101000000']];
  assert.equal(await earliestCaptureTimestamp('https://x.com/a', { fetchJson: async () => rows }), '20190101000000');
  assert.equal(await latestCaptureTimestamp('https://x.com/a', { fetchJson: async () => rows }), '20240101000000');
  let err = null;
  assert.equal(await earliestCaptureTimestamp('https://x.com/a', { fetchJson: async () => { throw new Error('down'); }, onError: (e) => { err = e; } }), null);
  assert.equal(err.message, 'down');
});

test('BROWSER_SESSION: a lost session is auth_failed (non-evidence), not a rejection', async () => {
  const lost = await S.browserSession(c, { extract: async () => ({ error: 'No article body' }), probe: async () => ({ error: 'logged out' }) });
  assert.equal(lost.outcome, 'auth_failed');
  const nul = await S.browserSession(c, { extract: async () => ({ error: 'No article body' }), probe: async () => ({ text: 'x'.repeat(900) }) });
  assert.deepEqual(nul, { ok: false, outcome: 'rejected', reason: 'extractor_null' });
  assert.equal((await S.browserSession(c, null)).outcome, 'browser_unavailable');
});

test('URL_REDISCOVER: unavailable SERP is non-evidence and does not spend the file budget; a miss does', async () => {
  const keys = { brightDataKey: 'k' };
  assert.deepEqual(await S.urlRediscover(c, {}, deps()), { ok: false, outcome: 'non_evidence', reason: 'no_serp_key', serpRan: false });
  const un = await S.urlRediscover(c, keys, deps({ discoverCorrectUrl: async () => '__SERP_UNAVAILABLE__' }));
  assert.deepEqual(un, { ok: false, outcome: 'non_evidence', reason: 'serp_unavailable', serpRan: false });
  const miss = await S.urlRediscover(c, keys, deps({ discoverCorrectUrl: async () => null }));
  assert.equal(miss.outcome, 'no_evidence');
  assert.equal(miss.serpRan, true);
  const same = await S.urlRediscover(c, keys, deps({ discoverCorrectUrl: async () => c.url }));
  assert.equal(same.reason, 'serp_returned_same_url');
  const hit = await S.urlRediscover(c, keys, deps());
  assert.equal(hit.ok, true);
  assert.equal(hit.url, 'https://example.com/new-review');
});
