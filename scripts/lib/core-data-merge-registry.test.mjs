import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CORE_DATA_MERGE_REGISTRY, findEntry, activeEntriesFor, apiFallbackSafeEntriesFor } from './core-data-merge-registry.js';

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

test('every apiFallbackSafe entry carries the required verification fields', () => {
  // push-with-retry.sh's Git Data API fallback disqualifier grants a real
  // bypass on this claim — a missing concurrencyGroup/verifiedBy note is a
  // registry bug, not a documentation nicety (plan-review finding: the
  // whole point of these fields is that a future entry can't earn the
  // bypass on the strength of a single in-workflow comment alone, the
  // exact mistake that nearly seeded alert-digest-queue.json here).
  for (const e of CORE_DATA_MERGE_REGISTRY.filter((e) => e.apiFallbackSafe === true)) {
    assert.equal(e.surface, 'public-repo', `${e.file}: apiFallbackSafe is only meaningful on public-repo today`);
    assert.equal(e.status, 'single-writer', `${e.file}: apiFallbackSafe entries must be status:'single-writer'`);
    assert.equal(typeof e.concurrencyGroup, 'string', `${e.file}: missing concurrencyGroup`);
    assert.ok(e.concurrencyGroup.length > 0, `${e.file}: empty concurrencyGroup`);
    assert.equal(typeof e.verifiedBy, 'string', `${e.file}: missing verifiedBy`);
    assert.ok(e.verifiedBy.length > 20, `${e.file}: verifiedBy note is suspiciously short`);
  }
});

test('apiFallbackSafeEntriesFor never crosses surfaces and excludes non-flagged entries', () => {
  for (const e of apiFallbackSafeEntriesFor('public-repo')) {
    assert.equal(e.surface, 'public-repo');
    assert.equal(e.apiFallbackSafe, true);
  }
  // grosses.json is status:'single-writer' but NOT apiFallbackSafe — its
  // "safe" is a looser, lint-gate-only bar (two writers sharing a
  // concurrency group), not the stricter verification this list requires.
  assert.ok(!apiFallbackSafeEntriesFor('private-core-data').some((e) => e.file === 'grosses.json'));
});

test('apiFallbackSafeEntriesFor(public-repo) is disjoint from activeEntriesFor(public-repo)', () => {
  // An apiFallbackSafe entry must have no merge function to opt into — it's
  // status:'single-writer', never 'active' — so it can never also appear in
  // MANAGED (which reconcile-coverage.js's independent gate reads via
  // activeEntriesFor()). This is the invariant that keeps the two lists
  // from ever needing the same file to serve two different purposes.
  const activeFiles = new Set(activeEntriesFor('public-repo').map((e) => e.file));
  for (const e of apiFallbackSafeEntriesFor('public-repo')) {
    assert.ok(!activeFiles.has(e.file), `${e.file} is in both MANAGED and apiFallbackSafe — should be impossible`);
  }
});
