import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { pairKey, baselineKeySet, computeNewViolators } = require('./duplicate-shows-baseline.js');

test('pairKey is order-independent', () => {
  assert.equal(pairKey('a-show', 'b-show'), pairKey('b-show', 'a-show'));
});

test('baselineKeySet builds a Set from a-id/b-id pairs', () => {
  const set = baselineKeySet([{ a: 'show-1', b: 'show-2' }]);
  assert.equal(set.size, 1);
  assert.ok(set.has(pairKey('show-1', 'show-2')));
});

test('baselineKeySet tolerates a missing/empty array', () => {
  assert.equal(baselineKeySet(undefined).size, 0);
  assert.equal(baselineKeySet([]).size, 0);
});

test('computeNewViolators: stays silent when the whole cluster is baselined', () => {
  const clusters = [
    {
      key: 'christmas carol|2026',
      pairs: [{ a: { id: 'a-christmas-carol-west-end-2026' }, b: { id: 'a-christmas-carol-off-broadway-2026' }, reason: 'incomplete-stub' }],
    },
  ];
  const baseline = baselineKeySet([{ a: 'a-christmas-carol-west-end-2026', b: 'a-christmas-carol-off-broadway-2026' }]);
  assert.deepEqual(computeNewViolators(clusters, baseline), []);
});

test('computeNewViolators: baseline hit is order-independent (b/a swapped in baseline)', () => {
  const clusters = [
    {
      key: 'christmas carol|2026',
      pairs: [{ a: { id: 'show-a' }, b: { id: 'show-b' }, reason: 'incomplete-stub' }],
    },
  ];
  const baseline = baselineKeySet([{ a: 'show-b', b: 'show-a' }]);
  assert.deepEqual(computeNewViolators(clusters, baseline), []);
});

test('computeNewViolators: flags a pair not in the baseline, keeps baselined ones out', () => {
  const clusters = [
    {
      key: 'some title|2026',
      pairs: [
        { a: { id: 'known-a' }, b: { id: 'known-b' }, reason: 'incomplete-stub' },
        { a: { id: 'new-a' }, b: { id: 'new-b' }, reason: 'shared-venue-token:globe' },
      ],
    },
  ];
  const baseline = baselineKeySet([{ a: 'known-a', b: 'known-b' }]);
  const result = computeNewViolators(clusters, baseline);
  assert.equal(result.length, 1);
  assert.equal(result[0].pairs.length, 1);
  assert.equal(result[0].pairs[0].a.id, 'new-a');
});

test('computeNewViolators: a cluster fully covered by the baseline is dropped, not left empty', () => {
  const clusters = [
    { key: 'x', pairs: [{ a: { id: 'p1' }, b: { id: 'p2' }, reason: 'r' }] },
  ];
  const baseline = baselineKeySet([{ a: 'p1', b: 'p2' }]);
  assert.deepEqual(computeNewViolators(clusters, baseline), []);
});

test('computeNewViolators: reason drift does not create a false-new finding', () => {
  const clusters = [
    { key: 'x', pairs: [{ a: { id: 'p1' }, b: { id: 'p2' }, reason: 'shared-venue-token:globe' }] },
  ];
  // Baselined under a different reason (e.g. was incomplete-stub last run) —
  // identity is (a.id, b.id) only, so this still counts as baselined.
  const baseline = baselineKeySet([{ a: 'p1', b: 'p2' }]);
  assert.deepEqual(computeNewViolators(clusters, baseline), []);
});

test('computeNewViolators: empty baseline flags every pair', () => {
  const clusters = [
    { key: 'x', pairs: [{ a: { id: 'p1' }, b: { id: 'p2' }, reason: 'r' }] },
  ];
  const result = computeNewViolators(clusters, baselineKeySet([]));
  assert.equal(result.length, 1);
});

test('computeNewViolators: tolerates an empty clusters array', () => {
  assert.deepEqual(computeNewViolators([], baselineKeySet([{ a: 'x', b: 'y' }])), []);
  assert.deepEqual(computeNewViolators(undefined, baselineKeySet([{ a: 'x', b: 'y' }])), []);
});
