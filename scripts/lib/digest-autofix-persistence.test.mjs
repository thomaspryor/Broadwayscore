// BRO-4487: a digest row gets a card only after its condition has been present
// for 3 days; younger rows render as 'watching'.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { persistenceKey, applyPersistenceGate, PERSIST_BEFORE_FILING_HOURS } = require('./digest-autofix.js');

const H = 3600 * 1000;
const NOW = Date.parse('2026-10-02T12:00:00Z');
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();
const row = (title, extra = {}) => ({ title, state: 'needs-card', ...extra });

test('persistenceKey: count tokens normalize, distinct identifiers stay distinct', () => {
  const a = persistenceKey(row('BSC Daily: Bright Data daily breaker TRIPPED: web_unlocker2 (438/250 reqs)'));
  const b = persistenceKey(row('BSC Daily: Bright Data daily breaker TRIPPED: web_unlocker2 (1048/250 reqs)'));
  const c = persistenceKey(row('BSC Daily: Bright Data daily breaker TRIPPED: serp_api1 (40/25 reqs)'));
  assert.equal(a, b, 'same condition on different days');
  assert.notEqual(a, c, 'serp_api1 vs web_unlocker2 are different conditions');
  assert.notEqual(persistenceKey(row('BSC Daily: Stale tag (batch 2)')), persistenceKey(row('BSC Daily: Stale tag (batch 3)')), 'batch spills stay distinct');
  assert.equal(persistenceKey(row('anything', { conditionKey: 'health-check:X' })), 'ck:health-check:X', 'conditionKey wins when present');
});

test('applyPersistenceGate: a first sighting is watched, not filed', () => {
  const plan = [row('BSC Daily: New thing')];
  const seen = applyPersistenceGate(plan, {}, NOW);
  assert.equal(plan[0].state, 'watching');
  const entry = seen[persistenceKey(plan[0])];
  assert.equal(entry.firstSeen, new Date(NOW).toISOString());
});

test('applyPersistenceGate: a condition present for 3+ days is filed', () => {
  const plan = [row('BSC Daily: Old thing')];
  const key = persistenceKey(plan[0]);
  applyPersistenceGate(plan, { [key]: { firstSeen: iso((PERSIST_BEFORE_FILING_HOURS + 1) * H), lastSeen: iso(24 * H) } }, NOW);
  assert.equal(plan[0].state, 'needs-card');
});

test('applyPersistenceGate: a 96h+ gap restarts the clock', () => {
  const plan = [row('BSC Daily: Flappy thing')];
  const key = persistenceKey(plan[0]);
  const seen = applyPersistenceGate(plan, { [key]: { firstSeen: iso(300 * H), lastSeen: iso(100 * H) } }, NOW);
  assert.equal(plan[0].state, 'watching');
  assert.equal(seen[key].firstSeen, new Date(NOW).toISOString());
});

test('applyPersistenceGate: only needs-card rows are held; tracked/in-progress rows are untouched', () => {
  const plan = [row('BSC Daily: A', { state: 'queued' }), row('BSC Daily: B', { state: 'in-progress' }), row('BSC Daily: C', { state: 'decision' })];
  applyPersistenceGate(plan, {}, NOW);
  assert.deepEqual(plan.map((r) => r.state), ['queued', 'in-progress', 'decision']);
});

test('applyPersistenceGate: sightings older than 14 days are pruned', () => {
  const seen = applyPersistenceGate([], { 't:gone': { firstSeen: iso(40 * 24 * H), lastSeen: iso(20 * 24 * H) }, 't:recent': { firstSeen: iso(5 * 24 * H), lastSeen: iso(2 * 24 * H) } }, NOW);
  assert.deepEqual(Object.keys(seen), ['t:recent']);
});
