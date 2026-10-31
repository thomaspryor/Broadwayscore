// The status pages' one reading of a show's broadcast (BRO-3087 follow-up).
// require()s the real function (CLAUDE.md §15); `now` is pinned.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { showBroadcastStatus } = require('./broadcast-status.js');
const { markDraftDiscarded } = require('./broadcast-state.js');

const now = new Date('2026-10-13T12:00:00Z');
const skipped = markDraftDiscarded({}, { nowIso: '2026-10-12T00:00:00Z', reason: 'skip' });
const st = (shows, id = 'x') => showBroadcastStatus(shows, id, 'broadway', now).state;

test('a skipped show is not-sent, even with an overdue alert or an older preview', () => {
  assert.equal(st({ x: skipped, 'overdue-alert:x': { sentAt: '2026-10-11T00:00:00Z' } }), 'not-sent');
  assert.equal(st({ x: skipped, 'preview:broadway:x:2026-10-10': { reviewCount: 9 } }), 'not-sent');
});

test('a skip recorded only on the combo record counts', () => {
  assert.equal(st({ 'broadway:x+y': skipped, 'overdue-alert:x': { sentAt: '2026-10-11T00:00:00Z' } }), 'not-sent');
});

test("today's preview after a skip shows (the owner reconsidered)", () => {
  assert.equal(st({ x: skipped, 'preview:broadway:x:2026-10-13': { reviewCount: 9, sentAt: '2026-10-13T10:00:00Z' } }), 'preview-sent');
});

test('without a skip: sent, overdue and waiting read as before', () => {
  assert.equal(st({ x: { completed: true, draftId: 'd', draftStatus: 'sent', sentAt: '2026-10-12T00:00:00Z' } }), 'complete');
  assert.equal(st({ x: { completed: true, draftId: 'd', draftStatus: 'draft' }, 'overdue-alert:x': { sentAt: '2026-10-12T00:00:00Z' } }), 'overdue');
  assert.equal(st({}), 'waiting');
  assert.equal(st({ 'preview:broadway:xy:2026-10-10': { reviewCount: 3 } }), 'waiting'); // another show's preview key
});

test('an earlier preview of a combo email counts for every show in it', () => {
  assert.equal(st({ 'preview:west-end:a+x+b:2026-09-08': { reviewCount: 30 } }), 'preview-sent-earlier');
});

// BRO-3087 retro-review (BRO-5261)
test('a stale discarded combo does not hide a newer draft waiting for the show', () => {
  const shows = {
    'broadway:x+y': skipped,
    x: { completed: true, draftId: 'd3', draftStatus: 'draft' },
    'broadway:x': { completed: true, draftId: 'd3', draftStatus: 'draft' },
    'overdue-alert:x': { sentAt: '2026-10-12T00:00:00Z' },
  };
  assert.equal(st(shows), 'overdue');
  // the same draft discarded on its market record still counts
  assert.equal(st({ x: { completed: true, draftId: 'd3', draftStatus: 'draft' }, 'broadway:x': { ...skipped, draftId: 'd3' } }), 'not-sent');
});

test("today's combo preview counts as today's preview, also after a skip", () => {
  const p = { 'preview:broadway:x+y:2026-10-13': { reviewCount: 9, sentAt: '2026-10-13T10:00:00Z' } };
  assert.equal(st(p), 'preview-sent');
  assert.equal(st({ x: skipped, ...p }), 'preview-sent');
});

test('the latest earlier preview is chosen by date, not by key order', () => {
  const r = showBroadcastStatus({
    'preview:broadway:x:2026-10-01': { reviewCount: 1 },
    'preview:broadway:a+x:2026-10-05': { reviewCount: 5 },
  }, 'x', 'broadway', now);
  assert.match(r.detail, /2026-10-05/);
});

test('a skip over a draft Resend had lost says it may have gone out', () => {
  const r = showBroadcastStatus({ x: { ...skipped, sendUnverified: true } }, 'x', 'broadway', now);
  assert.equal(r.state, 'not-sent');
  assert.match(r.detail, /may have gone out/);
});
