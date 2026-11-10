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
    assert.deepEqual(r.foundUnreadable, [{ url: 'https://t.co.uk/b1', code: 'paywall' }]);
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
