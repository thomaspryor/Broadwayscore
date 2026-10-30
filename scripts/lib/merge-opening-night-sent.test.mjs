import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeOpeningNightSent } from './merge-opening-night-sent.js';

test('mergeOpeningNightSent: unions remote-only keys', () => {
  const ours = { shows: { a: { sentAt: '2026-01-01' } } };
  const remote = { shows: { a: { sentAt: '2026-01-01' }, b: { sentAt: '2026-01-02' } } };
  const { merged, stats } = mergeOpeningNightSent(ours, remote);
  assert.deepEqual(Object.keys(merged.shows).sort(), ['a', 'b']);
  assert.equal(stats.added, 1);
});

test('mergeOpeningNightSent: keeps local-only key', () => {
  const ours = { shows: { a: { sentAt: '2026-01-01' } } };
  const remote = { shows: {} };
  const { merged } = mergeOpeningNightSent(ours, remote);
  assert.ok(merged.shows.a);
});

test('mergeOpeningNightSent: ours wins on a shared key with no comparable timestamp (default winner preserved)', () => {
  const ours = { shows: { a: { sentAt: 'ours' } } };
  const remote = { shows: { a: { sentAt: 'remote' } } };
  const { merged } = mergeOpeningNightSent(ours, remote);
  assert.equal(merged.shows.a.sentAt, 'ours');
});

test('mergeOpeningNightSent: handles missing shows key on either side', () => {
  const { merged } = mergeOpeningNightSent(undefined, { shows: { a: {} } });
  assert.ok(merged.shows.a);
});

// task #1914: reconcile-broadcast-state.js repeatedly mutates existing keys
// (draft→sending→sent), which broke this file's original "each key is
// written once" assumption. A push-core-data conflict during a cron run
// must not restore an older draftStatus over a newer one.
test('mergeOpeningNightSent: remote content strictly newer than ours -> remote wins (recency, not position)', () => {
  const ours = {
    shows: {
      'cats-2026': { draftStatus: 'queued', draftCreatedAt: '2026-04-11T12:00:00Z' },
    },
  };
  const remote = {
    shows: {
      'cats-2026': {
        draftStatus: 'sent',
        sentAt: '2026-04-11T12:05:00Z',
        recipientCount: 5000,
        draftCreatedAt: '2026-04-11T12:00:00Z',
      },
    },
  };
  const { merged, stats } = mergeOpeningNightSent(ours, remote);
  assert.equal(merged.shows['cats-2026'].draftStatus, 'sent');
  assert.equal(merged.shows['cats-2026'].recipientCount, 5000);
  assert.equal(stats.remoteNewer, 1);
});

test('mergeOpeningNightSent: ours content strictly newer than remote -> ours wins', () => {
  const ours = {
    shows: {
      'cats-2026': { draftStatus: 'sent', sentAt: '2026-04-11T12:05:00Z' },
    },
  };
  const remote = {
    shows: {
      'cats-2026': { draftStatus: 'queued', draftCreatedAt: '2026-04-11T12:00:00Z' },
    },
  };
  const { merged, stats } = mergeOpeningNightSent(ours, remote);
  assert.equal(merged.shows['cats-2026'].draftStatus, 'sent');
  assert.equal(stats.remoteNewer, 0);
  assert.equal(stats.kept, 1);
});

test('mergeOpeningNightSent: a fresh no-op reconciler poll (lastReconciledAt only) does NOT outrank a genuinely newer sentAt', () => {
  const ours = {
    shows: {
      'cats-2026': { draftStatus: 'queued', lastReconciledAt: '2026-04-11T23:59:00Z' },
    },
  };
  const remote = {
    shows: {
      'cats-2026': { draftStatus: 'sent', sentAt: '2026-04-11T12:00:00Z' },
    },
  };
  const { merged } = mergeOpeningNightSent(ours, remote);
  assert.equal(merged.shows['cats-2026'].draftStatus, 'sent');
});

// BRO-6634: a reconcile push from an older checkout must not drop the
// owner-notice stamps, or the next run repeats the "draft updated" email
// and restarts the reminder count.
test('mergeOpeningNightSent: keeps newer draft update/reminder stamps whichever copy wins', () => {
  const base = { completed: true, draftId: 'd1', draftStatus: 'draft', sentAt: null, draftCreatedAt: '2026-10-30T14:00:00Z', reviewCount: 22 };
  const stamped = { ...base, draftNumbers: { x: { score: 60, reviewCount: 23 } }, draftUpdatedAt: '2026-10-30T16:00:00Z', reviewCount: 23, draftReminderAt: '2026-10-30T20:00:00Z', draftReminderCount: 1 };
  const reconciled = { ...base, lastReconciledAt: '2026-10-30T21:00:00Z' };
  // Reconcile is the pushing side (ours), our stamps are on origin (remote).
  const a = mergeOpeningNightSent({ shows: { k: reconciled } }, { shows: { k: stamped } }).merged.shows.k;
  assert.equal(a.draftUpdatedAt, stamped.draftUpdatedAt);
  assert.deepEqual(a.draftNumbers, stamped.draftNumbers);
  assert.equal(a.reviewCount, 23);
  assert.equal(a.draftReminderCount, 1);
  assert.equal(a.lastReconciledAt, reconciled.lastReconciledAt, 'winner keeps its own fields');
  // A sent record from another writer still wins, stamps or not.
  const sent = { ...base, draftStatus: 'sent', sentAt: '2026-10-30T22:00:00Z' };
  const b = mergeOpeningNightSent({ shows: { k: stamped } }, { shows: { k: sent } }).merged.shows.k;
  assert.equal(b.draftStatus, 'sent');
  // Different draft (recreated): stamps from the old draft are not carried.
  const other = { ...base, draftId: 'd2', draftCreatedAt: '2026-10-30T23:00:00Z' };
  const c = mergeOpeningNightSent({ shows: { k: stamped } }, { shows: { k: other } }).merged.shows.k;
  assert.equal(c.draftId, 'd2');
  assert.equal(c.draftUpdatedAt, undefined);
});
