import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CORE_DATA_MERGE_REGISTRY, findEntry, activeEntriesFor } from './core-data-merge-registry.js';

test('every entry has a file, surface, and valid status', () => {
  const validStatuses = new Set(['active', 'special', 'deferred', 'single-writer']);
  for (const e of CORE_DATA_MERGE_REGISTRY) {
    assert.equal(typeof e.file, 'string');
    assert.ok(['public-repo', 'private-core-data'].includes(e.surface), `${e.file}: bad surface ${e.surface}`);
    assert.ok(validStatuses.has(e.status), `${e.file}: bad status ${e.status}`);
  }
});

test('every "active" entry has a callable merge function', () => {
  for (const e of CORE_DATA_MERGE_REGISTRY.filter((e) => e.status === 'active')) {
    assert.equal(typeof e.merge, 'function', `${e.file} (${e.surface}) is active but has no merge fn`);
  }
});

test('every "deferred" entry documents a reason', () => {
  for (const e of CORE_DATA_MERGE_REGISTRY.filter((e) => e.status === 'deferred')) {
    assert.equal(typeof e.deferredReason, 'string', `${e.file} is deferred but has no deferredReason`);
    assert.ok(e.deferredReason.length > 20, `${e.file}'s deferredReason is suspiciously short`);
  }
});

test('no duplicate (file, surface) pair', () => {
  const seen = new Set();
  for (const e of CORE_DATA_MERGE_REGISTRY) {
    const key = `${e.surface}:${e.file}`;
    assert.ok(!seen.has(key), `duplicate registry entry for ${key}`);
    seen.add(key);
  }
});

test('findEntry matches by exact basename or path suffix, scoped to a surface', () => {
  assert.equal(findEntry('awards.json', 'private-core-data')?.file, 'awards.json');
  assert.equal(findEntry('data/awards.json', 'public-repo')?.file, 'awards.json');
  assert.equal(findEntry('awards.json', 'public-repo')?.surface, 'public-repo');
  // A private-core-data-only file must not resolve on the public-repo surface.
  assert.equal(findEntry('critic-registry.json', 'public-repo'), null);
});

test('activeEntriesFor excludes entries with optInReconcile:false', () => {
  const publicActive = activeEntriesFor('public-repo');
  assert.ok(!publicActive.some((e) => e.file === 'audit/feedback-request-ledger.json'));
});

test('activeEntriesFor never crosses surfaces', () => {
  for (const e of activeEntriesFor('private-core-data')) assert.equal(e.surface, 'private-core-data');
  for (const e of activeEntriesFor('public-repo')) assert.equal(e.surface, 'public-repo');
});
