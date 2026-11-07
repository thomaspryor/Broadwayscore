import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { hitKey, baselineKeySet, computeNewViolators } = require('./cv-flag-contradiction-baseline.js');

test('hitKey combines showId and file', () => {
  assert.equal(hitKey('hamilton-2015', 'nytimes--ben-brantley.json'), 'hamilton-2015::nytimes--ben-brantley.json');
});

test('baselineKeySet builds a Set keyed by (showId, file)', () => {
  const set = baselineKeySet([
    { showId: 'hamilton-2015', file: 'nytimes--ben-brantley.json' },
    { showId: 'wicked-2003', file: 'variety--jeremy-gerard.json' },
  ]);
  assert.equal(set.size, 2);
  assert.ok(set.has('hamilton-2015::nytimes--ben-brantley.json'));
  assert.ok(set.has('wicked-2003::variety--jeremy-gerard.json'));
});

test('baselineKeySet tolerates a missing/empty array', () => {
  assert.equal(baselineKeySet(undefined).size, 0);
  assert.equal(baselineKeySet([]).size, 0);
});

test('computeNewViolators: stays silent when all hits are baselined', () => {
  const hits = [{ showId: 'hamilton-2015', file: 'nytimes--ben-brantley.json', flag: 'wrongProduction' }];
  const baseline = baselineKeySet([{ showId: 'hamilton-2015', file: 'nytimes--ben-brantley.json' }]);
  assert.deepEqual(computeNewViolators(hits, baseline), []);
});

test('computeNewViolators: flags a (showId, file) not in the baseline', () => {
  const hits = [
    { showId: 'hamilton-2015', file: 'nytimes--ben-brantley.json' },
    { showId: 'wicked-2003', file: 'variety--jeremy-gerard.json' },
  ];
  const baseline = baselineKeySet([{ showId: 'hamilton-2015', file: 'nytimes--ben-brantley.json' }]);
  const result = computeNewViolators(hits, baseline);
  assert.equal(result.length, 1);
  assert.equal(result[0].showId, 'wicked-2003');
});

test('computeNewViolators: same filename under a different showId is a distinct identity', () => {
  const hits = [{ showId: 'wicked-2024', file: 'variety--jeremy-gerard.json' }];
  const baseline = baselineKeySet([{ showId: 'wicked-2003', file: 'variety--jeremy-gerard.json' }]);
  const result = computeNewViolators(hits, baseline);
  assert.equal(result.length, 1);
});

test('computeNewViolators: a changed flag on a baselined (showId, file) is NOT a new violator', () => {
  const hits = [{ showId: 'hamilton-2015', file: 'nytimes--ben-brantley.json', flag: 'isRoundupArticle' }];
  const baseline = baselineKeySet([{ showId: 'hamilton-2015', file: 'nytimes--ben-brantley.json', flag: 'wrongProduction' }]);
  assert.deepEqual(computeNewViolators(hits, baseline), []);
});

test('computeNewViolators: empty baseline flags every hit', () => {
  const hits = [{ showId: 'a', file: 'x.json' }, { showId: 'b', file: 'y.json' }];
  const result = computeNewViolators(hits, baselineKeySet([]));
  assert.equal(result.length, 2);
});

test('computeNewViolators: tolerates an empty hits array', () => {
  assert.deepEqual(computeNewViolators([], baselineKeySet([{ showId: 'x', file: 'y.json' }])), []);
  assert.deepEqual(computeNewViolators(undefined, baselineKeySet([{ showId: 'x', file: 'y.json' }])), []);
});
