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
  extractArticleText: (html) => (html.includes('<article>') ? 'A real review paragraph. '.repeat(60) : null),
  isNotFoundHtml: (html) => /page not found/i.test(html),
  listCaptureTimestamps: async () => ['20200101000000'],
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

test('ARCHIVE: empty (no capture) is evidence, unavailable (CDX down) is not; the candidate keeps the stored url', async () => {
  const none = await S.archive(c, deps({ listCaptureTimestamps: async () => [] }));
  assert.deepEqual(none, { ok: false, outcome: 'no_evidence', reason: 'archive_empty' });
  const down = await S.archive(c, deps({ listCaptureTimestamps: async (u, o) => { o.onError(new Error('CDX HTTP 503')); return []; } }));
  assert.equal(down.outcome, 'non_evidence');
  assert.match(down.reason, /^archive_unavailable/);
  const ok = await S.archive(c, deps({ listCaptureTimestamps: async () => ['20200101000000'] }));
  assert.equal(ok.ok, true);
  assert.equal(ok.url, c.url);
  assert.match(ok.via, /^archive:2020/);
});

// BRO-7171 Stage 3: the earliest capture of a paywalled article is often the
// teaser (a paragraph + "subscribe"). Accepting it would mark the gap
// recovered with a thin copy. Thin copies are skipped (same 1,000-char bar as
// archiveCopyDisposition, BRO-5874) and the next distinct capture is tried.
test('ARCHIVE: a thin earliest capture (teaser) is skipped for the next distinct capture', async () => {
  const fetched = [];
  const r = await S.archive(c, deps({
    listCaptureTimestamps: async () => ['20190101000000', '20210101000000'],
    fetchText: async (u) => { fetched.push(u); return u.includes('2019') ? '<html><article>teaser</article></html>' : ARTICLE; },
    extractArticleText: (html) => (html.includes('teaser') ? 'Opening paragraph only. Subscribe to read more.' : 'A real review paragraph. '.repeat(60)),
  }));
  assert.equal(r.ok, true);
  assert.match(r.via, /^archive:2021/);
  assert.equal(fetched.length, 2);
});

test('ARCHIVE: every capture thin is a rejection (evidence), every snapshot unreachable is not', async () => {
  const thin = await S.archive(c, deps({
    listCaptureTimestamps: async () => ['20190101000000', '20200101000000'],
    extractArticleText: () => 'Opening paragraph only. '.repeat(10),
  }));
  assert.deepEqual(thin, { ok: false, outcome: 'rejected', reason: 'archive_thin_copy' });
  const unreachable = await S.archive(c, deps({
    listCaptureTimestamps: async () => ['20190101000000'],
    fetchText: async () => { throw new Error('HTTP 503'); },
  }));
  assert.equal(unreachable.outcome, 'non_evidence');
  assert.match(unreachable.reason, /^archive_unavailable/);
  // one capture thin, the other unreachable: the unreachable one may be the full copy
  const mixed = await S.archive(c, deps({
    listCaptureTimestamps: async () => ['20190101000000', '20200101000000'],
    fetchText: async (u) => { if (u.includes('2020')) throw new Error('HTTP 503'); return ARTICLE; },
    extractArticleText: () => 'Opening paragraph only. '.repeat(10),
  }));
  assert.equal(mixed.outcome, 'non_evidence');
});

test('listCaptureTimestamps: earliest-first distinct captures, no hardcoded year bound', async () => {
  const { listCaptureTimestamps } = require('./fetch-archive-fallback.js');
  let asked = '';
  const ts = await listCaptureTimestamps('https://x.com/a', { limit: 3, fetchJson: async (u) => { asked = u; return [['timestamp'], ['20190101000000'], ['bad'], ['20240101000000']]; } });
  assert.deepEqual(ts, ['20190101000000', '20240101000000']);
  assert.match(asked, /collapse=digest/);
  assert.match(asked, /limit=3/);
  assert.doesNotMatch(asked, /[&?]to=/);
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
  // navigation failures and bot-checks are non-evidence even when the session is fine
  const okProbe = async () => ({ text: 'x'.repeat(900) });
  const nav = await S.browserSession(c, { extract: async () => { throw new Error('page.goto: Timeout 30000ms exceeded'); }, probe: okProbe });
  assert.equal(nav.outcome, 'non_evidence');
  assert.match(nav.reason, /^navigation_error/);
  const bot = await S.browserSession(c, { extract: async () => ({ error: 'Bot-check challenge detected' }), probe: okProbe });
  assert.deepEqual(bot, { ok: false, outcome: 'non_evidence', reason: 'bot_check' });
  // Stage 4: WSJ's DataDome label is a bot-check too
  const dd = await S.browserSession(c, { extract: async () => ({ error: 'DataDome challenge detected' }), probe: okProbe });
  assert.deepEqual(dd, { ok: false, outcome: 'non_evidence', reason: 'bot_check' });
  // Stage 4: a 404 to a logged-in session is evidence the url is dead, not a lost session
  let probed = false;
  const nf = await S.browserSession(c, { extract: async () => ({ error: 'HTTP 404 not found', notFound: true, status: 404 }), probe: async () => { probed = true; return { text: 'x'.repeat(900) }; } });
  assert.deepEqual(nf, { ok: false, outcome: 'no_evidence', reason: 'url_not_found_404' });
  assert.equal(probed, false);
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

// BRO-7171 weak-outlet audit: a hard 404/410 on the stored url lands on the
// record (httpStatus) so the classifier routes it to URL_DEAD; before, the
// evidence lived only in the engine ledger and the browser re-fetched it.
test('deadUrlStampPatch: stamps a hard 404/410 on the current url only', async () => {
  const rec = { url: c.url, contentTier: 'truncated', fullText: 'x'.repeat(182) };
  const nf = await S.browserSession(c, { extract: async () => ({ error: 'HTTP 404 not found', notFound: true, status: 404 }) });
  assert.deepEqual(S.deadUrlStampPatch(rec, { url: c.url, ...nf }), { httpStatus: 404 });
  const gone = await S.refetchFree(c, deps({ fetchPage: async () => { throw new Error('HTTP 404 Not Found'); } }));
  assert.equal(gone.outcome, 'no_evidence');
  assert.deepEqual(S.deadUrlStampPatch(rec, { url: c.url, ...gone }), { httpStatus: 404 }, JSON.stringify(gone));
  // not evidence / not a 404 / url moved since the fetch / complete text / already stamped
  assert.equal(S.deadUrlStampPatch(rec, { url: c.url, outcome: 'non_evidence', reason: 'soft_404' }), null);
  assert.equal(S.deadUrlStampPatch(rec, { url: c.url, outcome: 'no_evidence', reason: 'archive_empty' }), null);
  assert.equal(S.deadUrlStampPatch({ ...rec, url: 'https://example.com/moved' }, { url: c.url, outcome: 'no_evidence', reason: 'url_not_found_404' }), null);
  assert.equal(S.deadUrlStampPatch({ ...rec, contentTier: 'complete' }, { url: c.url, outcome: 'no_evidence', reason: 'url_not_found_404' }), null);
  assert.equal(S.deadUrlStampPatch({ ...rec, httpStatus: 404 }, { url: c.url, outcome: 'no_evidence', reason: 'url_not_found_404' }), null);
});

test('a stamped 404 classifies URL_DEAD and a url change clears it (url-bound)', () => {
  const { classifyTextGap } = require('./text-gap-classify.js');
  const { URL_DERIVED_FIELDS } = require('./url-change-invariant.js');
  const rec = { showId: 's-2025', outletId: 'washpost', url: c.url, contentTier: 'truncated', fullText: 'x'.repeat(182), source: 'web-search' };
  const stamped = { ...rec, ...S.deadUrlStampPatch(rec, { url: c.url, outcome: 'no_evidence', reason: 'url_not_found_404' }) };
  assert.equal(classifyTextGap(stamped, null, { nowMs: Date.parse('2026-11-09') }).gapClass, 'URL_DEAD');
  assert.ok(URL_DERIVED_FIELDS.includes('httpStatus'), 'httpStatus must be cleared by a url change');
});
