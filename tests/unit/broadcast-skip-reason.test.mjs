// BRO-7890 item 9: the send script's dry run said "already broadcast (completed)" for a draft that was created and
// never sent. The skip reason must come from draftStatus/sentAt (classifyBroadcastState), not `completed` alone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { skipReasonForRecord } = require('../../scripts/lib/missed-broadcasts.js');

test('an unsent draft is reported as NOT sent, with its link', () => {
  const r = skipReasonForRecord({ completed: true, draftId: 'd1', draftStatus: 'draft', draftCreatedAt: '2026-11-20T04:00:00Z', draftUrl: 'https://resend.example/d1' });
  assert.match(r, /NOT sent/);
  assert.match(r, /resend\.example\/d1/);
  assert.doesNotMatch(r, /already (sent|broadcast)/);
});

test('a sent draft says sent', () => {
  assert.match(skipReasonForRecord({ completed: true, draftId: 'd1', draftStatus: 'sent', sentAt: '2026-11-20T12:00:00Z' }), /^already sent at 2026-11-20T12:00:00Z/);
});

test('discarded and gone drafts are named', () => {
  assert.match(skipReasonForRecord({ completed: false, draftId: 'd1', draftStatus: 'deleted', discardedAt: '2026-11-20T05:00:00Z' }), /discarded/);
  assert.match(skipReasonForRecord({ completed: false, draftId: 'd1', draftStatus: 'deleted' }), /gone from Resend/);
  assert.equal(skipReasonForRecord(null), 'no draft on record');
});
