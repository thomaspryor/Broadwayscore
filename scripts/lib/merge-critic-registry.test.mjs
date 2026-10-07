import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeCriticRegistry } from './merge-critic-registry.js';

test('mergeCriticRegistry: picks the remote snapshot when it is newer', () => {
  const ours = { critics: { a: {} }, _meta: { lastUpdated: '2026-01-01T00:00:00.000Z' } };
  const remote = { critics: { a: {}, b: {} }, _meta: { lastUpdated: '2026-06-01T00:00:00.000Z' } };
  const { merged, stats } = mergeCriticRegistry(ours, remote);
  assert.equal(stats.chose, 'remote');
  assert.deepEqual(Object.keys(merged.critics).sort(), ['a', 'b']);
});

test('mergeCriticRegistry: keeps ours when it is newer', () => {
  const ours = { critics: { a: {} }, _meta: { lastUpdated: '2026-06-01T00:00:00.000Z' } };
  const remote = { critics: { a: {} }, _meta: { lastUpdated: '2026-01-01T00:00:00.000Z' } };
  const { merged, stats } = mergeCriticRegistry(ours, remote);
  assert.equal(stats.chose, 'ours');
  assert.equal(merged, ours);
});

test('mergeCriticRegistry: keeps ours when neither side has a timestamp', () => {
  const ours = { critics: { a: {} } };
  const remote = { critics: { b: {} } };
  const { merged, stats } = mergeCriticRegistry(ours, remote);
  assert.equal(stats.chose, 'ours');
  assert.equal(merged, ours);
});
