import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createRunBudget } = require('./run-budget');
const { politeFetchText, fetchSchedule, stats } = require('./tours-to-you');
const { fetchAudiencePage } = require('./audience-page-fetch');
const listings = require('./we-listing-discover');
const quiet = () => {};
const noPace = { async take() {}, ok() {}, slowDown() {}, gap: () => 0 };

test('audience helpers check re-entry and expiry between the free and paid attempts', async () => {
  for (const response of [503, 'error']) {
    let now = 0;
    const budget = createRunBudget(1, () => now);
    let free = 0;
    let paid = 0;
    const opts = {
      budget, brightDataEnabled: true, log: quiet,
      httpsGet: async () => {
        free++;
        now = 60_000;
        if (response === 'error') throw new Error('timeout');
        return { status: response, body: '' };
      },
      fetchWithBrightData: async () => { paid++; return { content: '' }; },
    };
    assert.equal(await fetchAudiencePage('first-slug', opts), null);
    assert.equal(await fetchAudiencePage('second-slug', opts), null);
    assert.equal(free, 1);
    assert.equal(paid, 0);
  }
});

test('audience fetches retain success, provider fallback and per-platform stop statuses', async () => {
  const body = 'x'.repeat(1001);
  let paid = 0;
  const opts = {
    budget: createRunBudget(0), brightDataEnabled: true, log: quiet,
    httpsGet: async () => ({ status: 200, body }),
    fetchWithBrightData: async () => { paid++; return { content: body }; },
  };
  assert.equal(await fetchAudiencePage('page', opts), body);
  assert.equal(paid, 0);
  assert.equal(await fetchAudiencePage('page', { ...opts, httpsGet: async () => ({ status: 503, body: '' }) }), body);
  assert.equal(paid, 1);
  for (const status of [404, 301, 302]) {
    assert.equal(await fetchAudiencePage('page', {
      ...opts, stopStatuses: [404, 301, 302], httpsGet: async () => ({ status, body: '' }),
    }), null);
  }
  assert.equal(paid, 1, 'LBO redirects retain their existing no-fallback behavior');
  assert.equal(await fetchAudiencePage('page', { ...opts, httpsGet: async () => ({ status: 302, body: '' }) }), body);
  assert.equal(paid, 2, 'LTD and SeatPlan redirects retain their fallback behavior');
});

test('a re-entered tour fetch refuses an expired budget before pacing or GET', async () => {
  let now = 0;
  const budget = createRunBudget(1, () => now);
  let calls = 0;
  let paced = 0;
  const opts = { budget, pace: { ...noPace, async take() { paced++; } }, get: async () => { calls++; return 'page'; } };
  assert.equal(await politeFetchText('first', opts), 'page');
  now = 60_000;
  const requestsBefore = stats.requests;
  await assert.rejects(politeFetchText('second', opts), /time budget/i);
  assert.equal(calls, 1);
  assert.equal(paced, 1);
  assert.equal(stats.requests, requestsBefore, 'skipped requests do not enter telemetry');
});

test('tour fetch rechecks the budget after an asynchronous pacing wait', async () => {
  let now = 0;
  const budget = createRunBudget(1, () => now);
  let calls = 0;
  await assert.rejects(politeFetchText('page', {
    budget,
    pace: { ...noPace, async take() { now = 60_000; } },
    get: async () => { calls++; return 'page'; },
  }), /time budget/i);
  assert.equal(calls, 0);
});

test('tour retries recheck after a backoff wait overruns its estimate', async () => {
  let now = 0;
  const budget = createRunBudget(1, () => now);
  let calls = 0;
  await assert.rejects(politeFetchText('page', {
    budget, pace: noPace, log: quiet,
    get: async () => { calls++; throw Object.assign(new Error('HTTP 429'), { status: 429 }); },
    wait: async () => { now = 60_000; },
  }), /time budget/i);
  assert.equal(calls, 1);
});

test('a second schedule slug does not fetch after the first spends the budget', async () => {
  let now = 0;
  const budget = createRunBudget(1, () => now);
  const urls = [];
  assert.deepEqual(await fetchSchedule({ title: 'Example' }, null, {
    budget, pace: noPace, log: quiet,
    get: async url => { urls.push(url); now = 60_000; return ''; },
  }), { url: null, html: '' });
  assert.deepEqual(urls, ['https://tourstoyou.org/shows/example/']);
});

for (const minutes of [0, null]) {
  test(`tour fetching preserves ${minutes === null ? 'absent' : 'disabled'} budget behavior`, async () => {
    let calls = 0;
    const budget = minutes === null ? null : createRunBudget(minutes);
    await fetchSchedule({ title: 'Example' }, null, {
      budget, pace: noPace, log: quiet, get: async () => { calls++; return ''; },
    });
    assert.equal(calls, 2);
  });
}

test('a WET listing fetch cannot start after the LBO listing spends the shared budget', async () => {
  let now = 0;
  const timeBudget = createRunBudget(1, () => now);
  let calls = 0;
  const opts = {
    timeBudget, log: quiet,
    fetchPage: async () => { calls++; now = 60_000; return { content: '' }; },
    fetchJSON: async () => { calls++; return []; },
  };
  assert.deepEqual(await listings.fetchLboRecentRoundups(opts), []);
  assert.deepEqual(await listings.fetchWetRecentRoundups(opts), []);
  assert.equal(calls, 1);
});

test('expired listing and article helpers return their existing empty shapes without fetching', async () => {
  let calls = 0;
  const opts = {
    timeBudget: { exceeded: () => true }, log: quiet,
    fetchPage: async () => { calls++; return { content: '' }; },
    fetchJSON: async () => { calls++; return []; },
  };
  assert.deepEqual(await listings.fetchLboRecentRoundups(opts), []);
  assert.deepEqual(await listings.fetchWetRecentRoundups(opts), []);
  assert.deepEqual(await listings.fetchNewsArticleJsonLd('article', opts), { description: null, datePublished: null });
  assert.deepEqual(await listings.fetchWetPostVenue('article', opts), { venue: null, articlePublishedAt: null });
  assert.deepEqual(await listings.fetchLboArticleDate('article', opts), { articlePublishedAt: null });
  assert.equal(calls, 0);
});

test('closing-date wrapper forwards the run budget before starting discovery', async () => {
  const discoveryPath = require.resolve('./closing-date-discovery');
  const serp = require('./url-discovery');
  const original = serp.serpQuery;
  const cached = require.cache[discoveryPath];
  let calls = 0;
  try {
    serp.serpQuery = async () => { calls++; return []; };
    delete require.cache[discoveryPath];
    const { discoverAnnouncedClosingDate } = require(discoveryPath);
    assert.equal(await discoverAnnouncedClosingDate('Example', { log: quiet }, { exceeded: () => true }), null);
    assert.equal(calls, 0);
    assert.equal(await discoverAnnouncedClosingDate('Example', { log: quiet }, createRunBudget(0)), null);
    assert.equal(calls, 1, 'disabled budget still starts discovery');
  } finally {
    serp.serpQuery = original;
    delete require.cache[discoveryPath];
    if (cached) require.cache[discoveryPath] = cached;
  }
});
