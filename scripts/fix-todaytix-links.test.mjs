import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

// fix-todaytix-links.js is a 9-line entry point; the logic lives in the
// checker, whose main() takes every network call and the writer as options.
const checker = require('./lib/todaytix-link-checker');

const tt = (url) => ({ platform: 'TodayTix', url });
const never = { exceeded: () => false, minutes: 20 };

async function run(shows, { status = {}, api = null, titles = {} } = {}) {
  const data = { shows: structuredClone(shows) };
  const saves = [];
  const savedOutput = process.env.GITHUB_OUTPUT;
  delete process.env.GITHUB_OUTPUT;
  try {
    const result = await checker.main({
      dryRun: false,
      data,
      budget: never,
      scanBudget: never,
      checkUrl: async (url) => status[url] ?? 200,
      getPageTitle: async (url) => titles[url] ?? null,
      searchTodayTixApi: async () => api,
      saveShows: (d) => saves.push(structuredClone(d)),
      sleep: async () => {},
      now: () => 0,
    });
    return { result, data, saves };
  } finally {
    if (savedOutput !== undefined) process.env.GITHUB_OUTPUT = savedOutput;
  }
}

test('a 404 link on a closed show is removed and saved', async () => {
  const shows = [{ id: 'gone-2020', title: 'Gone', status: 'closed', ticketLinks: [tt('https://www.todaytix.com/x/nyc/shows/1-gone')] }];
  const { result, data, saves } = await run(shows, { status: { 'https://www.todaytix.com/x/nyc/shows/1-gone': 404 } });
  assert.equal(result.removed, 1);
  assert.deepEqual(data.shows[0].ticketLinks, []);
  assert.equal(saves.length, 1);
});

test('a 404 link on an open show is repaired from the API once the new URL answers 200', async () => {
  const old = 'https://www.todaytix.com/x/nyc/shows/1-old';
  const shows = [{ id: 'hit-2026', title: 'Hit Show', status: 'open', venue: 'Booth Theatre', ticketLinks: [tt(old)] }];
  const { result, data, saves } = await run(shows, {
    status: { [old]: 404 },
    api: { id: 42, slug: 'hit-show', displayName: 'Hit Show' },
  });
  assert.equal(result.fixed, 1);
  assert.notEqual(data.shows[0].ticketLinks[0].url, old);
  assert.match(data.shows[0].ticketLinks[0].url, /42/);
  assert.equal(saves.length, 1);
});

test('a network error is not evidence of a broken link: nothing changes, nothing is saved', async () => {
  const url = 'https://www.todaytix.com/x/nyc/shows/7-ok';
  const shows = [{ id: 'ok-2026', title: 'Ok', status: 'open', ticketLinks: [tt(url)] }];
  const { result, data, saves } = await run(shows, { status: { [url]: 503 } });
  assert.equal(result.errors, 1);
  assert.equal(data.shows[0].ticketLinks[0].url, url);
  assert.equal(saves.length, 0);
});

test('requiring the entry point does not run main()', () => {
  const checkerPath = require.resolve('./lib/todaytix-link-checker');
  const entryPath = require.resolve('./fix-todaytix-links.js');
  const cached = require.cache[checkerPath];
  let called = 0;
  require.cache[checkerPath] = { ...cached, exports: { ...checker, main: async () => { called++; } } };
  delete require.cache[entryPath];
  try {
    require('./fix-todaytix-links.js');
    assert.equal(called, 0);
  } finally {
    require.cache[checkerPath] = cached;
    delete require.cache[entryPath];
  }
});
