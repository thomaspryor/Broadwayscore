import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recordRecencyMs, RECENCY_FIELDS } from './tracker-record-recency.js';

test('recordRecencyMs: null/undefined/non-object -> 0', () => {
  assert.equal(recordRecencyMs(null), 0);
  assert.equal(recordRecencyMs(undefined), 0);
  assert.equal(recordRecencyMs('nope'), 0);
});

test('recordRecencyMs: no recognized fields -> 0', () => {
  assert.equal(recordRecencyMs({ draftStatus: 'sent', completed: true }), 0);
});

test('recordRecencyMs: single valid ISO field parses', () => {
  const ms = Date.parse('2026-04-11T12:00:00Z');
  assert.equal(recordRecencyMs({ sentAt: '2026-04-11T12:00:00Z' }), ms);
});

test('recordRecencyMs: takes MAX across multiple recognized fields', () => {
  const record = {
    draftCreatedAt: '2026-04-10T00:00:00Z',
    sentAt: '2026-04-11T12:00:00Z',
  };
  assert.equal(recordRecencyMs(record), Date.parse('2026-04-11T12:00:00Z'));
});

test('recordRecencyMs: unparseable field values are ignored, not NaN-poisoning', () => {
  const record = { sentAt: 'REMOTE', draftCreatedAt: '2026-04-11T12:00:00Z' };
  assert.equal(recordRecencyMs(record), Date.parse('2026-04-11T12:00:00Z'));
});

test('recordRecencyMs: lastReconciledAt is deliberately excluded (observation stamp, not content stamp)', () => {
  // A record whose only timestamp is a fresh no-op reconciler poll must not
  // out-rank a record with no timestamp at all — both should read as 0, the
  // same "no comparable content timestamp" signal, or a stale-but-recently
  // -polled record would silently outrank a genuinely newer write elsewhere.
  const record = { draftStatus: 'queued', lastReconciledAt: '2026-04-11T23:59:00Z' };
  assert.equal(recordRecencyMs(record), 0);
});

test('recordRecencyMs: _migratedAt is deliberately excluded (stamps when a legacy record was touched, not when its content changed)', () => {
  // A pre-#1853 legacy record that just got migrated (stamped with "now")
  // must not out-rank a record with no timestamp at all — the migration
  // event tells you nothing about when this record's real-world state last
  // changed, so treating it as content recency would let a genuinely-stale
  // legacy record win purely because it happened to get migrated recently.
  const record = { draftStatus: 'sent', completed: true, _migratedAt: '2026-04-11T23:59:00Z' };
  assert.equal(recordRecencyMs(record), 0);
});

test('RECENCY_FIELDS excludes both observation-stamp fields (lastReconciledAt, _migratedAt)', () => {
  assert.equal(RECENCY_FIELDS.includes('lastReconciledAt'), false);
  assert.equal(RECENCY_FIELDS.includes('_migratedAt'), false);
  assert.deepEqual(RECENCY_FIELDS, ['sentAt', 'draftCreatedAt']);
});
