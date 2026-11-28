/**
 * Unit tests for scripts/refresh-nyt-critics-picks.js.
 *
 * Run: node --test scripts/refresh-nyt-critics-picks.test.mjs
 *
 * Regression: 2026-09-16 onward NYT 403'd the runner and the script wrote an
 * empty picks list, removing every Critic's Pick badge.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { extractReviewUrls, looksLikeSpotlightPage, evaluateScrape, mergePicks, reviewPagePass, parseReviewUrlArgs, MAX_NEW_PER_RUN } = require('./refresh-nyt-critics-picks.js');

test('extracts relative hrefs from raw HTML', () => {
  const html = '<a href="/2026/09/23/theater/the-holes-review-max-wolf-friedlich.html">x</a>'
    + '<a href="/2026/09/23/theater/the-holes-review-max-wolf-friedlich.html">dup</a>';
  assert.deepEqual(extractReviewUrls(html), [
    'https://www.nytimes.com/2026/09/23/theater/the-holes-review-max-wolf-friedlich.html',
  ]);
});

test('extracts absolute links from proxy markdown without trailing junk', () => {
  const md = '[The Holes](https://www.nytimes.com/2026/09/23/theater/the-holes-review.html) and '
    + '[Bug](https://www.nytimes.com/2026/01/08/theater/bug-review-carrie-coon.html?smid=x)';
  assert.deepEqual(extractReviewUrls(md), [
    'https://www.nytimes.com/2026/09/23/theater/the-holes-review.html',
    'https://www.nytimes.com/2026/01/08/theater/bug-review-carrie-coon.html',
  ]);
});

test('empty or blocked page yields no URLs', () => {
  assert.deepEqual(extractReviewUrls(''), []);
  assert.deepEqual(extractReviewUrls('<html>Access Denied</html>'), []);
});


test('spotlight page is recognized; a theater section page with /theater/ links is not', () => {
  const link = '<a href="/2026/09/23/theater/the-holes-review.html">x</a>';
  assert.equal(looksLikeSpotlightPage(`<title>Theater Critic’s Picks</title>${link}`), true);
  assert.equal(looksLikeSpotlightPage(`<link rel="canonical" href="https://www.nytimes.com/spotlight/theater-critics-picks">${link}`), true);
  // Redirected to the Theater section: review links, but no spotlight marker.
  assert.equal(looksLikeSpotlightPage(`<title>Theater - The New York Times</title>${link}`), false);
  // Marker but no links (blocked/empty shell).
  assert.equal(looksLikeSpotlightPage('<title>Critic’s Picks</title>'), false);
});

test('refuses to write when page 1 errors (the 403 incident)', () => {
  const v = evaluateScrape({ urls: [], existingUrls: ['a'], firstPageError: 'HTTP 403' });
  assert.equal(v.ok, false);
  assert.match(v.reason, /403/);
});

test('refuses to write 0 URLs even when the file is already empty', () => {
  assert.equal(evaluateScrape({ urls: [], existingUrls: [] }).ok, false);
});

test('accepts a partial scrape: merge only adds, so short is harmless (the 10-URL run)', () => {
  const existing = Array.from({ length: 100 }, (_, i) => `u${i}`);
  assert.equal(evaluateScrape({ urls: existing.slice(0, 10), existingUrls: existing }).ok, true);
});

test('refuses an implausible burst of new URLs (wrong page)', () => {
  const existing = Array.from({ length: 100 }, (_, i) => `u${i}`);
  const burst = Array.from({ length: MAX_NEW_PER_RUN + 1 }, (_, i) => `new${i}`);
  const v = evaluateScrape({ urls: burst, existingUrls: existing });
  assert.equal(v.ok, false);
  assert.match(v.reason, /new URLs/);
  // A normal week: a couple of new picks on top of the known window.
  assert.equal(evaluateScrape({ urls: [...existing.slice(2), 'new0', 'new1'], existingUrls: existing }).ok, true);
});

test('first-ever run (empty file) is not capped', () => {
  const urls = Array.from({ length: 100 }, (_, i) => `u${i}`);
  assert.equal(evaluateScrape({ urls, existingUrls: [] }).ok, true);
});

test('merge keeps picks that scrolled off the spotlight window', () => {
  const existing = ['https://www.nytimes.com/2024/04/19/theater/stereophonic-review.html', 'b'];
  const scraped = ['b', 'https://www.nytimes.com/2026/09/23/theater/the-holes-review.html'];
  const { urls, added } = mergePicks(existing, scraped);
  assert.ok(urls.includes('https://www.nytimes.com/2024/04/19/theater/stereophonic-review.html'));
  assert.deepEqual(added, ['https://www.nytimes.com/2026/09/23/theater/the-holes-review.html']);
  assert.equal(urls.length, 3);
});

test('parseMaxPages: default is the full cap, --max-pages=1 limits to page 1, junk falls back', () => {
  const { parseMaxPages, MAX_PAGES } = require('./refresh-nyt-critics-picks.js');
  assert.equal(parseMaxPages([]), MAX_PAGES);
  assert.equal(parseMaxPages(['--max-pages=1']), 1);
  assert.equal(parseMaxPages(['--max-pages=0']), MAX_PAGES);
  assert.equal(parseMaxPages(['--max-pages=abc']), MAX_PAGES);
  assert.equal(parseMaxPages(['--max-pages=999']), MAX_PAGES);
});


// BRO-8286: the spotlight page lagged NYT's own review page (Seven Guitars).
const SEVEN = 'https://www.nytimes.com/2026/11/24/theater/seven-guitars-review-hornsby-santiago-hudson.html';
const pickPage = '<div><p>Critic’s Pick</p></div><div><h1 data-testid="headline">T</h1> seven-guitars-review-hornsby-santiago-hudson';
const plainPage = '<div><p>Critic’s Notebook</p></div><div><h1 data-testid="headline">T</h1> seven-guitars-review-hornsby-santiago-hudson';
const neverExceeded = { exceeded: () => false, canStartItem: () => true };

test('review-page pass adds a review the spotlight list does not have', async () => {
  const r = await reviewPagePass({
    urls: [], pageState: {}, budget: neverExceeded, argv: [],
    now: new Date('2026-11-25T01:00:00Z'),
    listCandidates: () => [SEVEN],
    getPage: async () => pickPage,
  });
  assert.deepEqual(r.picks, [SEVEN]);
  assert.equal(r.pageState[SEVEN], undefined);
});

test('review-page pass remembers a negative and does not refetch it inside the gap', async () => {
  const now = new Date('2026-11-25T01:00:00Z');
  let fetched = 0;
  const run = (n, state) => reviewPagePass({
    urls: [], pageState: state, budget: neverExceeded, argv: [], now: new Date(n),
    listCandidates: () => [SEVEN], getPage: async () => { fetched++; return plainPage; },
  });
  const first = await run(now, {});
  assert.deepEqual(first.picks, []);
  assert.equal(first.pageState[SEVEN].checks, 1);
  await run(new Date(now.getTime() + 30 * 60 * 1000), first.pageState);
  assert.equal(fetched, 1, 'second poll 30 min later must not fetch again');
});

test('review-page pass skips URLs already on the list and survives a failed fetch', async () => {
  const onList = await reviewPagePass({
    urls: [SEVEN], pageState: {}, budget: neverExceeded, argv: [], listCandidates: () => [SEVEN],
    getPage: async () => { throw new Error('should not fetch'); },
  });
  assert.deepEqual(onList.picks, []);
  const blocked = await reviewPagePass({
    urls: [], pageState: {}, budget: neverExceeded, argv: [], now: new Date('2026-11-25T01:00:00Z'),
    listCandidates: () => [SEVEN], getPage: async () => { throw new Error('HTTP 403'); },
  });
  assert.deepEqual(blocked.picks, []);
  assert.equal(blocked.pageState[SEVEN].checks, 0, 'a blocked fetch is not a negative result');
  assert.equal(blocked.pageState[SEVEN].fails, 1, 'but it is counted so the next poll backs off');
});

test('--review-url checks exactly those URLs, bypassing the cache', async () => {
  assert.deepEqual(parseReviewUrlArgs(['--dry-run', `--review-url=${SEVEN}`]), [SEVEN]);
  const r = await reviewPagePass({
    urls: [], pageState: { [SEVEN]: { checks: 2, lastCheckedAt: '2026-11-25T00:59:00Z' } },
    budget: neverExceeded, argv: [`--review-url=${SEVEN}`], now: new Date('2026-11-25T01:00:00Z'),
    listCandidates: () => { throw new Error('must not list'); }, getPage: async () => pickPage,
  });
  assert.deepEqual(r.picks, [SEVEN]);
});

test('review-page pass does not start a fetch when its budget cannot cover one (the blocked-spotlight starvation)', async () => {
  let fetched = 0;
  const r = await reviewPagePass({
    urls: [], pageState: {}, argv: [], now: new Date('2026-11-25T01:00:00Z'),
    budget: { exceeded: () => false, canStartItem: () => false },
    listCandidates: () => [SEVEN], getPage: async () => { fetched++; return pickPage; },
  });
  assert.equal(fetched, 0);
  assert.deepEqual(r.picks, []);
});

test('review-page pass backs off a blocked review page instead of retrying every poll', async () => {
  const t0 = new Date('2026-11-25T01:00:00Z');
  let fetched = 0;
  let state = {};
  const poll = async (minutes) => {
    const r = await reviewPagePass({
      urls: [], pageState: state, budget: neverExceeded, argv: [],
      now: new Date(t0.getTime() + minutes * 60 * 1000),
      listCandidates: () => [SEVEN], getPage: async () => { fetched++; throw new Error('HTTP 403'); },
    });
    state = r.pageState;
  };
  await poll(0);
  await poll(30);   // inside the 60 min backoff
  assert.equal(fetched, 1);
  await poll(90); await poll(180); await poll(270);
  assert.equal(fetched, 4, 'four failed tries, then it stops');
  await poll(400); await poll(600);
  assert.equal(fetched, 4);
});
