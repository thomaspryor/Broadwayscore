/**
 * BRO-4875: --recreate-draft must never put a second draft next to a sent
 * (or possibly sent) broadcast. Per CLAUDE.md §15: require() the real module.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { collectRecreateDraftIds, recreateDraftBlockReason } = require('../../scripts/lib/recreate-draft-guard.js');

const SHOW = 'into-the-woods-noel-coward-west-end-2026';
const KEY = `west-end:${SHOW}`;
const draftRec = { draftId: 'd1', completed: true, draftStatus: 'draft', sentAt: null, broadcastKey: KEY };

test('collect: broadcastKey + per-show mirror share one draftId, both cleared', () => {
  const r = collectRecreateDraftIds({ [KEY]: draftRec, [SHOW]: draftRec }, KEY, [SHOW]);
  assert.equal(r.blockReason, null);
  assert.deepEqual(r.draftIds, ['d1']);
  assert.deepEqual(r.keys.sort(), [KEY, SHOW].sort());
});

test('collect: old combo draft is found when every show in it is recreated', () => {
  const comboKey = `west-end:a-show+${SHOW}`;
  const combo = { ...draftRec, draftId: 'd2', broadcastKey: comboKey };
  const r = collectRecreateDraftIds({ [comboKey]: combo, [SHOW]: combo, 'a-show': combo }, comboKey, ['a-show', SHOW]);
  assert.equal(r.blockReason, null);
  assert.deepEqual(r.draftIds, ['d2']);
  assert.equal(r.keys.length, 3);
});

test('collect: refuses to delete a combo draft when a show in it is left out', () => {
  const comboKey = `west-end:a-show+${SHOW}`;
  const combo = { ...draftRec, draftId: 'd2', broadcastKey: comboKey };
  // via the combo key itself
  assert.match(collectRecreateDraftIds({ [comboKey]: combo }, KEY, [SHOW]).blockReason, /also covers a-show/);
  // via a per-show mirror whose broadcastKey names the combo
  assert.match(collectRecreateDraftIds({ [SHOW]: combo }, KEY, [SHOW]).blockReason, /also covers a-show/);
});

test('collect: previews, overdue alerts and unrelated shows are ignored', () => {
  const r = collectRecreateDraftIds({
    [`preview:west-end:${SHOW}:x`]: { sentAt: 'x' },
    [`overdue-alert:${SHOW}`]: { sentAt: 'x' },
    'west-end:other-show': { ...draftRec, draftId: 'zz' },
  }, KEY, [SHOW]);
  assert.deepEqual(r, { keys: [], draftIds: [], blockReason: null });
});

test('collect: any record already sent refuses', () => {
  const sent = { ...draftRec, draftStatus: 'sent', sentAt: '2026-10-08T15:00:00Z' };
  assert.match(collectRecreateDraftIds({ [KEY]: draftRec, [SHOW]: sent }, KEY, [SHOW]).blockReason, /already sent/);
  // legacy completed record with no draftId counts as sent
  assert.match(collectRecreateDraftIds({ [SHOW]: { completed: true } }, KEY, [SHOW]).blockReason, /already sent/);
  // deleted (404) after completed reads as sent too
  assert.match(collectRecreateDraftIds({ [SHOW]: { ...draftRec, draftStatus: 'deleted' } }, KEY, [SHOW]).blockReason, /already sent/);
});

test('live status: only draft and cancelled are safe', () => {
  assert.equal(recreateDraftBlockReason({ ok: true, data: { status: 'draft' } }), null);
  assert.equal(recreateDraftBlockReason({ ok: true, data: { status: 'Cancelled' } }), null);
  for (const s of ['sent', 'queued', 'sending', 'weird', '']) {
    assert.ok(recreateDraftBlockReason({ ok: true, data: { status: s } }), s);
  }
});

test('live status: 404 (deleted) is NOT safe, Resend also reaps sent broadcasts', () => {
  assert.match(recreateDraftBlockReason({ ok: true, data: { status: 'deleted' } }), /404/);
});

test('live status: GET failures fail closed', () => {
  assert.ok(recreateDraftBlockReason({ ok: false, statusCode: 500, error: 'HTTP 500' }));
  assert.ok(recreateDraftBlockReason({ ok: false, error: 'timeout' }));
  assert.ok(recreateDraftBlockReason(undefined));
});
