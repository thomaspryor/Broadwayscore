/**
 * Unit tests for scripts/lib/broadcast-state.js.
 *
 * Guards the state-machine that send-opening-night-broadcast.js +
 * reconcile-broadcast-state.js share. The 3-layer double-send prevention
 * still backstops audience-facing sends, but these tests guarantee we never
 * silently leave a cancelled draft marked as completed (the Schmigadoon 2026
 * structural finding that motivated this work).
 *
 * Per CLAUDE.md §15: require() the real module — never duplicate its logic.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const {
  parseResendStatus,
  migrateSentRecord,
  applyResendStatusUpdate,
  shouldRequeueShow,
  REQUEUE_AFTER_HOURS,
} = require(path.join(__dirname, '..', '..', 'scripts', 'lib', 'broadcast-state.js'));

// ---- parseResendStatus ----
test('parseResendStatus: known values pass through', () => {
  for (const s of ['draft', 'queued', 'sending', 'sent', 'cancelled', 'deleted']) {
    assert.equal(parseResendStatus(s), s);
  }
});

test('parseResendStatus: case-insensitive', () => {
  assert.equal(parseResendStatus('SENT'), 'sent');
  assert.equal(parseResendStatus('Cancelled'), 'cancelled');
});

test('parseResendStatus: unknown → draft (conservative)', () => {
  assert.equal(parseResendStatus('gibberish'), 'draft');
  assert.equal(parseResendStatus(null), 'draft');
  assert.equal(parseResendStatus(undefined), 'draft');
  assert.equal(parseResendStatus(''), 'draft');
});

// ---- migrateSentRecord ----
test('migrateSentRecord: legacy completed+draftId → sent', () => {
  const legacy = { draftId: 'xyz', completed: true, draftCreatedAt: '2026-03-01T00:00:00Z' };
  const m = migrateSentRecord(legacy);
  assert.equal(m.draftStatus, 'sent');
  assert.equal(m.sentAt, '2026-03-01T00:00:00Z');
  assert.equal(m.completed, true);
});

test('migrateSentRecord: legacy completed without draftId → sent', () => {
  const legacy = { completed: true };
  const m = migrateSentRecord(legacy);
  assert.equal(m.draftStatus, 'sent');
});

test('migrateSentRecord: in-flight legacy (no completed) → draft', () => {
  const legacy = { draftId: 'abc' };
  const m = migrateSentRecord(legacy);
  assert.equal(m.draftStatus, 'draft');
});

test('migrateSentRecord: already migrated is a noop', () => {
  const migrated = { draftId: 'x', draftStatus: 'cancelled', completed: false };
  const m = migrateSentRecord(migrated);
  assert.equal(m, migrated);
});

test('migrateSentRecord: rejects non-object input gracefully', () => {
  assert.equal(migrateSentRecord(null), null);
  assert.equal(migrateSentRecord(undefined), undefined);
});

// ---- applyResendStatusUpdate ----
test('applyResendStatusUpdate: status=sent marks completed + records sentAt + recipients', () => {
  const rec = { draftId: 'd', draftStatus: 'draft', completed: true };
  const updated = applyResendStatusUpdate(rec, { status: 'sent', sent_at: '2026-04-22T13:00:00Z', total_recipients: 158 });
  assert.equal(updated.draftStatus, 'sent');
  assert.equal(updated.completed, true);
  assert.equal(updated.sentAt, '2026-04-22T13:00:00Z');
  assert.equal(updated.recipientCount, 158);
  assert.ok(updated.lastReconciledAt);
});

test('applyResendStatusUpdate: status=cancelled flips completed to false + clears sentAt', () => {
  const rec = { draftId: 'd', draftStatus: 'draft', completed: true, sentAt: '2026-04-22T13:00:00Z' };
  const updated = applyResendStatusUpdate(rec, { status: 'cancelled' });
  assert.equal(updated.draftStatus, 'cancelled');
  assert.equal(updated.completed, false);
  assert.equal(updated.sentAt, null);
});

test('applyResendStatusUpdate: status=deleted flips completed to false (404 case)', () => {
  const rec = { draftId: 'd', draftStatus: 'draft', completed: true };
  const updated = applyResendStatusUpdate(rec, { status: 'deleted' });
  assert.equal(updated.draftStatus, 'deleted');
  assert.equal(updated.completed, false);
});

test('applyResendStatusUpdate: intermediate status=queued does not modify completed', () => {
  const rec = { draftId: 'd', draftStatus: 'draft', completed: true };
  const updated = applyResendStatusUpdate(rec, { status: 'queued' });
  assert.equal(updated.draftStatus, 'queued');
  assert.equal(updated.completed, true);
});

test('applyResendStatusUpdate: does not mutate input', () => {
  const rec = { draftId: 'd', draftStatus: 'draft', completed: true };
  applyResendStatusUpdate(rec, { status: 'sent', sent_at: 'x' });
  assert.equal(rec.draftStatus, 'draft');
  assert.equal(rec.completed, true);
});

// ---- shouldRequeueShow ----
test('shouldRequeueShow: never-sent record → requeue', () => {
  assert.equal(shouldRequeueShow(null), true);
  assert.equal(shouldRequeueShow({}), true);
  assert.equal(shouldRequeueShow({ completed: false }), true);
});

test('shouldRequeueShow: completed=true + draft=sent → do NOT requeue', () => {
  const rec = { completed: true, draftStatus: 'sent', sentAt: '2026-04-22T13:00:00Z', draftCreatedAt: '2026-04-22T12:30:00Z' };
  assert.equal(shouldRequeueShow(rec), false);
});

test('shouldRequeueShow: cancelled draft within 12h window → do NOT requeue yet', () => {
  const createdAt = new Date(Date.now() - 2 * 3600 * 1000).toISOString(); // 2h ago
  const rec = { completed: true, draftStatus: 'cancelled', draftCreatedAt: createdAt };
  assert.equal(shouldRequeueShow(rec), false);
});

test('shouldRequeueShow: cancelled draft >= 12h ago → requeue', () => {
  const createdAt = new Date(Date.now() - (REQUEUE_AFTER_HOURS + 1) * 3600 * 1000).toISOString();
  const rec = { completed: true, draftStatus: 'cancelled', draftCreatedAt: createdAt };
  assert.equal(shouldRequeueShow(rec), true);
});

test('shouldRequeueShow: deleted draft >= 12h ago → requeue', () => {
  const createdAt = new Date(Date.now() - 20 * 3600 * 1000).toISOString();
  const rec = { completed: true, draftStatus: 'deleted', draftCreatedAt: createdAt };
  assert.equal(shouldRequeueShow(rec), true);
});

test('shouldRequeueShow: terminal failure with unparsable draftCreatedAt → do NOT requeue (fail-safe)', () => {
  const rec = { completed: true, draftStatus: 'cancelled', draftCreatedAt: 'not-a-date' };
  assert.equal(shouldRequeueShow(rec), false);
});

test('shouldRequeueShow: takes explicit nowMs for deterministic tests', () => {
  const createdAt = '2026-04-01T00:00:00Z';
  const rec = { completed: true, draftStatus: 'cancelled', draftCreatedAt: createdAt };
  // 11h later — under threshold
  assert.equal(shouldRequeueShow(rec, Date.parse('2026-04-01T11:00:00Z')), false);
  // 13h later — over threshold
  assert.equal(shouldRequeueShow(rec, Date.parse('2026-04-01T13:00:00Z')), true);
});

// ---- Synthetic round-trip: reconciler flow ----
test('round-trip: migrated+sent record stays sent', () => {
  const legacy = { draftId: 'd', completed: true, draftCreatedAt: '2026-03-24T12:30:00Z' };
  const migrated = migrateSentRecord(legacy);
  const afterPoll = applyResendStatusUpdate(migrated, { status: 'sent', sent_at: '2026-03-24T13:05:00Z', total_recipients: 161 });
  assert.equal(afterPoll.draftStatus, 'sent');
  assert.equal(afterPoll.completed, true);
  assert.equal(shouldRequeueShow(afterPoll), false);
});

test('round-trip: Tom cancels the draft — record flips + 12h later show requeues', () => {
  const createdAt = new Date(Date.now() - 13 * 3600 * 1000).toISOString();
  const rec = { draftId: 'd', draftStatus: 'draft', completed: true, draftCreatedAt: createdAt };
  const afterPoll = applyResendStatusUpdate(rec, { status: 'cancelled' });
  assert.equal(afterPoll.draftStatus, 'cancelled');
  assert.equal(afterPoll.completed, false);
  // completed=false → requeue is automatic
  assert.equal(shouldRequeueShow(afterPoll), true);
});
