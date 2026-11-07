// BRO-6872 (p17 five-show replay): all three Talkin' Broadway reviews (School Girls, The Imaginary Invalid, Other Desert
// Cities) were found and dated by discovery, whose date check or named-page probe had the page in hand. The lane then
// fetched the same page again to score it, drew a challenge five times running, and lost each review.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const d = require('../../scripts/lib/opening-night-lane/discovery.js');
const inl = require('../../scripts/lib/opening-night-lane/inline-score.js');

const NIGHT = '2026-09-28';
const SHOW = { id: 'school-girls-or-the-african-mean-girls-play-2026', title: 'School Girls; Or, The African Mean Girls Play', openingDate: NIGHT };
const T0 = Date.parse('2026-09-29T02:00:00Z');
const TB = 'https://www.talkinbroadway.com/page/world/SchoolGirls.html';
const KEY = d.canonicalUrl(TB);
const BODY = 'Jocelyn Bioh\'s comedy returns to Broadway with a cast that lands every joke and every turn. '.repeat(20);
const PAGE = `<html><head><meta property="article:published_time" content="2026-09-28T23:00:00Z"></head><body><article>${BODY}</article></body></html>`;
const tbIndex = (extra = {}) => ({ name: 'talkin-broadway', kind: 'outlet-index', phase: 'cheap', fetchTimeoutMs: 1000,
  discover: async () => [{ url: TB, title: 'School Girls review', source: 'outlet-index', publishDate: null, needsDate: true, ...extra }] });
const pass = (adapters, fetchText) => d.runDiscoveryPass({ show: SHOW, night: NIGHT, now: T0 + 3600000, startedAt: T0, adapters, fetchText, memo: { rejected: {} } });

function scoring(fetchPage, now = () => T0 + 3600000) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro6872-prefetch-'));
  const s = inl.createInlineScoring({ show: SHOW, night: NIGHT, ledgerDir: dir, now, fetchPage,
    extractArticle: (html) => (html.match(/<article>([\s\S]*)<\/article>/) || [])[1] || null, scoreText: async () => ({ score: 90 }) });
  return { ...s, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('a find admitted after its date check carries the fetched page, and no JSON of it holds the page text', async () => {
  const r = await pass([tbIndex()], async (url) => { if (url !== TB) throw new Error('404'); return PAGE; });
  assert.equal(r.admitted.length, 1);
  assert.equal(r.admitted[0][d.PREFETCHED_PAGE], PAGE);
  assert.ok(!JSON.stringify(r).includes('Jocelyn'), 'page text must never reach a ledger, report or artifact');
});

test('the page a second sighting carries is kept when the first sighting\'s claim wins the merge', async () => {
  const probe = { name: 'tb-probe', kind: 'outlet-index', phase: 'cheap',
    discover: async () => [{ url: TB, title: 'School Girls', source: 'outlet-index', publishDate: '2026-09-28T23:00:00Z', reviewSignalGiven: true, [d.PREFETCHED_PAGE]: PAGE }] };
  const r = await pass([tbIndex({ publishDate: '2026-09-28T23:00:00Z', needsDate: false }), probe], async () => { throw new Error('no fetch expected'); });
  assert.equal(r.admitted.length, 1);
  assert.equal(r.admitted[0][d.PREFETCHED_PAGE], PAGE);
});

test('the lane scores the carried page instead of fetching it again (p17: every second fetch drew a challenge)', async () => {
  let fetches = 0;
  const s = scoring(async () => { fetches++; throw new Error('All scraping methods failed'); });
  try {
    const [a] = (await pass([tbIndex()], async () => PAGE)).admitted;
    const out = await s.fetchReview(a);
    assert.equal(fetches, 0);
    assert.ok(out.fullText.includes('Jocelyn'));
    assert.equal(out.sourceMethod, undefined, 'a carried page claims no fetch method');
  } finally { s.cleanup(); }
});

test('the carried page is used once: the retry after a short carried copy fetches afresh', async () => {
  let fetches = 0; let clock = T0 + 3600000;
  const s = scoring(async () => { fetches++; return { content: PAGE }; }, () => clock);
  try {
    const a = { url: TB, key: KEY, source: 'outlet-index', outletId: 'talkinbroadway', [d.PREFETCHED_PAGE]: '<html><article>Just a moment...</article></html>' };
    await assert.rejects(s.fetchReview(a), /fetch failed \(attempt 1\/5\)/);
    assert.equal(fetches, 0, 'the first attempt read the carried copy');
    clock += 3600000; // past the backoff
    const out = await s.fetchReview(a);
    assert.equal(fetches, 1);
    assert.ok(out.fullText.includes('Jocelyn'));
  } finally { s.cleanup(); }
});

test('on a paywall host the carried page is not used: the paywall rules need the real fetch', async () => {
  const WSJ = 'https://www.wsj.com/arts-culture/theater/school-girls-review-abc123';
  let fetches = 0;
  const s = scoring(async () => { fetches++; return { content: PAGE }; });
  try {
    await s.fetchReview({ url: WSJ, key: d.canonicalUrl(WSJ), source: 'outlet-index', outletId: 'wsj', [d.PREFETCHED_PAGE]: PAGE });
    assert.equal(fetches, 1);
  } finally { s.cleanup(); }
});

test('nor on a soft-paywall host (Vulture), whose length floor reads how the page was fetched', async () => {
  const VULTURE = 'https://www.vulture.com/article/school-girls-broadway-review.html';
  let fetches = 0;
  const s = scoring(async () => { fetches++; return { content: PAGE }; });
  try {
    await s.fetchReview({ url: VULTURE, key: d.canonicalUrl(VULTURE), source: 'outlet-index', outletId: 'vulture', [d.PREFETCHED_PAGE]: PAGE });
    assert.equal(fetches, 1);
  } finally { s.cleanup(); }
});

test('a date-check page with no date of its own (dated by the index\'s fallback day) is not carried: it may be a challenge page', async () => {
  const r = await pass([tbIndex({ fallbackDate: '2026-09-28T12:00:00Z' })], async () => '<html><title>Just a moment...</title><body>checking your browser</body></html>');
  assert.equal(r.admitted.length, 1, 'still admitted on the index\'s day');
  assert.equal(r.admitted[0][d.PREFETCHED_PAGE], undefined);
});
