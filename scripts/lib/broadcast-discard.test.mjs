// BRO-2935: a draft deleted unsent on purpose must stay resolved in every
// consumer of opening-night-sent.json, and stale drafts must be found per draft.
import { test } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  markDraftDiscarded, isDiscarded, shouldRequeueShow, applyResendStatusUpdate, findStaleDrafts,
} = require('./broadcast-state.js');
const {
  classifyBroadcastState, classifyShowBroadcastState, findMissedBroadcasts, selectPageableStaleDrafts,
} = require('./missed-broadcasts.js');
const { collectRecreateDraftIds } = require('./recreate-draft-guard.js');
const { mergeTrackerEntries } = require('./opening-night-tracker-sync.js');
const { pastDeadlineShows } = require('./broadcast-deadline.js');

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 11, 12);
const draft = (over = {}) => ({
  draftId: 'd1', draftStatus: 'draft', completed: true, sentAt: null,
  draftCreatedAt: new Date(NOW - 10 * DAY).toISOString(), draftUrl: 'https://resend.com/broadcasts/d1', ...over,
});

test('markDraftDiscarded: terminal, unsent, never re-queued', () => {
  const d = markDraftDiscarded(draft(), { nowIso: '2026-10-11T00:00:00Z', reason: 'r' });
  assert.equal(d.completed, false);
  assert.equal(d.sentAt, null);
  assert.equal(d.draftStatus, 'deleted');
  assert.equal(d.discardedAt, '2026-10-11T00:00:00Z');
  assert.ok(isDiscarded(d));
  assert.equal(shouldRequeueShow(d, NOW), false, 'completed:false alone would re-queue');
  assert.equal(shouldRequeueShow({ ...draft(), completed: false }, NOW), true, 'control: undiscarded unsent still re-queues');
});

test('a 404 poll keeps the discard (applyResendStatusUpdate spreads the record)', () => {
  const d = markDraftDiscarded(draft(), { nowIso: '2026-10-11T00:00:00Z' });
  const after = applyResendStatusUpdate(d, { status: 'deleted' });
  assert.equal(after.discardedAt, d.discardedAt);
  assert.equal(after.completed, false);
});

test('missed-broadcasts: discarded is resolved, not draft-unknown', () => {
  const d = markDraftDiscarded(draft(), {});
  assert.equal(classifyBroadcastState(d), 'discarded');
  assert.equal(classifyBroadcastState({ ...draft(), draftStatus: 'deleted', completed: false }), 'draft-unknown');
  assert.equal(classifyShowBroadcastState({ s: d }, 's'), 'discarded');
  const shows = [{ id: 's', title: 'S', status: 'open', category: 'west-end', openingDate: '2026-10-05' }];
  const reviews = Array.from({ length: 20 }, (_, i) => ({ showId: 's', assignedScore: 70, outletId: `o${i}`, criticName: `c${i}` }));
  assert.deepEqual(findMissedBroadcasts({ shows, sentShows: { s: d }, reviews, now: NOW }), []);
});

test('recreate guard skips a discarded record instead of refusing on its 404', () => {
  const d = markDraftDiscarded(draft(), {});
  const r = collectRecreateDraftIds({ 's': d, 'west-end:s': d }, 'west-end:s', ['s']);
  assert.equal(r.blockReason, null);
  assert.deepEqual(r.draftIds, []);
});

test('deadline re-queue skips a discarded show', () => {
  const d = markDraftDiscarded({ ...draft(), completed: false }, {});
  const shows = [{ id: 's', status: 'open', category: 'west-end', openingDate: '2026-10-09' }];
  const call = (rec) => pastDeadlineShows({ showIds: ['s'], shows, sentShows: { s: rec }, nowMs: NOW });
  assert.deepEqual(call(d), []);
  assert.equal(call({ ...draft(), completed: false, draftCreatedAt: null }).length, 1, 'control: an owed show is past deadline');
});

test('merge: a discarded record beats a stale pre-discard copy', () => {
  const stale = draft();
  const d = markDraftDiscarded(stale, { nowIso: new Date(NOW).toISOString() });
  const merged = mergeTrackerEntries({ shows: { s: d } }, { shows: { s: stale } });
  assert.ok(isDiscarded(merged.shows.s), 'remote discard must survive a local stale write');
});

test('findStaleDrafts: one entry per draft, mirrors grouped, needs draftId and age', () => {
  const sent = {
    'west-end:a+b': draft(),
    a: draft({ broadcastKey: 'west-end:a+b' }),
    b: draft({ broadcastKey: 'west-end:a+b' }),
    young: draft({ draftId: 'd2', draftCreatedAt: new Date(NOW - 1 * DAY).toISOString() }),
    noid: { draftStatus: 'draft', completed: false },
    gone: markDraftDiscarded(draft({ draftId: 'd3' }), {}),
    'preview:a': draft({ draftId: 'd4' }),
  };
  const out = findStaleDrafts(sent, NOW);
  assert.equal(out.length, 1);
  assert.equal(out[0].draftId, 'd1');
  assert.deepEqual(out[0].showIds, ['a', 'b']);
  assert.equal(out[0].ageDays, 10);
});

test('findStaleDrafts: a sibling record that saw the send wins (BRO-4474)', () => {
  const sent = { 'west-end:a': draft({ draftStatus: 'sent', sentAt: '2026-10-02T00:00:00Z' }), a: draft() };
  assert.deepEqual(findStaleDrafts(sent, NOW), []);
});

test('selectPageableStaleDrafts: age cap and no double page with never-sent', () => {
  const s = [
    { draftId: 'x', showIds: ['a'], ageDays: 5 },
    { draftId: 'y', showIds: ['b'], ageDays: 5 },
    { draftId: 'z', showIds: ['c'], ageDays: 31 },
  ];
  assert.deepEqual(selectPageableStaleDrafts(s, { alertableMissedIds: ['a'] }).map((d) => d.draftId), ['y']);
});

test('selectPageableStaleDrafts: a draft the West End round-up fully covered does not page (BRO-3088)', () => {
  const s = [
    { draftId: 'x', showIds: ['a', 'b'], ageDays: 9 },
    { draftId: 'y', showIds: ['c'], ageDays: 9 },
  ];
  assert.deepEqual(selectPageableStaleDrafts(s, { roundupCoveredIds: ['a', 'b'] }).map((d) => d.draftId), ['y']);
  assert.deepEqual(selectPageableStaleDrafts(s, { roundupCoveredIds: ['a'] }).map((d) => d.draftId), ['x', 'y'],
    'a combo with one uncovered show still pages');
});
