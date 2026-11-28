import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { normalizeUrl, identityKey, baselineKeySet, computeNewViolators } = require('./show-score-urls-baseline.js');

test('normalizeUrl lowercases and strips a trailing slash', () => {
  assert.equal(normalizeUrl('https://Show-Score.com/Foo/'), 'https://show-score.com/foo');
});

test('normalizeUrl tolerates missing input', () => {
  assert.equal(normalizeUrl(undefined), '');
  assert.equal(normalizeUrl(null), '');
});

test('identityKey is order-independent in showIds', () => {
  assert.equal(
    identityKey({ url: 'https://show-score.com/foo', showIds: ['a', 'b'] }),
    identityKey({ url: 'https://show-score.com/foo', showIds: ['b', 'a'] }),
  );
});

test('identityKey normalizes the url component', () => {
  assert.equal(
    identityKey({ url: 'https://Show-Score.com/Foo/', showIds: ['a', 'b'] }),
    identityKey({ url: 'https://show-score.com/foo', showIds: ['a', 'b'] }),
  );
});

test('identityKey changes when the showIds SET changes, even for the same url', () => {
  const twoWay = identityKey({ url: 'https://show-score.com/foo', showIds: ['a', 'b'] });
  const threeWay = identityKey({ url: 'https://show-score.com/foo', showIds: ['a', 'b', 'c'] });
  assert.notEqual(twoWay, threeWay);
});

test('baselineKeySet tolerates a missing/empty array', () => {
  assert.equal(baselineKeySet(undefined).size, 0);
  assert.equal(baselineKeySet([]).size, 0);
});

test('computeNewViolators: stays silent when every duplicate is baselined (same url + same showIds)', () => {
  const duplicates = [{ url: 'https://show-score.com/foo', showIds: ['a', 'b'] }];
  const baseline = baselineKeySet([{ url: 'https://show-score.com/foo', showIds: ['a', 'b'] }]);
  assert.deepEqual(computeNewViolators(duplicates, baseline), []);
});

test('computeNewViolators: baseline hit is order-independent (showIds reordered)', () => {
  const duplicates = [{ url: 'https://show-score.com/foo', showIds: ['b', 'a'] }];
  const baseline = baselineKeySet([{ url: 'https://show-score.com/foo', showIds: ['a', 'b'] }]);
  assert.deepEqual(computeNewViolators(duplicates, baseline), []);
});

test('computeNewViolators: flags a url not in the baseline, keeps baselined ones out', () => {
  const duplicates = [
    { url: 'https://show-score.com/known', showIds: ['a', 'b'] },
    { url: 'https://show-score.com/new', showIds: ['c', 'd'] },
  ];
  const baseline = baselineKeySet([{ url: 'https://show-score.com/known', showIds: ['a', 'b'] }]);
  const result = computeNewViolators(duplicates, baseline);
  assert.equal(result.length, 1);
  assert.equal(result[0].url, 'https://show-score.com/new');
});

test('computeNewViolators: case/trailing-slash drift on the url does not create a false-new finding', () => {
  const duplicates = [{ url: 'https://Show-Score.com/Known/', showIds: ['a', 'b'] }];
  const baseline = baselineKeySet([{ url: 'https://show-score.com/known', showIds: ['a', 'b'] }]);
  assert.deepEqual(computeNewViolators(duplicates, baseline), []);
});

test('computeNewViolators: a THIRD showId joining an already-baselined url IS a new finding', () => {
  // The bug an all-URL identity would miss (adversarial review, BRO-3471):
  // baselining {url, [a,b]} must not silently authorize {url, [a,b,c]}.
  const duplicates = [{ url: 'https://show-score.com/foo', showIds: ['a', 'b', 'c'] }];
  const baseline = baselineKeySet([{ url: 'https://show-score.com/foo', showIds: ['a', 'b'] }]);
  const result = computeNewViolators(duplicates, baseline);
  assert.equal(result.length, 1);
  assert.equal(result[0].showIds.length, 3);
});

test('computeNewViolators: empty baseline flags every duplicate', () => {
  const duplicates = [{ url: 'https://show-score.com/foo', showIds: ['a', 'b'] }];
  assert.equal(computeNewViolators(duplicates, baselineKeySet([])).length, 1);
});

test('computeNewViolators: tolerates an empty/undefined duplicates array', () => {
  const baseline = baselineKeySet([{ url: 'https://show-score.com/x', showIds: ['a', 'b'] }]);
  assert.deepEqual(computeNewViolators([], baseline), []);
  assert.deepEqual(computeNewViolators(undefined, baseline), []);
});

test('computeNewViolators: a genuine 3-way collision baselines/flags as one unit', () => {
  const threeWay = { url: 'https://show-score.com/foo', showIds: ['a', 'b', 'c'] };
  assert.deepEqual(computeNewViolators([threeWay], baselineKeySet([{ url: 'https://show-score.com/foo', showIds: ['a', 'b', 'c'] }])), []);
  assert.deepEqual(computeNewViolators([threeWay], baselineKeySet([])), [threeWay]);
});
