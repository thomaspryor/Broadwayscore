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
