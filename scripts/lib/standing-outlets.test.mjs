import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { standingOutletIds, standingOutletsSource, capNewStandingCells, DEFAULT_MAX_NEW_PER_RUN } =
  require('./standing-outlets.js');

const OUTLETS = {
  nytimes: { displayName: 'The New York Times', standingCoverage: true, standingMarkets: ['broadway'] },
  nypost: { displayName: 'New York Post', standingCoverage: true, standingMarkets: ['broadway'] },
  guardian: { displayName: 'The Guardian' }, // not standing
  timeout: { displayName: 'Time Out', standingCoverage: true, standingMarkets: ['west-end'] },
};

test('standingOutletIds: only standingCoverage outlets scoped to the market, sorted', () => {
  assert.deepEqual(standingOutletIds(OUTLETS, 'broadway'), ['nypost', 'nytimes']);
  assert.deepEqual(standingOutletIds(OUTLETS, 'west-end'), ['timeout']);
  assert.deepEqual(standingOutletIds(OUTLETS, 'off-broadway'), []);
});

test('standingOutletIds: no outlets registry -> empty, never throws', () => {
  assert.deepEqual(standingOutletIds(null, 'broadway'), []);
  assert.deepEqual(standingOutletIds(undefined, 'broadway'), []);
});

test('standingOutletsSource: shapes rows the census union expects', () => {
  const rows = standingOutletsSource('some-show', { outlets: OUTLETS, market: 'broadway' });
  assert.equal(rows.length, 2);
  const nyt = rows.find((r) => r.outletId === 'nytimes');
  assert.equal(nyt.outlet, 'The New York Times');
  assert.equal(nyt.critic, 'Unknown');
  assert.equal(nyt.stars, null);
  assert.equal(nyt.url, '');
});

test('standingOutletsSource: defaults market to broadway, no opts -> empty', () => {
  assert.deepEqual(standingOutletsSource('s', {}), []);
  assert.deepEqual(standingOutletsSource('s', { outlets: OUTLETS }).map((r) => r.outletId).sort(), ['nypost', 'nytimes']);
});

test('capNewStandingCells: already-tracked cells always pass through, free', () => {
  const existing = new Set(['show-a::nytimes']);
  const counter = { used: 0, cap: 0 }; // zero budget left
  const allowed = capNewStandingCells(existing, counter, 'show-a', ['nytimes']);
  assert.deepEqual(allowed, ['nytimes']);
  assert.equal(counter.used, 0, 'already-tracked cells must not consume budget');
});

test('capNewStandingCells: new cells consume budget until exhausted, then defer', () => {
  const existing = new Set();
  const counter = { used: 0, cap: 1 };
  const first = capNewStandingCells(existing, counter, 'show-a', ['nytimes']);
  assert.deepEqual(first, ['nytimes']);
  assert.equal(counter.used, 1);
  const second = capNewStandingCells(existing, counter, 'show-b', ['nypost']);
  assert.deepEqual(second, [], 'budget exhausted — deferred to next run');
  assert.equal(counter.used, 1);
});

test('capNewStandingCells: mixed batch — tracked passes, new throttled independently', () => {
  const existing = new Set(['show-a::nytimes']);
  const counter = { used: 0, cap: 0 };
  const allowed = capNewStandingCells(existing, counter, 'show-a', ['nytimes', 'nypost']);
  assert.deepEqual(allowed, ['nytimes'], 'nypost is new and budget is 0');
});

test('DEFAULT_MAX_NEW_PER_RUN is a small positive integer (sane default)', () => {
  assert.ok(Number.isInteger(DEFAULT_MAX_NEW_PER_RUN) && DEFAULT_MAX_NEW_PER_RUN > 0 && DEFAULT_MAX_NEW_PER_RUN < 1000);
});
