import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createNycTheatreDiscovery } = require('./nyc-theatre-discovery');
const DAY = 86400000;
const NOW = Date.parse('2026-11-16T14:00:00Z');
const show = (id, extra = {}) => ({ id, title: id, category: 'broadway', openingDate: '2024-01-01', status: 'open', ...extra });
const roundup = 'https://www.newyorkcitytheatre.com/news/reviews/123/test';

function setup(t, search = async () => []) {
  const archiveDir = fs.mkdtempSync(path.join(process.cwd(), '.nyc-discovery-test-'));
  t.after(() => fs.rmSync(archiveDir, { recursive: true, force: true }));
  let clock = NOW;
  const options = { archiveDir, search, now: () => clock };
  return { archiveDir, discovery: createNycTheatreDiscovery(options),
    reopen: () => createNycTheatreDiscovery(options), advance: ms => { clock += ms; } };
}

test('a successful no-page search persists across runs until retry-after, then retries', async t => {
  let calls = 0;
  const s = setup(t, async () => { calls++; return []; });
  const row = show('old');
  assert.equal(s.discovery.isDeferred(row), false);
  assert.deepEqual(await s.discovery.searchForShow(row), { url: null, outcome: 'not-found' });
  assert.equal(s.reopen().isDeferred(row), true);
  s.advance(7 * DAY - 1);
  assert.equal(s.reopen().isDeferred(row), true);
  s.advance(1);
  assert.equal(s.reopen().isDeferred(row), false);
  await s.discovery.searchForShow(row);
  assert.equal(calls, 2);
  assert.equal(s.reopen().isDeferred(row), true);
});

test('query and roundup selection preserve Broadway, Off-Broadway and London behavior', async t => {
  const queries = [];
  const s = setup(t, async (query, options) => {
    queries.push(query);
    assert.deepEqual(options, { nbResults: 5 });
    return [{ url: 'https://example.com/news/reviews/123' },
      { url: 'https://www.newyorkcitytheatre.com/shows/test' }, { url: roundup }];
  });
  for (const [category, label] of [['broadway', 'broadway'], ['off-broadway', 'off-broadway'], ['west-end', 'west end']]) {
    const row = show(category, { title: 'Test Show', category });
    assert.deepEqual(await s.discovery.searchForShow(row), { url: roundup, outcome: 'found' });
    assert.equal(queries.at(-1), `site:newyorkcitytheatre.com/news/reviews/ "Test Show" ${label} 2024`);
    assert.equal(s.discovery.isDeferred(row), false);
  }
});

test('a successful search with no roundup is a miss, even with other results', async t => {
  const s = setup(t, async () => [{ url: 'https://www.newyorkcitytheatre.com/shows/test' }]);
  await s.discovery.searchForShow(show('no-roundup'));
  assert.equal(s.discovery.isDeferred(show('no-roundup')), true);
});

test('provider unavailability and thrown errors never create negative cache entries', async t => {
  let mode = 'null';
  const s = setup(t, async () => { if (mode === 'throw') throw new Error('provider unavailable'); return null; });
  const row = show('retry');
  assert.deepEqual(await s.discovery.searchForShow(row), { url: null, outcome: 'unavailable' });
  assert.equal(s.reopen().isDeferred(row), false);
  mode = 'throw';
  await assert.rejects(s.discovery.searchForShow(row), /provider unavailable/);
  assert.equal(s.reopen().isDeferred(row), false);
  assert.deepEqual(s.discovery.orderShows([row, show('never-tried')]).map(s => s.id), ['never-tried', 'retry']);
});

test('a forced search that finds a page and a validated archive hit both clear previous misses', async t => {
  let results = [];
  const s = setup(t, async () => results);
  const row = show('forced');
  await s.discovery.searchForShow(row);
  assert.equal(s.discovery.isDeferred(row), true);
  results = [{ url: roundup }];
  await s.discovery.searchForShow(row);
  assert.equal(s.reopen().isDeferred(row), false);
  results = [];
  await s.discovery.searchForShow(row);
  assert.equal(s.discovery.isDeferred(row), true);
  s.discovery.recordArchiveHit(row);
  assert.equal(s.reopen().isDeferred(row), false);
});

test('opening-window misses retry daily and a pre-opening weekly miss expires at the window', async t => {
  const s = setup(t);
  const opening = NOW + 8 * DAY;
  const row = show('opening', { openingDate: new Date(opening).toISOString() });
  await s.discovery.searchForShow(row);
  s.advance(DAY);
  assert.equal(s.discovery.isDeferred(row), false, 'seven days before opening, retry immediately');
  await s.discovery.searchForShow(row);
  s.advance(DAY - 1);
  assert.equal(s.discovery.isDeferred(row), true);
  s.advance(1);
  assert.equal(s.discovery.isDeferred(row), false);
});

test('recently opened shows retry daily; undated shows use a bounded weekly retry', async t => {
  const s = setup(t);
  const recent = show('recent', { openingDate: '2026-11-15' });
  const undated = show('undated', { openingDate: null });
  await s.discovery.searchForShow(recent);
  await s.discovery.searchForShow(undated);
  s.advance(DAY);
  assert.equal(s.discovery.isDeferred(recent), false);
  assert.equal(s.discovery.isDeferred(undated), true);
  s.advance(6 * DAY);
  assert.equal(s.discovery.isDeferred(undated), false);
});

test('title, category, opening date and status changes invalidate old misses', async t => {
  const s = setup(t);
  const row = show('changed', { status: 'previews' });
  await s.discovery.searchForShow(row);
  for (const edit of [{ title: 'Corrected title' }, { category: 'off-broadway' }, { openingDate: '2025-01-01' }, { status: 'open' }]) {
    assert.equal(s.discovery.isDeferred({ ...row, ...edit }), false);
  }
  assert.equal(s.discovery.isDeferred(row), true);
});

test('budget-capped daily runs reach old shows even when newer misses have expired', async t => {
  const s = setup(t);
  const rows = [show('oldest'), show('newest', { openingDate: '2026-11-16' }), show('middle', { openingDate: '2026-11-15' })];
  const first = s.discovery.orderShows(rows)[0];
  assert.equal(first.id, 'newest');
  await s.discovery.searchForShow(first);
  s.advance(DAY);
  assert.equal(s.discovery.isDeferred(first), false);
  const second = s.reopen().orderShows(rows)[0];
  assert.equal(second.id, 'middle');
  await s.discovery.searchForShow(second);
  s.advance(DAY);
  assert.equal(s.reopen().orderShows(rows)[0].id, 'oldest');
  assert.deepEqual(rows.map(s => s.id), ['oldest', 'newest', 'middle'], 'input untouched');
});

test('archive hits rotate too; independent per-show writes preserve other runs state', async t => {
  const s = setup(t);
  const a = show('archive');
  const b = show('miss');
  s.discovery.recordArchiveHit(a);
  s.advance(DAY);
  await s.reopen().searchForShow(b);
  assert.equal(s.discovery.isDeferred(b), true);
  assert.deepEqual(s.discovery.orderShows([b, a]).map(s => s.id), ['archive', 'miss']);
  assert.equal(fs.readdirSync(path.join(s.archiveDir, '_discovery')).length, 2);
});

test('new arrivals cannot starve the oldest pending show under a one-show budget', async t => {
  const s = setup(t);
  const rows = [show('oldest'), show('newest', { openingDate: '2026-11-16' })];
  await s.discovery.searchForShow(s.discovery.orderShows(rows)[0]);
  s.advance(DAY);
  rows.push(show('new-arrival', { openingDate: '2027-01-01' }));
  assert.equal(s.reopen().orderShows(rows)[0].id, 'oldest');
});

test('invalid retry-after cannot suppress discovery', async t => {
  const s = setup(t);
  const row = show('bad-time');
  await s.discovery.searchForShow(row);
  const file = path.join(s.archiveDir, '_discovery', `${row.id}.json`);
  const entry = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...entry, retryAfter: 'forever' }));
  assert.equal(s.discovery.isDeferred(row), false);
});
