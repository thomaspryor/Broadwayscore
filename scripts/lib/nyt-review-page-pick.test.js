'use strict';
/**
 * BRO-8286: NYT Critic's Pick detection from the review page's own header.
 * Run: node --test scripts/lib/nyt-review-page-pick.test.js
 *
 * Fixtures are real excerpts of nytimes.com review pages captured 2026-11-25
 * (tests/fixtures/nyt-review-page). Revert the detector and the Seven Guitars
 * case fails: that is the badge the spotlight page was too late to list.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  isCriticsPickPage, looksLikeArticlePage, selectUrlsToCheck, classifyReviewPages,
  recordChecks, pruneState, MAX_NEGATIVE_CHECKS, MIN_RECHECK_GAP_MS, MAX_URLS_PER_RUN,
  MAX_FAILED_FETCHES, FAIL_BACKOFF_MS,
} = require('./nyt-review-page-pick');

const FIX = path.join(__dirname, '..', '..', 'tests', 'fixtures', 'nyt-review-page');
const fixture = (n) => fs.readFileSync(path.join(FIX, `${n}.html`), 'utf8');

const SEVEN = 'https://www.nytimes.com/2026/11/24/theater/seven-guitars-review-hornsby-santiago-hudson.html';

test('Seven Guitars review (labeled Critic\'s Pick, absent from the spotlight list) is detected', () => {
  assert.equal(isCriticsPickPage(fixture('pick-seven-guitars')), true);
});

test('an older pick is detected too', () => {
  assert.equal(isCriticsPickPage(fixture('pick-860')), true);
});

test('"Critic\'s Notebook" pieces are not picks', () => {
  assert.equal(isCriticsPickPage(fixture('notebook-ghost-in-your-ear')), false);
});

test('an unlabeled review is not a pick', () => {
  assert.equal(isCriticsPickPage(fixture('plain-anon')), false);
});

test('the old site-chrome trap: label text in a sidebar widget or CSS class does not count', () => {
  const widget = '<div class="criticsPick"><a href="/x">More Critic’s Picks</a></div>'
    + '<aside><p class="css-x">Critic’s Pick</p><h2>Related</h2></aside>'
    + '<p class="css-y">Critic’s Notebook</p><h1 id="a" data-testid="headline">A Review</h1>'
    + '<script>{"__typename":"HeaderBasicBlock","label":{"content":[{"text":"Critic’s Notebook"}]}}</script>';
  assert.equal(isCriticsPickPage(widget), false);
});

test('a label far above the headline (a different block) does not count', () => {
  const far = '<p class="r">Critic’s Pick</p>' + '<div>x</div>'.repeat(200)
    + '<h1 id="a" data-testid="headline">A Review</h1>';
  assert.equal(isCriticsPickPage(far), false);
});

test('straight and curly apostrophes both match', () => {
  const mk = (q) => `<div class="l"><p class="c">Critic${q}s Pick</p></div><div class="d"><h1 id="x" data-testid="headline">T</h1>`;
  assert.equal(isCriticsPickPage(mk('’')), true);
  assert.equal(isCriticsPickPage(mk("'")), true);
});

test('HTML-entity apostrophes match too', () => {
  const mk = (q) => `<div class="l"><p class="c">Critic${q}s Pick</p></div><div class="d"><h1 id="x" data-testid="headline">T</h1>`;
  for (const q of ['&#x27;', '&#39;', '&#8217;', '&rsquo;']) assert.equal(isCriticsPickPage(mk(q)), true, q);
});

test('JSON header-block encoding alone is enough when the DOM label moved', () => {
  const html = '<h1 data-testid="headline">T</h1><script>{"__typename":"HeaderBasicBlock","label":'
    + '{"textAlign":"LEFT","content":[{"__typename":"TextInline","text":"Critic’s Pick"}]}}</script>';
  assert.equal(isCriticsPickPage(html), true);
});

test('blocked or paywall shells are not pages we can judge', () => {
  assert.equal(isCriticsPickPage(''), false);
  assert.equal(isCriticsPickPage('<html>Access Denied</html>'), false);
  assert.equal(looksLikeArticlePage('<html>Access Denied</html>', SEVEN), false);
  assert.equal(looksLikeArticlePage(fixture('pick-seven-guitars'), SEVEN), false, 'excerpt lacks the slug text, so a different article does not pass');
  assert.equal(looksLikeArticlePage('<h1 data-testid="headline">x</h1> seven-guitars-review-hornsby-santiago-hudson', SEVEN), true);
});

test('classifyReviewPages: picks, negatives and failures are kept apart; a blocked page is never a negative', async () => {
  const pages = {
    a: `<div><p>Critic’s Pick</p></div><div><h1 data-testid="headline">A</h1> slug-a`,
    b: `<div><p>Critic’s Notebook</p></div><div><h1 data-testid="headline">B</h1> slug-b`,
    c: '<html>Access Denied</html>',
  };
  const urls = ['https://www.nytimes.com/2026/11/24/theater/slug-a.html',
    'https://www.nytimes.com/2026/11/24/theater/slug-b.html',
    'https://www.nytimes.com/2026/11/24/theater/slug-c.html',
    'https://www.nytimes.com/2026/11/24/theater/slug-d.html'];
  const getPage = async (u) => {
    if (u.endsWith('slug-d.html')) throw new Error('HTTP 403');
    return pages[u.match(/slug-(\w)/)[1]];
  };
  const r = await classifyReviewPages({ urls, getPage });
  assert.deepEqual(r.picks, [urls[0]]);
  assert.deepEqual(r.negatives, [urls[1]]);
  assert.deepEqual(r.failures.map(f => f.url), [urls[2], urls[3]]);
});

test('classifyReviewPages stops when the time budget says so', async () => {
  let calls = 0;
  const r = await classifyReviewPages({
    urls: ['https://www.nytimes.com/2026/11/24/theater/a.html', 'https://www.nytimes.com/2026/11/24/theater/b.html'],
    getPage: async () => { calls++; return '<h1 data-testid="headline">x</h1> a b'; },
    shouldStop: () => calls >= 1,
  });
  assert.equal(calls, 1);
  assert.equal(r.negatives.length, 1);
});

test('negative cache: re-check once after the gap, then stop; failures never consume a check', () => {
  const now = new Date('2026-11-25T12:00:00Z');
  const url = SEVEN;
  assert.deepEqual(selectUrlsToCheck({ urls: [url], state: {}, now }), [url]);
  let state = recordChecks({}, { negatives: [url] }, now);
  assert.equal(state[url].checks, 1);
  assert.deepEqual(selectUrlsToCheck({ urls: [url], state, now: new Date(now.getTime() + 60 * 60 * 1000) }), [], 'too soon');
  const later = new Date(now.getTime() + MIN_RECHECK_GAP_MS + 1000);
  assert.deepEqual(selectUrlsToCheck({ urls: [url], state, now: later }), [url]);
  state = recordChecks(state, { negatives: [url] }, later);
  assert.equal(state[url].checks, MAX_NEGATIVE_CHECKS);
  const muchLater = new Date(later.getTime() + 2 * MIN_RECHECK_GAP_MS);
  assert.deepEqual(selectUrlsToCheck({ urls: [url], state, now: muchLater }), [], 'budget of checks spent');
  assert.equal(recordChecks(state, { picks: [url] }, muchLater)[url], undefined, 'a pick leaves the cache');
});

test('selectUrlsToCheck dedupes by canonical URL and caps the run', () => {
  const urls = Array.from({ length: 12 }, (_, i) => `https://www.nytimes.com/2026/11/24/theater/s${i}.html?smid=x`);
  const picked = selectUrlsToCheck({ urls: [...urls, urls[0]], state: {} });
  assert.equal(picked.length, MAX_URLS_PER_RUN);
  assert.ok(picked.every(u => !u.includes('?')));
});

test('pruneState drops entries past the retention window', () => {
  const now = new Date('2026-11-25T00:00:00Z');
  const state = { old: { checks: 1, lastCheckedAt: '2026-10-01T00:00:00Z' }, fresh: { checks: 1, lastCheckedAt: '2026-11-24T00:00:00Z' } };
  assert.deepEqual(Object.keys(pruneState(state, now)), ['fresh']);
});

test('the JSON fallback only trusts the first header block, not a later related item', () => {
  const related = '<h1 data-testid="headline">T</h1><script>{"__typename":"HeaderBasicBlock","label":{"content":[{"text":"Critic’s Notebook"}]},'
    + '"x":"y"} {"__typename":"HeaderBasicBlock","label":{"content":[{"text":"Critic’s Pick"}]}}</script>';
  assert.equal(isCriticsPickPage(related), false);
});

test('failed fetches back off, stop after MAX_FAILED_FETCHES, and a later negative keeps the count', () => {
  const t0 = new Date('2026-11-25T01:00:00Z');
  let state = recordChecks({}, { failures: [{ url: SEVEN, reason: 'x' }] }, t0);
  assert.equal(state[SEVEN].fails, 1);
  assert.equal(state[SEVEN].checks, 0);
  assert.deepEqual(selectUrlsToCheck({ urls: [SEVEN], state, now: new Date(t0.getTime() + FAIL_BACKOFF_MS - 1000) }), []);
  const t1 = new Date(t0.getTime() + FAIL_BACKOFF_MS + 1000);
  assert.deepEqual(selectUrlsToCheck({ urls: [SEVEN], state, now: t1 }), [SEVEN]);
  for (let i = 1; i < MAX_FAILED_FETCHES; i++) state = recordChecks(state, { failures: [{ url: SEVEN }] }, t1);
  assert.equal(state[SEVEN].fails, MAX_FAILED_FETCHES);
  assert.deepEqual(selectUrlsToCheck({ urls: [SEVEN], state, now: new Date(t1.getTime() + 24 * 3600 * 1000) }), []);
});
