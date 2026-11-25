// BRO-7171 Stage 2: gap-strategies outcome mapping (evidence vs non-evidence),
// with every network dependency stubbed. Run: node --test scripts/lib/gap-strategies.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// BRO-7171 2026-11-16: zero free tiers for the host -> no request, no evidence,
// and the table skips the free refetch and keeps the capped paid fetch.
import { test as _t0 } from 'node:test';
import _a0 from 'node:assert/strict';
import { createRequire as _cr0 } from 'node:module';

// BRO-7962: a bot check or a declared paywall is "no access" on the route, never
// proof the LINK is wrong. The correct Times link for a NO_URL review was
// refused this way (trial 2026-11-21) and skipped by every later night.
import { test as _t62 } from 'node:test';
import _a62 from 'node:assert/strict';
import { createRequire as _cr62 } from 'node:module';

const require = createRequire(import.meta.url);
// BRO-8107: the shared guards this reaches read shows from a fixture, not the live
// data/shows.json, so this test stays in test.yml's blocking batch.
process.on('exit', require('./shows-json-fixture.js').useShowsFixture([]));
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
  assert.deepEqual(dead, { ok: false, outcome: 'no_evidence', reason: 'url_dead_404', error: 'HTTP 404', httpStatus: 404 }); // BRO-7944 diagnostics
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

test('BROWSER_SESSION: an access wall or a short body from a dead session is never too-short evidence (BRO-7171)', async () => {
  const okProbe = async () => ({ text: 'x'.repeat(900) });
  const deadProbe = async () => ({ error: 'access wall (sign-in/registration) in place of the body', authWall: true });
  const wall = { error: 'access wall (sign-in/registration) in place of the body', authWall: true };
  assert.equal((await S.browserSession(c, { extract: async () => wall, probe: deadProbe, minAuthChars: 500 })).outcome, 'auth_failed');
  assert.deepEqual(await S.browserSession(c, { extract: async () => wall, probe: okProbe, minAuthChars: 500 }), { ok: false, outcome: 'non_evidence', reason: 'access_wall' });
  // 74-char body (a wall or error template read as text): probe first.
  const tiny = { text: 'Sign in to continue reading this article on our website today please.', len: 70 };
  assert.equal((await S.browserSession(c, { extract: async () => tiny, probe: deadProbe, minAuthChars: 500 })).outcome, 'auth_failed');
  const passed = await S.browserSession(c, { extract: async () => tiny, probe: okProbe, minAuthChars: 500 });
  assert.equal(passed.ok, true, 'live session: the short body goes to the acceptance gate');
  // A probe below the adapter floor is a lost session too.
  assert.equal((await S.browserSession(c, { extract: async () => ({ error: 'No article body' }), probe: async () => ({ text: 'x'.repeat(100) }), minAuthChars: 500 })).outcome, 'auth_failed');
  // A full body never probes.
  let probed = false;
  const full = await S.browserSession(c, { extract: async () => ({ text: 'y'.repeat(3000) }), probe: async () => { probed = true; return {}; }, minAuthChars: 500 });
  assert.equal(full.ok, true);
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

// URL_FIND candidate loop (review 2026-11-10): a method is only "done" when
// its links were refused on evidence; unreadable links are kept, not written off.
test('urlFind: timeouts stay open, unreadable links are kept, slots skip old refusals, Bright Data skipped on dead links', async () => {
  const fs = require('fs'); const os = require('os'); const path = require('path');
  const UF = require('./gap-url-find.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'urlfind-'));
  fs.mkdirSync(path.join(tmp, 'julie-west-end-2018'));
  const fp = path.join(tmp, 'julie-west-end-2018', 'telegraph--x.json');
  fs.writeFileSync(fp, JSON.stringify({ showId: 'julie-west-end-2018', outletId: 'telegraph', criticName: 'X Y', url: null, fullText: 'short' }));
  const root = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..');
  const orig = { runMethod: UF.runMethod, fetchCandidateText: UF.fetchCandidateText };
  const cands = { AGG_LINK: ['https://t.co.uk/a1'], OUTLET_SITEMAP: ['https://t.co.uk/b1'], WAYBACK_CDX: ['https://t.co.uk/old', 'https://t.co.uk/c1', 'https://t.co.uk/c2', 'https://t.co.uk/c3', 'https://t.co.uk/c4'], SLUG_GUESS: ['https://t.co.uk/d1'] };
  UF.runMethod = async (m) => ({ candidates: (cands[m] || []).map((url) => ({ url })), tried: [], error: null });
  const fetched = [];
  UF.fetchCandidateText = async (url) => {
    fetched.push(url);
    if (url.endsWith('a1')) return { ok: false, tried: ['free:no_evidence/all_tiers_timeout', 'wayback:no_evidence/archive_empty'] };
    if (url.endsWith('d1')) return { ok: false, tried: ['free:no_evidence/url_dead_404', 'wayback:no_evidence/archive_empty'] };
    return { ok: true, rawText: 'text', html: '<h1>x</h1>', tried: ['free:ok 4'], via: 'free' };
  };
  const gate = async ({ url }) => (url.endsWith('b1') ? { ok: false, code: 'paywall' } : { ok: false, code: 'identity_unproven' });
  try {
    const r = await S.urlFind({ filePath: fp, showId: 'julie-west-end-2018' }, { dir: tmp, rootDir: root, refusedUrls: new Set(['https://t.co.uk/old']), methods: ['AGG_LINK', 'OUTLET_SITEMAP', 'WAYBACK_CDX', 'SLUG_GUESS'] }, { gate });
    assert.equal(r.methods.AGG_LINK, 'error'); // a timeout is not a refusal
    assert.equal(r.methods.OUTLET_SITEMAP, 'found_unreadable'); // paywalled link is found, not "not findable"
    assert.deepEqual(r.foundUnreadable, [{ url: 'https://t.co.uk/b1', code: 'paywall', method: 'OUTLET_SITEMAP' }]);
    assert.equal(r.methods.WAYBACK_CDX, 'more_candidates'); // 4 fresh links, 3 tried: not done
    assert.ok(!fetched.includes('https://t.co.uk/old')); // an old refusal does not use a slot
    assert.ok(fetched.includes('https://t.co.uk/c3') && !fetched.includes('https://t.co.uk/c4'));
    assert.equal(r.methods.SLUG_GUESS, 'candidates_refused'); // a 404 + no capture is evidence
    assert.ok(r.refusedCandidates.includes('https://t.co.uk/d1'));
    assert.equal(r.reason, 'url_found_unreadable');
  } finally { Object.assign(UF, orig); fs.rmSync(tmp, { recursive: true, force: true }); }
  // Bright Data is not paid for a link the free fetch proved dead
  let bd = 0;
  const d = deps({ fetchPage: async (u, o) => { if (o && o.tiers && o.tiers[0] === 'brightdata') { bd++; return { content: ARTICLE }; } throw new Error('HTTP 404'); }, listCaptureTimestamps: async () => [] });
  const got = await UF.fetchCandidateText('https://t.co.uk/dead', { allowBd: true }, d);
  assert.equal(bd, 0, JSON.stringify(got.tried));
  assert.equal(UF.fetchRefusedOnEvidence(got.tried), true);
  assert.equal(UF.fetchRefusedOnEvidence(['free:no_evidence/all_tiers_timeout', 'wayback:no_evidence/archive_empty']), false);
  // production classes a timeout and a 403 as no_evidence: neither is an answer about the page (ship-check P1)
  assert.equal(UF.fetchRefusedOnEvidence(['free:no_evidence/fetch_error', 'wayback:no_evidence/archive_empty']), false);
  assert.equal(UF.fetchRefusedOnEvidence(['free:no_evidence/url_dead_410', 'wayback:rejected/archive_thin_copy']), true);
});

// BRO-7986 ship-check: a pinned record refuses every non-variant link; the
// method must finish (refused), not stay open as "found but unreadable".
test('urlFind: a url_pinned link is refused for the record and finishes the method', async () => {
  const fs = require('fs'); const os = require('os'); const path = require('path');
  const UF = require('./gap-url-find.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'urlfind-'));
  fs.mkdirSync(path.join(tmp, 'julie-west-end-2018'));
  const fp = path.join(tmp, 'julie-west-end-2018', 'telegraph--x.json');
  fs.writeFileSync(fp, JSON.stringify({ showId: 'julie-west-end-2018', outletId: 'telegraph', criticName: 'X Y', url: 'https://t.co.uk/pinned', urlVerified: true, fullText: 'short' }));
  const root = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..');
  const orig = { runMethod: UF.runMethod, fetchCandidateText: UF.fetchCandidateText };
  UF.runMethod = async () => ({ candidates: [{ url: 'https://t.co.uk/s1' }], tried: [], error: null });
  UF.fetchCandidateText = async () => ({ ok: true, rawText: 'text', html: '<h1>x</h1>', tried: ['free:ok 4'], via: 'free' });
  try {
    const r = await S.urlFind({ filePath: fp, showId: 'julie-west-end-2018' }, { dir: tmp, rootDir: root, methods: ['SLUG_GUESS'] }, { gate: async () => ({ ok: false, code: 'url_pinned' }) });
    assert.equal(r.ok, false);
    assert.equal(r.methods.SLUG_GUESS, 'candidates_refused');
    assert.ok((r.refusedCandidates || []).includes('https://t.co.uk/s1'));
    assert.equal((r.foundUnreadable || []).length, 0);
  } finally { Object.assign(UF, orig); fs.rmSync(tmp, { recursive: true, force: true }); }
});

// Ship-check P1: a query that errored left part of the index unsearched, so
// refusing what the other queries found must not finish the method.
test('urlFind: a partial index error keeps the method open even when its found links are refused', async () => {
  const fs = require('fs'); const os = require('os'); const path = require('path');
  const UF = require('./gap-url-find.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'urlfind-'));
  fs.mkdirSync(path.join(tmp, 'julie-west-end-2018'));
  const fp = path.join(tmp, 'julie-west-end-2018', 'telegraph--x.json');
  fs.writeFileSync(fp, JSON.stringify({ showId: 'julie-west-end-2018', outletId: 'telegraph', criticName: 'X Y', url: null, fullText: 'short' }));
  const root = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..');
  const orig = { runMethod: UF.runMethod, fetchCandidateText: UF.fetchCandidateText };
  UF.runMethod = async (m) => (m === 'WAYBACK_CDX'
    ? { candidates: [{ url: 'https://t.co.uk/w1' }], tried: [], error: 'WAYBACK_CDX partial: 1/2 queries failed' }
    : { candidates: [{ url: 'https://t.co.uk/s1' }], tried: [], error: null });
  UF.fetchCandidateText = async () => ({ ok: true, rawText: 'text', html: '<h1>x</h1>', tried: ['free:ok 4'], via: 'free' });
  try {
    const r = await S.urlFind({ filePath: fp, showId: 'julie-west-end-2018' }, { dir: tmp, rootDir: root, methods: ['WAYBACK_CDX', 'SLUG_GUESS'] }, { gate: async () => ({ ok: false, code: 'identity_unproven' }) });
    assert.equal(r.methods.WAYBACK_CDX, 'error');
    assert.equal(r.methods.SLUG_GUESS, 'candidates_refused');
  } finally { Object.assign(UF, orig); fs.rmSync(tmp, { recursive: true, force: true }); }
});

// BRO-7171 item (c): a free-only URL_FIND slot never spends paid SERP or a
// Bright Data fetch, and the skipped SERP stays open (skipped_paid is not done).
test('urlFind freeOnly: no paid SERP, no Bright Data, SERP left open', async () => {
  const fs = require('fs'); const os = require('os'); const path = require('path');
  const UF = require('./gap-url-find.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'urlfind-'));
  fs.mkdirSync(path.join(tmp, 'julie-west-end-2018'));
  const fp = path.join(tmp, 'julie-west-end-2018', 'telegraph--x.json');
  fs.writeFileSync(fp, JSON.stringify({ showId: 'julie-west-end-2018', outletId: 'telegraph', criticName: 'X Y', url: null, fullText: 'short' }));
  const root = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..');
  const orig = { runMethod: UF.runMethod, fetchCandidateText: UF.fetchCandidateText };
  const ran = [];
  const allowBd = [];
  UF.runMethod = async (m, ctx) => { ran.push(`${m}:${ctx.allowPaid}`); return { candidates: m === 'WAYBACK_CDX' ? [{ url: 'https://t.co.uk/w1' }] : [], tried: [], error: null, paid: m === 'SERP' }; };
  UF.fetchCandidateText = async (url, o) => { allowBd.push(o.allowBd); return { ok: false, tried: ['free:no_evidence/url_dead_404', 'wayback:no_evidence/archive_empty'] }; };
  try {
    const r = await S.urlFind({ filePath: fp, showId: 'julie-west-end-2018' }, { dir: tmp, rootDir: root, methods: ['WAYBACK_CDX', 'SERP'], freeOnly: true }, { gate: async () => ({ ok: false, code: 'identity_unproven' }) });
    assert.equal(r.methods.SERP, 'skipped_paid');
    assert.ok(!ran.some((x) => x.startsWith('SERP')), JSON.stringify(ran));
    assert.deepEqual(allowBd, [false]);
    assert.ok(!UF.METHOD_DONE.has('skipped_paid'));
  } finally { Object.assign(UF, orig); fs.rmSync(tmp, { recursive: true, force: true }); }
});
{
  const req = _cr0(import.meta.url);
  const S = req('./gap-strategies.js');
  const { selectStrategy } = req('./gap-strategy-table.js');
  const { freeTiersForUrl } = req('./scraper.js');
  _t0('refetchFree: zero free tiers -> non_evidence no_free_tier, fetchPage never called', async () => {
    let called = 0;
    const deps = { freeTiersForUrl: () => [], fetchPage: async () => { called++; return { content: '<p>x</p>' }; } };
    const r = await S.refetchFree({ url: 'https://www.broadwayworld.com/a' }, deps);
    _a0.deepEqual([r.outcome, r.reason, called], ['non_evidence', 'no_free_tier', 0]);
  });
  // BRO-8092 cousin: URL_REDISCOVER fetches the SERP's url through the same free-only fetch; a
  // url no free tier can fetch (BroadwayWorld) made zero requests and its fetch_error read as evidence.
  _t0('urlRediscover: a found url with zero free tiers -> non_evidence no_free_tier, fetchPage never called (BRO-8092)', async () => {
    let called = 0;
    const deps = {
      freeTiersForUrl: () => [],
      fetchPage: async () => { called++; throw new Error('no tiers ran'); },
      discoverCorrectUrl: async () => 'https://www.broadwayworld.com/article/Review-Roundup-Example-20260301',
    };
    const r = await S.urlRediscover({ showId: 's', outletId: 'bww', url: '' }, { scrapingBeeKey: 'k' }, deps);
    _a0.deepEqual([r.outcome, r.reason, called, r.serpRan], ['non_evidence', 'no_free_tier', 0, true]);
  });
  _t0('selectStrategy: no free tier skips REFETCH_FREE and falls to PAID_FETCH last', () => {
    const r = selectStrategy({ gapClass: 'TRUNCATED_OTHER', hasUrl: true, hasAdapter: false, freeTierOk: false, recency: 'recent', showAgeDays: 10 });
    _a0.equal(r.strategy, 'PAID_FETCH');
    _a0.ok(r.skipped.some((k) => k.strategy === 'REFETCH_FREE' && k.reason === 'no_free_tier'));
    // default (free tier available) is unchanged
    _a0.equal(selectStrategy({ gapClass: 'TRUNCATED_OTHER', hasUrl: true, hasAdapter: false, recency: 'recent', showAgeDays: 10 }).strategy, 'REFETCH_FREE');
  });
  _t0('freeTiersForUrl: BroadwayWorld has no free tier (Playwright tier-skipped, no cookie jar)', () => {
    _a0.deepEqual(freeTiersForUrl('https://www.broadwayworld.com/westend/article/Review-X-20261027'), []);
    _a0.ok(freeTiersForUrl('https://example-theatre-blog.com/review/').length > 0);
  });
}

// BRO-7171 ship-check: the paid route can make zero requests too.
{
  const req = _cr0(import.meta.url);
  const S = req('./gap-strategies.js');
  const { selectStrategy } = req('./gap-strategy-table.js');
  _t0('paidFetch: Bright Data unavailable for the host -> non_evidence no_paid_tier, no fetch', async () => {
    let called = 0;
    const r = await S.paidFetch({ url: 'https://broadway.news/x' }, { paidTierAvailable: () => false, fetchPage: async () => { called++; } });
    _a0.deepEqual([r.outcome, r.reason, called], ['non_evidence', 'no_paid_tier', 0]);
  });
  _t0('paidFetch: budget withheld this request -> non_evidence budget_capped', async () => {
    let blocked = 3;
    const deps = { paidTierAvailable: () => true, bdBlockedCount: () => blocked, fetchPage: async () => { blocked++; throw new Error('All scraping methods failed'); } };
    const r = await S.paidFetch({ url: 'https://www.broadwayworld.com/a' }, deps);
    _a0.deepEqual([r.outcome, r.reason], ['non_evidence', 'budget_capped']);
    // a real failure (nothing withheld) is still evidence
    const r2 = await S.paidFetch({ url: 'https://www.broadwayworld.com/a' }, { ...deps, fetchPage: async () => { throw new Error('All scraping methods failed'); } });
    _a0.equal(r2.outcome, 'no_evidence');
  });
  _t0('selectStrategy: no free AND no paid tier -> neither planned', () => {
    const r = selectStrategy({ gapClass: 'TRUNCATED_OTHER', hasUrl: true, hasAdapter: false, freeTierOk: false, paidTierOk: false, recency: 'recent', showAgeDays: 10 });
    // neither url route can run; BRO-7943: the only route left is finding the real url
    _a0.equal(r.strategy, 'URL_FIND');
    _a0.ok(r.skipped.some((k) => k.strategy === 'PAID_FETCH' && k.reason === 'no_paid_tier'));
    const p = selectStrategy({ gapClass: 'PAYWALL_TRUNCATED', hasUrl: true, hasAdapter: false, paidTierOk: false, recency: 'recent', showAgeDays: 10, eligible: (s) => ({ ok: s === 'PAID_FETCH', reason: 'x' }) });
    _a0.ok(p.skipped.some((k) => k.strategy === 'PAID_FETCH' && k.reason === 'no_paid_tier'));
  });
}

// BRO-7702: a row with no stored url, or a garbage page whose refetch was
// abandoned, used to get NO route and sat unattempted past the floor guard's
// stale window. URL_FIND (needs no url) is now its last route.
{
  const req = _cr0(import.meta.url);
  const { selectStrategy } = req('./gap-strategy-table.js');
  _t0('selectStrategy: GARBAGE_PAGE with no url -> URL_FIND', () => {
    const r = selectStrategy({ gapClass: 'GARBAGE_PAGE', hasUrl: false, hasAdapter: false, recency: 'recent', showAgeDays: 10 });
    _a0.equal(r.strategy, 'URL_FIND');
  });
  _t0('selectStrategy: GARBAGE_PAGE with an abandoned stored url -> URL_FIND', () => {
    const r = selectStrategy({ gapClass: 'GARBAGE_PAGE', hasUrl: true, hasAdapter: false, recency: 'recent', showAgeDays: 10, eligible: (s) => (s === 'REFETCH_FREE' ? { ok: false, reason: 'abandoned' } : { ok: true, reason: 'ok' }) });
    _a0.equal(r.strategy, 'URL_FIND');
  });
  _t0('selectStrategy: any routed class with no url falls back to URL_FIND; unrouted classes stay unrouted', () => {
    for (const gapClass of ['TRUNCATED_OTHER', 'SHORT_UNVERIFIED', 'BLOCKED', 'PAYWALL_PAGE']) {
      _a0.equal(selectStrategy({ gapClass, hasUrl: false, hasAdapter: false, recency: 'recent', showAgeDays: 10 }).strategy, 'URL_FIND', gapClass);
    }
    _a0.equal(selectStrategy({ gapClass: 'UNCLASSIFIED', hasUrl: false, hasAdapter: false, recency: 'recent', showAgeDays: 10 }).strategy, null);
    // a url-holding truncated row keeps its refetch route
    _a0.equal(selectStrategy({ gapClass: 'TRUNCATED_OTHER', hasUrl: true, hasAdapter: false, recency: 'recent', showAgeDays: 10 }).strategy, 'REFETCH_FREE');
  });
}
{
  const req = _cr62(import.meta.url);
  const S = req('./gap-strategies.js');
  const UF = req('./gap-url-find.js');
  const TIMES_CHALLENGE = '<!DOCTYPE html><html><head><title>Verifying Device</title><link rel="stylesheet" href="https://p.toadmash.net/toadmash-1.0.11.css"></head><body>Verifying your device, please wait</body></html>';
  const PAYWALLED = '<html><head><title>Under the Shadow review</title><script type="application/ld+json">{"@type":"NewsArticle","isAccessibleForFree":"False"}</script></head><body><p>Subscribe</p></body></html>';
  const d62 = { isNotFoundHtml: () => false, extractArticleText: () => null };

  _t62('fromHtml: bot check and declared paywall keep outcome rejected but name the reason', () => {
    _a62.deepEqual(S.fromHtml(TIMES_CHALLENGE, 'https://www.thetimes.com/a', 'free', d62), { ok: false, outcome: 'rejected', reason: 'bot_challenge' });
    _a62.deepEqual(S.fromHtml(PAYWALLED, 'https://www.thetimes.com/a', 'free', d62), { ok: false, outcome: 'rejected', reason: 'paywalled' });
    _a62.equal(S.fromHtml(PAYWALLED.replace('"False"', 'false'), 'https://x/a', 'free', d62).reason, 'paywalled');
    _a62.equal(S.fromHtml('<html><body>nav only</body></html>', 'https://x/a', 'free', d62).reason, 'extractor_null');
    // a free page that declares itself free is not walled
    _a62.equal(S.fromHtml(PAYWALLED.replace('"False"', 'true'), 'https://x/a', 'free', d62).reason, 'extractor_null');
  });

  _t62('fetchRefusedOnEvidence: walled answers are not evidence about the link', () => {
    _a62.equal(UF.fetchRefusedOnEvidence(['free:rejected/bot_challenge', 'wayback:rejected/extractor_null', 'brightdata:rejected/paywalled']), false);
    _a62.equal(UF.fetchRefusedOnEvidence(['free:rejected/extractor_null', 'wayback:rejected/extractor_null']), true);
    _a62.equal(UF.walledFetchReason(['free:rejected/extractor_null', 'brightdata:rejected/paywalled']), 'paywalled');
    _a62.equal(UF.walledFetchReason(['free:rejected/extractor_null']), null);
  });

  _t62('fetchCandidateText on the real trial shape: challenge free, paywalled paid -> walled, not refused', async () => {
    const deps = { ...d62, fetchPage: async (u, o) => ({ content: o && o.tiers && o.tiers[0] === 'brightdata' ? PAYWALLED : TIMES_CHALLENGE, source: 'x' }), listCaptureTimestamps: async () => [] };
    const got = await UF.fetchCandidateText('https://www.thetimes.com/a', { allowBd: true }, deps);
    _a62.equal(got.ok, false);
    _a62.equal(UF.fetchRefusedOnEvidence(got.tried), false, JSON.stringify(got.tried));
    _a62.equal(UF.walledFetchReason(got.tried), 'bot_challenge');
  });

  _t62('urlFind: a walled link is found_unreadable (with its method), never refusedCandidates', async () => {
    const fs = req('fs'); const os = req('os'); const path = req('path');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'urlfind62-'));
    fs.mkdirSync(path.join(tmp, 'julie-west-end-2018'));
    const fp = path.join(tmp, 'julie-west-end-2018', 'times-uk--x.json');
    fs.writeFileSync(fp, JSON.stringify({ showId: 'julie-west-end-2018', outletId: 'times-uk', criticName: 'X Y', url: null, fullText: 'short' }));
    const root = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..');
    const orig = { runMethod: UF.runMethod, fetchCandidateText: UF.fetchCandidateText };
    UF.runMethod = async (m) => ({ candidates: m === 'SLUG_GUESS' ? [{ url: 'https://www.thetimes.com/w1' }, { url: 'https://www.thetimes.com/gone' }] : [], tried: [], error: null });
    UF.fetchCandidateText = async (url) => (url.endsWith('w1')
      ? { ok: false, tried: ['free:rejected/bot_challenge', 'wayback:no_evidence/archive_empty'] }
      : { ok: false, tried: ['free:no_evidence/url_dead_404', 'wayback:no_evidence/archive_empty'] });
    try {
      const r = await S.urlFind({ filePath: fp, showId: 'julie-west-end-2018' }, { dir: tmp, rootDir: root, methods: ['SLUG_GUESS'] }, { gate: async () => ({ ok: false, code: 'identity_unproven' }) });
      _a62.deepEqual(r.foundUnreadable, [{ url: 'https://www.thetimes.com/w1', code: 'bot_challenge', method: 'SLUG_GUESS' }]);
      _a62.deepEqual(r.refusedCandidates, ['https://www.thetimes.com/gone']); // a dead link is still refused
      _a62.equal(r.methods.SLUG_GUESS, 'found_unreadable');
      _a62.ok(!UF.METHOD_DONE.has(r.methods.SLUG_GUESS));
      _a62.deepEqual(r.methodsIfWalledRefused, { SLUG_GUESS: 'candidates_refused' }); // everything else in it was refused on evidence
      const dead = UF.applyWalledBrowserResult(r, r.foundUnreadable[0], { outcome: 'no_evidence', reason: 'url_not_found_404' });
      _a62.equal(dead.methods.SLUG_GUESS, 'candidates_refused');
    } finally { Object.assign(UF, orig); fs.rmSync(tmp, { recursive: true, force: true }); }
  });

  _t62('urlFind review: a browser 404 on the walled link never marks a method done that had a timed-out sibling, more links, or a second unreadable link', async () => {
    const fs = req('fs'); const os = req('os'); const path = req('path');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'urlfind62b-'));
    fs.mkdirSync(path.join(tmp, 'julie-west-end-2018'));
    const fp = path.join(tmp, 'julie-west-end-2018', 'times-uk--x.json');
    fs.writeFileSync(fp, JSON.stringify({ showId: 'julie-west-end-2018', outletId: 'times-uk', criticName: 'X Y', url: null, fullText: 'short' }));
    const root = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..');
    const orig = { runMethod: UF.runMethod, fetchCandidateText: UF.fetchCandidateText };
    const cands = {
      SLUG_GUESS: ['w1', 'slow'], // walled + timed out
      SERP: ['w2', 'a', 'b', 'c'], // walled + more than the per-method slots
      WAYBACK_CDX: ['w3', 'short'], // walled + a too-short page (gate path)
    };
    UF.runMethod = async (m) => ({ candidates: (cands[m] || []).map((x) => ({ url: `https://www.thetimes.com/${x}` })), tried: [], error: null });
    UF.fetchCandidateText = async (url) => (/\/w\d$/.test(url) ? { ok: false, tried: ['free:rejected/bot_challenge'] }
      : url.endsWith('slow') ? { ok: false, tried: ['free:error/timeout'] }
      : url.endsWith('short') ? { ok: true, rawText: 'tiny', html: '<html></html>', via: 'free' }
      : { ok: false, tried: ['free:no_evidence/url_dead_404'] });
    try {
      const r = await S.urlFind({ filePath: fp, showId: 'julie-west-end-2018' }, { dir: tmp, rootDir: root, methods: ['SLUG_GUESS', 'SERP', 'WAYBACK_CDX'], serpKeys: { x: 1 } }, { gate: async () => ({ ok: false, code: 'too_short' }) });
      _a62.ok(r.foundUnreadable.every((u) => u.method), 'every unreadable link carries its method');
      let g = r;
      for (const w of r.foundUnreadable.filter((u) => /\/w\d$/.test(u.url))) g = UF.applyWalledBrowserResult(g, w, { outcome: 'no_evidence', reason: 'url_not_found_404' });
      _a62.equal(g.methods.SLUG_GUESS, 'error');
      if (r.methods.SERP !== 'skipped_paid') _a62.equal(g.methods.SERP, 'more_candidates');
      _a62.equal(g.methods.WAYBACK_CDX, 'found_unreadable');
      for (const m of ['SLUG_GUESS', 'WAYBACK_CDX']) _a62.ok(!UF.METHOD_DONE.has(g.methods[m]), m);
      _a62.notEqual(g.reason, 'url_not_found_all_methods');
      // a fold without the record never guesses done
      const bare = UF.applyWalledBrowserResult({ ...r, methodsIfWalledRefused: undefined }, r.foundUnreadable[0], { outcome: 'no_evidence', reason: 'url_not_found_404' });
      _a62.equal(bare.methods[r.foundUnreadable[0].method], 'found_unreadable');
    } finally { Object.assign(UF, orig); fs.rmSync(tmp, { recursive: true, force: true }); }
  });

  _t62('pre-fix refusals are not trusted: links and candidates_refused statuses reopen, post-fix ones hold', () => {
    const old = { strategy: 'URL_FIND', outcome: 'no_evidence', ts: '2026-11-20T00:00:00Z', detail: { policy: UF.URL_FIND_POLICY, methods: { SERP: 'candidates_refused', SLUG_GUESS: 'no_candidates' }, refusedCandidates: ['https://www.thetimes.com/right'] } };
    _a62.equal(UF.refusedUrlsFromRows([old]).size, 0);
    const prog = UF.urlFindProgress([old]);
    _a62.ok(prog.missing.includes('SERP'), 'old candidates_refused reopens');
    _a62.ok(!prog.missing.includes('SLUG_GUESS'), 'old no_candidates still done');
    const fresh = { ...old, detail: { ...old.detail, refusalPolicy: UF.REFUSAL_POLICY } };
    _a62.deepEqual([...UF.refusedUrlsFromRows([fresh])], ['https://www.thetimes.com/right']);
    _a62.ok(!UF.urlFindProgress([fresh]).missing.includes('SERP'));
    // a gate refusal of a READ link (outcome rejected + url) stays refused whatever the policy
    _a62.deepEqual([...UF.refusedUrlsFromRows([{ strategy: 'URL_FIND', outcome: 'rejected', reason: 'wrong_article', url: 'https://x/read' }])], ['https://x/read']);
  });

  _t62('class guard: every fetch tier that accepts a page runs the challenge check first (scraper.js)', () => {
    const fs = req('fs'); const path = req('path');
    const src = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), 'scraper.js'), 'utf8');
    const start = src.indexOf('const tiers = {');
    _a62.ok(start > 0, 'tiers object not found');
    const body = src.slice(start, src.indexOf('\n  };', start));
    const parts = body.split(/\n    '?([a-z-]+)'?: async/).slice(1);
    const missing = [];
    for (let i = 0; i < parts.length; i += 2) if (/_checkAndReturn\(/.test(parts[i + 1]) && !/(?:_isChallengeOrGarbage|challengeSeen)\(/.test(parts[i + 1])) missing.push(parts[i]);
    _a62.ok(parts.length >= 12, `parsed ${parts.length / 2} tiers`);
    _a62.deepEqual(missing, [], `tiers accepting a page without the challenge check: ${missing.join(', ')}`);
  });
}

// BRO-7962 ship-check fixes: handoff decision, walled parking, identity-only read refusals.
{
  const req = _cr62(import.meta.url);
  const UF = req('./gap-url-find.js');
  const walledGot = { ok: false, foundUnreadable: [{ url: 'https://www.thetimes.com/short', code: 'too_short' }, { url: 'https://www.thetimes.com/w', code: 'bot_challenge', method: 'SERP' }] };
  _t62('walledHandoffLink: only a walled link, only with an open browser gate, an enabled strategy and an adapter', () => {
    const on = { browserGateOpen: true, browserEnabled: true, hasAdapter: true };
    _a62.deepEqual(UF.walledHandoffLink(walledGot, on), { url: 'https://www.thetimes.com/w', code: 'bot_challenge', method: 'SERP' });
    for (const k of Object.keys(on)) _a62.equal(UF.walledHandoffLink(walledGot, { ...on, [k]: false }), null, k);
    _a62.equal(UF.walledHandoffLink({ ok: true, foundUnreadable: walledGot.foundUnreadable }, on), null);
    _a62.equal(UF.walledHandoffLink({ ok: false, foundUnreadable: [{ url: 'u', code: 'too_short' }] }, on), null);
  });
  _t62('walled park: 2 unread nights + every missing method already found the wall; a login reader parks only after failing twice', () => {
    const row = (ts, { methods = { SERP: 'found_unreadable' }, walledBrowser = null } = {}) => ({ strategy: 'URL_FIND', outcome: 'no_evidence', reason: 'url_found_unreadable', ts,
      detail: { policy: UF.URL_FIND_POLICY, refusalPolicy: UF.REFUSAL_POLICY, methods, foundUnreadable: [{ url: 'https://x/w', code: 'paywalled', method: 'SERP' }], ...(walledBrowser ? { walledBrowser } : {}) } });
    const now = Date.parse('2026-12-30T00:00:00Z');
    const doneElse = Object.fromEntries(UF.METHODS.filter((m) => m !== 'SERP').map((m) => [m, 'no_candidates']));
    const full = { methods: { ...doneElse, SERP: 'found_unreadable' } };
    _a62.equal(UF.urlFindEligibility([row('2026-11-01T00:00:00Z', full)], { nowMs: now }).ok, true); // one sighting
    const two = [row('2026-11-01T00:00:00Z', full), row('2026-11-10T00:00:00Z', full)];
    _a62.equal(UF.urlFindEligibility(two, { nowMs: now }).reason, 'url_find_walled_waiting_login');
    // another method never ran: it may find a free copy, so no park
    _a62.equal(UF.urlFindEligibility([row('2026-11-01T00:00:00Z'), row('2026-11-10T00:00:00Z')], { nowMs: now }).ok, true);
    // a login reader keeps trying ...
    _a62.equal(UF.urlFindEligibility(two, { nowMs: now, loginReader: true }).ok, true);
    // ... until it failed on that link twice
    const wb = { url: 'https://x/w', outcome: 'auth_failed', reason: 'logged_out' };
    const twoFailed = [row('2026-11-01T00:00:00Z', { ...full, walledBrowser: wb }), row('2026-11-10T00:00:00Z', { ...full, walledBrowser: wb })];
    _a62.equal(UF.urlFindEligibility(twoFailed, { nowMs: now, loginReader: true }).reason, 'url_find_walled_waiting_login');
  });
  _t62('a walled rejection takes the 5-failure path, not the strict garbage_content one', () => {
    const L = req('./gap-recovery-ledger.js');
    const st = (reason) => {
      const rows = [1, 2, 3].map((d) => ({ reviewKey: 'k', strategy: 'REFETCH_FREE', outcome: 'rejected', reason, ts: `2026-11-0${d}T00:00:00Z` }));
      return L.strategyState(new Map([['k', rows]]), 'k', 'REFETCH_FREE');
    };
    _a62.equal(st('bot_challenge').lastPolicyReason, 'all_tiers_failed');
    _a62.equal(st('bot_challenge').abandoned, false);
    _a62.equal(st('extractor_null').lastPolicyReason, 'garbage_content');
  });
  _t62('a READ link is refused only on an identity refusal, not too_short / not_longer', () => {
    const r = (reason) => ({ strategy: 'URL_FIND', outcome: 'rejected', reason, url: `https://x/${reason}` });
    _a62.deepEqual([...UF.refusedUrlsFromRows([r('too_short'), r('not_longer'), r('wrong_article'), r('byline_conflict')])], ['https://x/wrong_article', 'https://x/byline_conflict']);
  });
  _t62('class guard: gap-recovery-driver.js runLive uses no name defined only in main()/planCandidates()', () => {
    const fs = req('fs'); const path = req('path');
    const src = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'gap-recovery-driver.js'), 'utf8');
    const start = src.indexOf('async function runLive(');
    const body = src.slice(start, src.indexOf('\n}\n', start)); // to the function's closing brace at column 0
    const header = body.slice(0, body.indexOf('\n'));
    const code = body.replace(/\/\/[^\n]*/g, '').replace(/'(?:[^'\\\n]|\\.)*'/g, "''"); // drop comments and quoted strings (template ${...} uses still count)
    // Every name declared at the top of main() / planCandidates() (const/let, plain or destructured).
    const outerNames = new Set();
    for (const fn of ['async function main(', 'function planCandidates(']) {
      const i = src.indexOf(fn); if (i < 0) continue;
      const fb = src.slice(i, src.indexOf('\n}\n', i));
      for (const m of fb.matchAll(/\n  (?:const|let) (\{[^}]*\}|[A-Za-z_$][\w$]*)/g)) {
        for (const n of m[1].replace(/[{}]/g, '').split(',')) { const k = n.split(':').pop().split('=')[0].trim(); if (k) outerNames.add(k); }
      }
    }
    _a62.ok(outerNames.has('runGates') && outerNames.size > 5, `parsed ${outerNames.size} outer names`);
    const topLevel = new Set([...src.matchAll(/\n(?:const|let|var|function|async function) \{?([A-Za-z_$][\w$, ]*)/g)].flatMap((m) => m[1].split(',').map((x) => x.trim())));
    for (const name of outerNames) {
      if (topLevel.has(name)) continue;
      if (!new RegExp(`(?<![.\\w$])${name.replace(/\$/g, '\\$')}\\b(?!\\s*:)`).test(code)) continue; // a bare use, not obj.name or a key
      const declared = new RegExp(`(?:\\b${name}\\b)`).test(header) || new RegExp(`(?:const|let|var)\\s+(?:\\{[^}]*\\b${name}\\b[^}]*\\}|${name}\\b)`).test(body) || new RegExp(`\\(\\s*\\[?[^)]*\\b${name}\\b[^)]*\\)\\s*=>|for \\((?:const|let) [^)]*\\b${name}\\b`).test(body);
      _a62.ok(declared, `runLive uses ${name} but never declares or receives it`);
    }
  });
}

// BRO-7962: a chain that every tier answered with a bot check says so (Telegraph slug guess, 2026-11-21 real run).
{
  const req = _cr62(import.meta.url);
  const S = req('./gap-strategies.js');
  const UF = req('./gap-url-find.js');
  const CHALLENGE = '<html><head><title>Just a moment...</title></head><body><div id="challenge-running">Checking your browser</div><script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1"></script></body></html>';
  const deps = (fetchPage) => ({ ...S.defaultDeps(), fetchPage, isNotFoundHtml: () => false, extractArticleText: () => null, listCaptureTimestamps: async () => [], freeTiersForUrl: () => ['direct'] });
  const thrower = (html) => async () => { const e = new Error('All scraping methods failed'); if (html) e.challengeHtml = html; throw e; };
  _t62('walledFetchError: a wall page on the error -> rejected/<wall>; none -> null', () => {
    _a62.equal(S.walledFetchError(Object.assign(new Error('All scraping methods failed'), { challengeHtml: CHALLENGE })).reason, 'bot_challenge');
    _a62.equal(S.walledFetchError(new Error('All scraping methods failed')), null);
    _a62.equal(S.walledFetchError(Object.assign(new Error('x'), { challengeHtml: '<p>tiny</p>' })), null);
  });
  _t62('refetchFree: all tiers challenged -> rejected/bot_challenge, plain failure unchanged', async () => {
    _a62.deepEqual([(await S.refetchFree({ url: 'https://www.telegraph.co.uk/a' }, deps(thrower(CHALLENGE)))).reason], ['bot_challenge']);
    _a62.notEqual((await S.refetchFree({ url: 'https://www.telegraph.co.uk/a' }, deps(thrower(null)))).reason, 'bot_challenge');
  });
  _t62('paidFetch: Bright Data answering with a bot check is rejected/bot_challenge, not fetch_error (BRO-8092 cousin)', async () => {
    const r = await S.paidFetch({ url: 'https://www.telegraph.co.uk/a' }, { ...deps(thrower(CHALLENGE)), paidTierAvailable: () => true });
    _a62.deepEqual([r.outcome, r.reason], ['rejected', 'bot_challenge']);
    const plain = await S.paidFetch({ url: 'https://www.telegraph.co.uk/a' }, { ...deps(thrower(null)), paidTierAvailable: () => true });
    _a62.notEqual(plain.reason, 'bot_challenge');
  });
  _t62('fetchCandidateText: a fully challenged link is walled (handoff), not an error', async () => {
    const got = await UF.fetchCandidateText('https://www.telegraph.co.uk/a', { allowBd: true }, deps(thrower(CHALLENGE)));
    _a62.equal(UF.walledFetchReason(got.tried), 'bot_challenge', got.tried.join(' | '));
    _a62.equal(UF.fetchRefusedOnEvidence(got.tried), false);
  });
}

_t62('BRO-7962: the Telegraph Akamai "Access Denied" page (real, 2026-11-21) is a wall, for the chain and the recovery layer alike', () => {
  const req = _cr62(import.meta.url);
  const AKAMAI = '<html><head> <title>Access Denied</title> </head><body> <h1>Access Denied</h1> You don\'t have permission to access "http://www.telegraph.co.uk/theatre/what-to-see/evening-all-afternoon-review/" on this server.<p> Reference #18.d124c317.1795261217.1da28212 </p><p>https://errors.edgesuite.net/18.d124c317.1795261217.1da28212</p> </body></html>';
  _a62.equal(req('./cookie-probes.js').isBotChallenge(AKAMAI), true);
  _a62.equal(req('./scraper.js').isChallengeOrGarbage(AKAMAI), true);
  _a62.equal(req('./gap-strategies.js').walledFetchError(Object.assign(new Error('All scraping methods failed'), { challengeHtml: AKAMAI })).reason, 'bot_challenge');
});

// BRO-8099 (BRO-7997 class): URL_FIND's candidate fetch paid Bright Data on a
// subscriber outlet even after the free tier showed the wall; Bright Data cannot
// log in, so it only bought the same wall. Decided: walled detection goes
// through the free tier first; paid stays when the free tier proved nothing.
{
  const req = _cr62(import.meta.url);
  const UF = req('./gap-url-find.js');
  const PAYWALLED = '<html><head><script type="application/ld+json">{"@type":"NewsArticle","isAccessibleForFree":"False"}</script></head><body><p>Subscribe</p></body></html>';
  const mk = (freeHtml, counter) => ({
    isNotFoundHtml: () => false, extractArticleText: () => null, listCaptureTimestamps: async () => [],
    fetchPage: async (u, o) => { if (o && o.tiers && o.tiers[0] === 'brightdata') { counter.bd++; return { content: PAYWALLED }; } if (freeHtml === null) throw new Error('timeout of 30000ms exceeded'); return { content: freeHtml, source: 'x' }; },
  });
  _t62('fetchCandidateText: subscriber outlet + free tier walled -> no Bright Data, still handed to the browser', async () => {
    const n = { bd: 0 };
    const got = await UF.fetchCandidateText('https://www.thetimes.com/a', { allowBd: true, subscriberOutlet: true }, mk(PAYWALLED, n));
    _a62.equal(n.bd, 0, JSON.stringify(got.tried));
    _a62.equal(got.paid, 0);
    _a62.equal(UF.walledFetchReason(got.tried), 'paywalled');
    _a62.equal(UF.fetchRefusedOnEvidence(got.tried), false);
    _a62.ok(got.tried.includes('brightdata:skipped/subscriber_walled_free_paywalled'));
  });
  _t62('fetchCandidateText: Bright Data kept for free outlets, and for subscriber outlets when the free tier proved nothing', async () => {
    const a = { bd: 0 };
    await UF.fetchCandidateText('https://free.example/a', { allowBd: true, subscriberOutlet: false }, mk(PAYWALLED, a));
    _a62.equal(a.bd, 1, 'not a subscriber outlet: unchanged');
    const b = { bd: 0 };
    const got = await UF.fetchCandidateText('https://www.thetimes.com/a', { allowBd: true, subscriberOutlet: true }, mk(null, b));
    _a62.equal(b.bd, 1, 'a free-tier timeout says nothing about the wall');
    _a62.equal(UF.walledFetchReason(got.tried), 'paywalled', 'paid answer routes the link to the browser');
  });
  _t62('urlFind passes subscriberOutlet from the outlet adapter to fetchCandidateText', async () => {
    const fs = req('fs'); const os = req('os'); const path = req('path');
    const S = req('./gap-strategies.js');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'urlfind8099-'));
    fs.mkdirSync(path.join(tmp, 'julie-west-end-2018'));
    const fp = path.join(tmp, 'julie-west-end-2018', 'times-uk--x.json');
    fs.writeFileSync(fp, JSON.stringify({ showId: 'julie-west-end-2018', outletId: 'times-uk', criticName: 'X Y', url: null, fullText: 'short' }));
    const root = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..');
    const orig = { runMethod: UF.runMethod, fetchCandidateText: UF.fetchCandidateText };
    const seen = [];
    UF.runMethod = async (m) => ({ candidates: m === 'SLUG_GUESS' ? [{ url: 'https://www.thetimes.com/w1' }] : [], tried: [], error: null });
    UF.fetchCandidateText = async (url, o) => { seen.push(o.subscriberOutlet); return { ok: false, tried: ['free:rejected/paywalled'] }; };
    try {
      await S.urlFind({ filePath: fp, showId: 'julie-west-end-2018' }, { dir: tmp, rootDir: root, methods: ['SLUG_GUESS'] }, { gate: async () => ({ ok: false }) });
      _a62.deepEqual(seen, [true], 'times-uk has a browser adapter');
    } finally { Object.assign(UF, orig); fs.rmSync(tmp, { recursive: true, force: true }); }
  });
}
