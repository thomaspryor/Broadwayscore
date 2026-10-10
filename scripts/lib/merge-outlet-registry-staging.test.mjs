// BRO-4401: data/audit/outlet-registry-staging.json is written by every
// rebuild (~20 workflows) and committed by push-core-data, so it needs a
// real union merge or a concurrent run's parked ids are lost to ours-wins.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { mergeOutletRegistryStaging } = require('./merge-outlet-registry-staging.js');

const row = (outletId, extra = {}) => ({
  outletId, reason: 'no-domain', domainHint: null, reviewCount: 1, exampleShowId: 'x',
  firstSeenAt: '2026-09-30T00:00:00.000Z', lastSeenAt: '2026-09-30T00:00:00.000Z', ...extra,
});

test('union by outletId: remote-only rows are re-added, ours wins on a shared id', () => {
  const ours = { updatedAt: '2026-09-30T02:00:00.000Z', staged: [row('vu', { reviewCount: 3 }), row('zebra')] };
  const remote = { updatedAt: '2026-09-30T01:00:00.000Z', staged: [row('vu', { reviewCount: 1 }), row('abc14')] };
  const { merged, stats } = mergeOutletRegistryStaging(ours, remote);
  assert.deepEqual(merged.staged.map((e) => e.outletId), ['abc14', 'vu', 'zebra']);
  assert.equal(merged.staged.find((e) => e.outletId === 'vu').reviewCount, 3);
  assert.deepEqual(stats, { added: 1, kept: 1, total: 3 });
  assert.equal(merged.updatedAt, '2026-09-30T02:00:00.000Z');
});

test('firstSeenAt keeps the EARLIER of the two on a shared id (the parked-since clock survives a race)', () => {
  const ours = { staged: [row('vu', { firstSeenAt: '2026-09-30T05:00:00.000Z' })] };
  const remote = { staged: [row('vu', { firstSeenAt: '2026-09-29T12:00:00.000Z' })] };
  const { merged } = mergeOutletRegistryStaging(ours, remote);
  assert.equal(merged.staged[0].firstSeenAt, '2026-09-29T12:00:00.000Z');
});

test('the _comment and other top-level fields survive; malformed sides are tolerated', () => {
  const ours = { _comment: 'c', staged: [row('vu')] };
  assert.deepEqual(mergeOutletRegistryStaging(ours, null).merged.staged.map((e) => e.outletId), ['vu']);
  assert.equal(mergeOutletRegistryStaging(ours, { staged: 'garbage' }).merged._comment, 'c');
  assert.deepEqual(mergeOutletRegistryStaging(undefined, undefined).merged.staged, []);
  assert.deepEqual(mergeOutletRegistryStaging({ staged: [null, { reason: 'x' }] }, { staged: [row('a')] }).merged.staged.map((e) => e.outletId), ['a']);
});

test('the registry wires this merge fn to the staging file as apiFallbackMerge', () => {
  const { CORE_DATA_MERGE_REGISTRY } = require('./core-data-merge-registry.js');
  const entry = CORE_DATA_MERGE_REGISTRY.find((e) => e.file === 'audit/outlet-registry-staging.json');
  assert.ok(entry, 'audit/outlet-registry-staging.json must be registered — an unregistered data/audit path disqualifies the Git Data API push fallback for every later step in the job');
  assert.equal(entry.status, 'active');
  assert.equal(entry.merge, mergeOutletRegistryStaging);
  assert.equal(entry.apiFallbackMerge, true);
  assert.equal(entry.format, 'json');
});
