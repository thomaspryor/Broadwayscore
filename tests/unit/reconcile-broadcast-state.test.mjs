/**
 * Integration tests for scripts/reconcile-broadcast-state.js.
 *
 * Purpose: close the composition gap between getBroadcast's HTTP-status
 * routing and applyResendStatusUpdate's retention-reap protection.
 *
 * The retention-reap protection in scripts/lib/broadcast-state.js only
 * engages when the helper receives `{status: 'deleted'}`. If a refactor
 * changes the reconciler's 404 handling to return null / `{ok:false}` /
 * anything else, the protection silently stops engaging and a previously-
 * sent broadcast would flip to `completed:false` at the next reconciler
 * poll and duplicate-send 12h later.
 *
 * These tests pin the contract: parseBroadcastResponse(404) → deleted →
 * applyResendStatusUpdate preserves completed on a previously-sent record.
 *
 * Context: memory/feedback_404_not_terminal.md and commit b636854001.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { parseBroadcastResponse } = require(
  path.join(__dirname, '..', '..', 'scripts', 'reconcile-broadcast-state.js'),
);
const { applyResendStatusUpdate } = require(
  path.join(__dirname, '..', '..', 'scripts', 'lib', 'broadcast-state.js'),
);

// ---- parseBroadcastResponse: HTTP status routing ----

test('parseBroadcastResponse: 200 with valid JSON → ok + parsed data', () => {
  const body = JSON.stringify({ id: 'abc', status: 'sent', sent_at: '2026-04-21T10:00:00Z' });
  const r = parseBroadcastResponse(200, body);
  assert.equal(r.ok, true);
  assert.equal(r.data.status, 'sent');
  assert.equal(r.data.sent_at, '2026-04-21T10:00:00Z');
});

test('parseBroadcastResponse: 200 with malformed JSON → ok:false + parse error', () => {
  const r = parseBroadcastResponse(200, 'not-json{');
  assert.equal(r.ok, false);
  assert.match(r.error, /^parse:/);
});

test('parseBroadcastResponse: 404 → ok:true + data.status === "deleted" (CRITICAL)', () => {
  // This is the routing contract that makes applyResendStatusUpdate's
  // retention-reap protection engage. If this test fails, the reap protection
  // is bypassed and sent broadcasts will be duplicate-sent on the next poll.
  const r = parseBroadcastResponse(404, '{"error":"not_found"}');
  assert.equal(r.ok, true, '404 must return ok:true so the helper sees the record');
  assert.equal(r.data.status, 'deleted', '404 must normalize to status:"deleted"');
});

test('parseBroadcastResponse: 404 with empty body still routes to deleted', () => {
  const r = parseBroadcastResponse(404, '');
  assert.equal(r.ok, true);
  assert.equal(r.data.status, 'deleted');
});

test('parseBroadcastResponse: 500 → ok:false + HTTP error', () => {
  const r = parseBroadcastResponse(500, 'internal error');
  assert.equal(r.ok, false);
  assert.match(r.error, /^HTTP 500:/);
});

test('parseBroadcastResponse: 401 → ok:false (auth error bubbles up, does not flip state)', () => {
  const r = parseBroadcastResponse(401, '{"error":"unauthorized"}');
  assert.equal(r.ok, false);
  assert.match(r.error, /^HTTP 401:/);
});

// ---- End-to-end composition: the actual bug-prevention contract ----

test('composition: 404 on previously-sent broadcast → completed PRESERVED (retention reap)', () => {
  // This is the real-world scenario from 2026-04-22 that drove the sweep.
  // the-balusters-2026 was successfully broadcast on 2026-04-21. ~24h later,
  // Resend had already reaped the broadcast id → 404. The reconciler polls,
  // sees 404, and must NOT flip completed back to false (which would cause
  // shouldRequeueShow to re-queue the show 12h later = duplicate send).
  const sentRecord = {
    draftId: 'broadcast-id-123',
    draftCreatedAt: '2026-04-21T20:00:00Z',
    draftStatus: 'sent',
    sentAt: '2026-04-21T20:15:00Z',
    recipientCount: 161,
    completed: true,
  };

  const httpResponse = parseBroadcastResponse(404, '');
  assert.equal(httpResponse.ok, true, 'routing step');

  const updated = applyResendStatusUpdate(sentRecord, httpResponse.data);

  assert.equal(updated.completed, true, 'completed must stay true after retention reap');
  assert.equal(updated.sentAt, '2026-04-21T20:15:00Z', 'sentAt must survive');
  assert.equal(updated.recipientCount, 161, 'recipientCount must survive');
  assert.equal(updated.draftStatus, 'deleted', 'draftStatus is updated to reflect reality');
});

test('composition: 404 on pre-send draft (never completed) → completed stays false', () => {
  // The other side of the 404 ambiguity: user manually deleted a draft in
  // the Resend UI before sending. We WANT to re-queue this — the send never
  // happened. This proves we can still distinguish the two cases.
  const draftRecord = {
    draftId: 'broadcast-id-456',
    draftCreatedAt: '2026-04-22T10:00:00Z',
    draftStatus: 'draft',
    sentAt: null,
    recipientCount: null,
    completed: false,
  };

  const httpResponse = parseBroadcastResponse(404, '');
  const updated = applyResendStatusUpdate(draftRecord, httpResponse.data);

  assert.equal(updated.completed, false, 'never-sent record stays not-completed');
  assert.equal(updated.sentAt, null);
  assert.equal(updated.draftStatus, 'deleted');
});

test('composition: 404 on legacy sent record (no draftStatus field) → completed PRESERVED', () => {
  // Records created before the draftStatus migration still exist in
  // opening-night-sent.json. They have completed:true but no draftStatus.
  // The retention-reap protection has a specific branch for this legacy
  // shape (see applyResendStatusUpdate:122-124).
  const legacyRecord = {
    draftId: 'broadcast-id-789',
    draftCreatedAt: '2026-03-01T18:00:00Z',
    completed: true,
    // Note: no draftStatus, no sentAt, no recipientCount
  };

  const httpResponse = parseBroadcastResponse(404, '');
  const updated = applyResendStatusUpdate(legacyRecord, httpResponse.data);

  assert.equal(
    updated.completed,
    true,
    'legacy completed:true without draftStatus must survive 404',
  );
});

test('composition: 200 with status:sent updates record normally (not-retention path)', () => {
  const pendingRecord = {
    draftId: 'broadcast-id-abc',
    draftCreatedAt: '2026-04-22T10:00:00Z',
    draftStatus: 'queued',
    completed: false,
  };

  const body = JSON.stringify({
    id: 'broadcast-id-abc',
    status: 'sent',
    sent_at: '2026-04-22T10:05:00Z',
    total_recipients: 200,
  });
  const httpResponse = parseBroadcastResponse(200, body);
  assert.equal(httpResponse.ok, true);

  const updated = applyResendStatusUpdate(pendingRecord, httpResponse.data);
  assert.equal(updated.completed, true);
  assert.equal(updated.draftStatus, 'sent');
  assert.equal(updated.sentAt, '2026-04-22T10:05:00Z');
  assert.equal(updated.recipientCount, 200);
});
