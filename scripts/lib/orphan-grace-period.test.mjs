import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { updateGraceState } = require('./orphan-grace-period.js');

const NOW = Date.parse('2026-09-16T12:00:00.000Z');

test('a newly-seen orphan id is NOT ready to delete', () => {
  const { readyToDelete, newState } = updateGraceState(['show-a'], null, NOW);
  assert.deepEqual(readyToDelete, []);
  assert.equal(newState.seen['show-a'], new Date(NOW).toISOString());
});

test('an id seen exactly graceHours ago IS ready to delete', () => {
  const seenAt = new Date(NOW - 24 * 3600000).toISOString();
  const { readyToDelete } = updateGraceState(['show-a'], { seen: { 'show-a': seenAt } }, NOW);
  assert.deepEqual(readyToDelete, ['show-a']);
});

test('an id seen less than graceHours ago is NOT ready to delete', () => {
  const seenAt = new Date(NOW - 23 * 3600000).toISOString();
  const { readyToDelete, newState } = updateGraceState(['show-a'], { seen: { 'show-a': seenAt } }, NOW);
  assert.deepEqual(readyToDelete, []);
  assert.equal(newState.seen['show-a'], seenAt);
});

test('an id that resolved (no longer orphaned) is dropped from state, not carried forward', () => {
  const seenAt = new Date(NOW - 48 * 3600000).toISOString();
  const { newState } = updateGraceState([], { seen: { 'show-a': seenAt } }, NOW);
  assert.deepEqual(newState.seen, {});
});

test('mixed batch: only ids past grace are returned, others keep their original first-seen timestamp', () => {
  const oldEnough = new Date(NOW - 30 * 3600000).toISOString();
  const tooNew = new Date(NOW - 2 * 3600000).toISOString();
  const { readyToDelete, newState } = updateGraceState(
    ['show-old', 'show-new', 'show-brand-new'],
    { seen: { 'show-old': oldEnough, 'show-new': tooNew } },
    NOW
  );
  assert.deepEqual(readyToDelete, ['show-old']);
  assert.equal(newState.seen['show-old'], oldEnough);
  assert.equal(newState.seen['show-new'], tooNew);
  assert.equal(newState.seen['show-brand-new'], new Date(NOW).toISOString());
});

test('a corrupt/unparseable stored timestamp restarts the grace clock instead of instant-deleting', () => {
  const { readyToDelete, newState } = updateGraceState(['show-a'], { seen: { 'show-a': 'not-a-date' } }, NOW);
  assert.deepEqual(readyToDelete, []);
  assert.equal(newState.seen['show-a'], new Date(NOW).toISOString());
});

test('a custom graceHours is respected', () => {
  const seenAt = new Date(NOW - 2 * 3600000).toISOString();
  const { readyToDelete } = updateGraceState(['show-a'], { seen: { 'show-a': seenAt } }, NOW, 1);
  assert.deepEqual(readyToDelete, ['show-a']);
});

test('empty currentIds and null previousState do not crash', () => {
  const { readyToDelete, newState } = updateGraceState([], null, NOW);
  assert.deepEqual(readyToDelete, []);
  assert.deepEqual(newState.seen, {});
});
