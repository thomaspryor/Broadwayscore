import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { cronHttpRequest } = require('./cron-http-request');
const { withDeadline, closeBrowserServer } = require('./cron-deadline');
const { createRunBudget } = require('./run-budget');
const { main: fixLinks } = require('./todaytix-link-checker');
require('tsx/cjs');
const { fetchAggregatorPage } = require('../fetch-aggregator-pages.ts');

function transport(onRequest) {
  const requests = [];
  const responses = [];
  const request = (url, options, callback) => {
    const req = new EventEmitter();
    req.destroy = () => { req.destroyed = true; };
    req.end = () => onRequest({ url, options, req, callback, respond });
    const respond = (statusCode = 200, headers = {}) => {
      const res = new EventEmitter();
      Object.assign(res, { statusCode, headers, destroy() { this.destroyed = true; } });
      responses.push(res);
      callback(res);
      return res;
    };
    requests.push(req);
    return req;
  };
  return { request, requests, responses };
}

test('absolute deadline destroys a request that never gets a socket', async () => {
  const t = transport(() => {});
  await assert.rejects(cronHttpRequest('https://example.com', 'GET', { timeout: 20, request: t.request }), /wall-clock timeout/);
  assert.equal(t.requests[0].destroyed, true);
});

test('absolute deadline bounds a body that keeps trickling data', async () => {
  let interval;
  const t = transport(({ respond }) => {
    const res = respond();
    interval = setInterval(() => res.emit('data', Buffer.from('x')), 2);
  });
  try {
    await assert.rejects(cronHttpRequest('https://example.com', 'GET', { timeout: 20, request: t.request }), /wall-clock timeout/);
    assert.equal(t.responses[0].destroyed, true);
  } finally { clearInterval(interval); }
});

test('redirect loops are bounded and old responses are destroyed', async () => {
  const t = transport(({ respond }) => respond(302, { location: '/loop' }));
  await assert.rejects(cronHttpRequest('https://example.com', 'GET', { maxRedirects: 5, request: t.request }), /redirect limit/);
  assert.equal(t.requests.length, 6);
  assert.ok(t.responses.every(res => res.destroyed));
});

test('redirects share the original wall-clock deadline', async () => {
  const t = transport(({ respond }) => setTimeout(() => respond(302, { location: '/loop' }), 10));
  await assert.rejects(cronHttpRequest('https://example.com', 'GET', { timeout: 25, maxRedirects: 50, request: t.request }), /wall-clock timeout/);
  assert.ok(t.requests.length < 5);
});

test('response errors reject instead of trusting incomplete content', async () => {
  const t = transport(({ respond }) => {
    const res = respond();
    queueMicrotask(() => { res.emit('data', Buffer.from('{"data":')); res.emit('aborted'); });
  });
  await assert.rejects(cronHttpRequest('https://example.com', 'GET', { request: t.request }), /aborted/);
});

test('HEAD and capped title responses finish promptly', async () => {
  const t = transport(({ options, respond }) => {
    const res = respond();
    if (options.method !== 'HEAD') queueMicrotask(() => res.emit('data', Buffer.from('<title>A show</title>')));
  });
  assert.equal((await cronHttpRequest('https://example.com', 'HEAD', { request: t.request })).statusCode, 200);
  assert.match((await cronHttpRequest('https://example.com', 'GET', { maxBytes: 10, request: t.request })).body, /<title>/);
  assert.ok(t.responses.every(res => res.destroyed));
});

const data = () => ({ shows: [
  { id: 'closed', title: 'Old show', status: 'closed', ticketLinks: [{ platform: 'TodayTix', url: 'https://example.com/closed' }] },
  { id: 'open', title: 'Open show', status: 'open', ticketLinks: [{ platform: 'TodayTix', url: 'https://example.com/open' }] },
  { id: 'london', title: 'London show', category: 'west-end', status: 'previews', ticketLinks: [{ platform: 'TodayTix', url: 'https://example.com/london' }] },
] });
const baseOptions = { dryRun: false, now: () => 0, sleep: async () => {} };

test('TodayTix timeouts and server errors preserve every link', async () => {
  const shows = data();
  const before = structuredClone(shows);
  let writes = 0;
  const result = await fixLinks({ ...baseOptions, data: shows, checkUrl: async () => -1, saveShows: () => writes++ });
  assert.deepEqual(shows, before);
  assert.equal(result.errors, 3);
  assert.equal(writes, 0);
});

test('TodayTix scan stops before the job timeout and still checkpoints confirmed repairs', async () => {
  let time = 0;
  const shows = data();
  const snapshots = [];
  const result = await fixLinks({ ...baseOptions, data: shows,
    budget: createRunBudget(20, () => time), scanBudget: createRunBudget(15, () => time),
    checkUrl: async () => { time += 15 * 60000; return 404; },
    saveShows: d => snapshots.push(structuredClone(d)),
  });
  assert.equal(result.checked, 1);
  assert.equal(result.deferred, 2);
  assert.equal(result.removed, 1);
  assert.equal(snapshots.length, 1);
  assert.equal(shows.shows[0].ticketLinks.length, 0);
  assert.equal(shows.shows[1].ticketLinks.length, 1);
});

test('TodayTix repair budget leaves unfinished repairs intact', async () => {
  let time = 0;
  const shows = data();
  const result = await fixLinks({ ...baseOptions, data: shows,
    budget: createRunBudget(20, () => time), scanBudget: createRunBudget(15, () => time),
    checkUrl: async () => 404,
    saveShows: () => { time = 20 * 60000; },
  });
  assert.equal(result.checked, 3);
  assert.equal(result.removed, 1);
  assert.equal(result.deferred, 2);
  assert.equal(shows.shows[1].ticketLinks.length, 1);
});

test('API and verification failures preserve confirmed broken links for retry', async () => {
  for (const api of [undefined, { id: 123, slug: 'open', displayName: 'Open show' }]) {
    const shows = data();
    const result = await fixLinks({ ...baseOptions, data: shows,
      checkUrl: async url => url.includes('todaytix.com') ? -1 : 404,
      searchTodayTixApi: async () => api,
      saveShows: () => {},
    });
    assert.equal(result.removed, 1); // Only the confirmed closed-show 404.
    assert.equal(result.errors, 2);
    assert.equal(shows.shows[1].ticketLinks.length, 1);
    assert.equal(shows.shows[2].ticketLinks.length, 1);
  }
});

test('verified repairs retain market routing and are checkpointed individually', async () => {
  const shows = data();
  const locations = [];
  const snapshots = [];
  const result = await fixLinks({ ...baseOptions, data: shows,
    checkUrl: async url => url.includes('todaytix.com') ? 200 : 404,
    searchTodayTixApi: async (title, location) => { locations.push(location); return { id: 123, slug: 'right-show', displayName: title }; },
    saveShows: d => snapshots.push(structuredClone(d)),
  });
  assert.equal(result.fixed, 2);
  assert.deepEqual(locations, [1, 2]);
  assert.equal(snapshots.length, 3);
  assert.match(shows.shows[1].ticketLinks[0].url, /\/nyc\//);
  assert.match(shows.shows[2].ticketLinks[0].url, /\/london\//);
});

test('aggregator hung navigation is transient, closes the page, and finishes', async () => {
  let closed = false;
  const browser = { newPage: async () => ({ goto: () => new Promise(() => {}), close: async () => { closed = true; } }) };
  for (const aggregator of ['dtli', 'show-score', 'bww-rr']) {
    closed = false;
    const result = await fetchAggregatorPage(browser, aggregator, 'a', { a: { id: 'a', title: 'A show', slug: 'a', category: 'broadway' } }, {}, {}, 20);
    assert.equal(result.success, false);
    assert.match(result.error, /wall-clock timeout/);
    assert.notEqual(result.notFoundReason, true);
    assert.equal(closed, true);
  }
});

test('generic deadline clears timers when work finishes or throws', async () => {
  assert.equal(await withDeadline(async () => 42, 20, 'Work'), 42);
  await assert.rejects(withDeadline(async () => { throw new Error('real failure'); }, 20, 'Work'), /real failure/);
});

test('hung browser shutdown kills the process that would keep Node alive', async () => {
  const signals = [];
  const proc = { kill: signal => signals.push(signal) };
  await closeBrowserServer({ close: () => new Promise(() => {}), process: () => proc }, 20);
  assert.deepEqual(signals, ['SIGKILL']);
  signals.length = 0;
  await closeBrowserServer({ close: async () => {}, process: () => proc }, 20);
  assert.deepEqual(signals, []);
});
