// BRO-4725: Tours To You discovery reads every page over time, politely.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ttY = require('../../scripts/lib/tours-to-you.js');
const { orderForCheck, nextCoverage, stalePages, STALE_DAYS } = require('../../scripts/lib/tours-to-you-coverage.js');
const { tourAutomationResults } = require('../../scripts/health-check.js');
const { classifyHealthCheck } = require('../../scripts/lib/digest-audience.js');

const NOW = new Date('2026-10-10T12:00:00Z');
const daysAgo = d => new Date(NOW.getTime() - d * 86400000).toISOString();
const err429 = (retryAfterMs = null) => Object.assign(new Error('HTTP 429'), { status: 429, retryAfterMs });
const noPace = { take: async () => {}, slowDown() {}, gap: () => 2000 };
const quiet = () => {};

test('Retry-After: seconds, an HTTP date, or nothing', () => {
  assert.equal(ttY.parseRetryAfter('30'), 30000);
  assert.equal(ttY.parseRetryAfter('Sat, 10 Oct 2026 12:00:20 GMT', NOW.getTime()), 20000);
  assert.equal(ttY.parseRetryAfter(undefined), null);
  assert.equal(ttY.parseRetryAfter('soon'), null);
});

test('backoff honours Retry-After, doubles otherwise, and is capped', () => {
  assert.equal(ttY.backoffMs(0, 5000), 5000);
  assert.equal(ttY.backoffMs(0), 15000);
  assert.equal(ttY.backoffMs(1), 30000);
  assert.equal(ttY.backoffMs(5), 60000);
  assert.equal(ttY.backoffMs(0, 600000), 60000, 'a huge Retry-After is capped');
});

test('pacer spaces requests and slows down after a 429', async () => {
  let t = 0;
  const waits = [];
  const p = ttY.createPacer(2000, { now: () => t, wait: async ms => { waits.push(ms); t += ms; } });
  await p.take(); await p.take(); await p.take();
  assert.deepEqual(waits, [2000, 2000]);
  p.slowDown();
  assert.equal(p.gap(), 4000);
  for (let i = 0; i < 5; i++) p.slowDown();
  assert.equal(p.gap(), 15000, 'gap is capped');
});

test('pacer recovers toward its base gap after a calm stretch', () => {
  const p = ttY.createPacer(2000, { now: () => 0, wait: async () => {} });
  p.slowDown(); p.slowDown();
  assert.equal(p.gap(), 8000);
  for (let i = 0; i < 10; i++) p.ok();
  assert.equal(p.gap(), 4000);
  for (let i = 0; i < 30; i++) p.ok();
  assert.equal(p.gap(), 2000, 'never below the base gap');
});

test('no paid fallback when too little budget is left for one', async () => {
  let fallbackCalls = 0;
  const budget = { remainingMs: () => 60000 };
  await assert.rejects(ttY.politeFetchText('u', { get: async () => { throw err429(); }, budget, fallback: async () => { fallbackCalls++; return '<html>x</html>'; }, wait: async () => {}, pace: noPace, log: quiet }), /429/);
  assert.equal(fallbackCalls, 0);
});

test('only a real Tours To You page counts as read', () => {
  assert.equal(ttY.looksLikeShowPage('<html><head><title>Hamilton</title><link rel="canonical" href="https://tourstoyou.org/shows/hamilton/"></head></html>'), true);
  assert.equal(ttY.looksLikeShowPage('<html><title>Just a moment...</title></html>'), false);
  assert.equal(ttY.looksLikeShowPage(''), false);
});

test('a 429 is retried after the wait, then succeeds', async () => {
  const waits = [];
  let calls = 0;
  const get = async () => { calls++; if (calls === 1) throw err429(7000); return '<html>ok</html>'; };
  const html = await ttY.politeFetchText('u', { get, wait: async ms => waits.push(ms), pace: noPace, log: quiet });
  assert.equal(html, '<html>ok</html>');
  assert.deepEqual(waits, [7000]);
});

test('the paid fallback runs only after the plain GET stays rate-limited', async () => {
  let fallbackCalls = 0;
  const fallback = async () => { fallbackCalls++; return { content: '<html>paid</html>', format: 'html' }; };
  // A 404 never reaches the fallback.
  await assert.rejects(ttY.politeFetchText('u', { get: async () => { throw Object.assign(new Error('HTTP 404'), { status: 404 }); }, fallback, wait: async () => {}, pace: noPace, log: quiet }), /404/);
  assert.equal(fallbackCalls, 0);
  // A success never reaches it either.
  await ttY.politeFetchText('u', { get: async () => 'plain', fallback, wait: async () => {}, pace: noPace, log: quiet });
  assert.equal(fallbackCalls, 0);
  // Three 429s in a row (first try + 2 retries) do.
  let calls = 0;
  const html = await ttY.politeFetchText('u', { get: async () => { calls++; throw err429(); }, fallback, wait: async () => {}, pace: noPace, log: quiet });
  assert.equal(calls, 3);
  assert.equal(fallbackCalls, 1);
  assert.equal(html, '<html>paid</html>');
});

test('a markdown or non-page fallback result is not taken as the page', async () => {
  for (const res of [{ content: '<html>| city | dates |', format: 'markdown' }, { content: 'Too Many Requests', format: 'raw' }]) {
    await assert.rejects(ttY.politeFetchText('u', { get: async () => { throw err429(); }, fallback: async () => res, wait: async () => {}, pace: noPace, log: quiet }), /429/);
  }
});

test('no retry wait that would overrun the run budget; without a fallback the 429 is thrown', async () => {
  let calls = 0;
  const budget = { remainingMs: () => 20000 };
  await assert.rejects(ttY.politeFetchText('u', { get: async () => { calls++; throw err429(); }, budget, wait: async () => { throw new Error('should not wait'); }, pace: noPace, log: quiet }), /429/);
  assert.equal(calls, 1);
});

test('pages are read never-read first, then edited since, then longest-unread', () => {
  const coverage = {
    a: { seenAt: daysAgo(9), checkedAt: daysAgo(1) },
    b: { seenAt: daysAgo(9), checkedAt: daysAgo(3) },
    c: { seenAt: daysAgo(9), checkedAt: daysAgo(2) },
    d: { seenAt: daysAgo(9), checkedAt: null },
  };
  const modified = { a: daysAgo(0.5), c: daysAgo(5) };
  assert.deepEqual(orderForCheck(['a', 'b', 'c', 'd', 'e'], coverage, modified), ['d', 'e', 'a', 'b', 'c']);
  assert.deepEqual(orderForCheck(['b', 'a'], {}, {}), ['a', 'b'], 'stable on a first run');
});

test('a run that stops early leaves the rest at the front of the next run', () => {
  const slugs = ['a', 'b', 'c', 'd'];
  const run1 = nextCoverage({}, slugs, ['a', 'b'], daysAgo(1));
  const order = orderForCheck(slugs, run1, {});
  assert.deepEqual(order.slice(0, 2), ['c', 'd']);
  const run2 = nextCoverage(run1, slugs, ['c', 'd'], NOW.toISOString());
  assert.ok(Object.values(run2).every(c => c.checkedAt), 'two runs cover every page');
  assert.deepEqual(orderForCheck(slugs, run2, {}).slice(0, 2), ['a', 'b']);
});

test('coverage drops delisted pages and keeps when a page was first seen', () => {
  const prev = { gone: { seenAt: daysAgo(9), checkedAt: daysAgo(1) }, a: { seenAt: daysAgo(9), checkedAt: null } };
  const next = nextCoverage(prev, ['a', 'new'], [], NOW.toISOString());
  assert.deepEqual(Object.keys(next), ['a', 'new']);
  assert.equal(next.a.seenAt, daysAgo(9));
  assert.equal(next.new.checkedAt, null);
});

test(`stale = unread for more than ${STALE_DAYS} days; a newly listed page gets the same grace`, () => {
  const coverage = {
    fresh: { seenAt: daysAgo(30), checkedAt: daysAgo(1) },
    old: { seenAt: daysAgo(30), checkedAt: daysAgo(6) },
    neverOld: { seenAt: daysAgo(5), checkedAt: null },
    neverNew: { seenAt: daysAgo(1), checkedAt: null },
  };
  assert.deepEqual(stalePages(coverage, NOW).map(r => r.slug), ['old', 'neverOld']);
});

test('the digest warns about unread pages and stays quiet when all are current', () => {
  const base = { generatedAt: daysAgo(0.1), created: [] };
  const ok = tourAutomationResults({ autocreate: { ...base, discovery: { error: null, coverage: { a: { seenAt: daysAgo(9), checkedAt: daysAgo(1) } } } } }, NOW);
  assert.deepEqual(ok.filter(r => /Tours To You pages/.test(r.name)), []);
  const rows = tourAutomationResults({ autocreate: { ...base, discovery: { error: null, coverage: {
    a: { seenAt: daysAgo(9), checkedAt: daysAgo(1) },
    'operation-mincemeat': { seenAt: daysAgo(9), checkedAt: daysAgo(7) },
  } } } }, NOW).filter(r => /Tours To You pages/.test(r.name));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'warn');
  assert.match(rows[0].message, /1 of 2 .*operation-mincemeat/);
  assert.equal(classifyHealthCheck(rows[0].name), 'visitors');
});

test('a job that stopped running shows up as stale pages too', () => {
  const coverage = { a: { seenAt: daysAgo(20), checkedAt: daysAgo(10) } };
  const rows = tourAutomationResults({ autocreate: { generatedAt: daysAgo(10), created: [], discovery: { coverage } } }, NOW);
  assert.ok(rows.some(r => r.name === 'Data: Tours To You pages not checked'));
});

test('reading every page, not only Broadway titles, still covers ~250 pages inside the stale window (BRO-4931)', () => {
  // The daily job gives discovery 6 of its 8 minutes; a page costs about 2.3 s (the 2 s pacer plus the fetch),
  // so a run reads about 156 pages. Pages an override or slug rule rules out are never fetched and never listed.
  const perRun = Math.floor((6 * 60) / 2.3);
  const slugs = Array.from({ length: 230 }, (_, i) => `show-${String(i).padStart(3, '0')}`);
  const day = n => new Date(Date.UTC(2026, 9, 10 + n, 12));
  let coverage = {};
  for (let n = 0; n < 12; n++) {
    if (n === 4) continue; // a missed daily run
    const read = orderForCheck(slugs, coverage, {}).slice(0, perRun);
    coverage = nextCoverage(coverage, slugs, read, day(n).toISOString());
    assert.deepEqual(stalePages(coverage, day(n), STALE_DAYS), [], `day ${n}: a page waited longer than ${STALE_DAYS} days`);
  }
});
