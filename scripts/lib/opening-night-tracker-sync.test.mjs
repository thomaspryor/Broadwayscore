import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { mergeTrackerEntries, SYNC_REPO, SYNC_REMOTE_PATH } = require('./opening-night-tracker-sync.js');

// Ported from scripts/test-sync-tracker.js (not registered in CI — task #1853
// review flagged that the pure mergeTrackerEntries conflict semantics had no
// CI-executed coverage once this logic moved into a shared module used by
// two production callers). Colocated *.test.mjs runs automatically in the
// unit-tests job's scripts/lib/*.test.mjs glob — no test.yml change needed.

test('mergeTrackerEntries: empty remote + empty local -> { shows: {} }', () => {
  assert.deepEqual(mergeTrackerEntries({}, { shows: {} }), { shows: {} });
});

test('mergeTrackerEntries: null remote + local entry -> local wins', () => {
  const r = mergeTrackerEntries(null, {
    shows: { 'preview:test:foo': { sentAt: '2026-04-11T12:00:00Z' } },
  });
  assert.equal(r.shows['preview:test:foo'].sentAt, '2026-04-11T12:00:00Z');
});

test('mergeTrackerEntries: remote has shows + local is empty -> remote preserved', () => {
  const r = mergeTrackerEntries(
    { shows: { 'giant-2026': { completed: true } } },
    { shows: {} },
  );
  assert.equal(r.shows['giant-2026'].completed, true);
});

test('mergeTrackerEntries: local and remote have different keys -> union', () => {
  const r = mergeTrackerEntries(
    { shows: { 'giant-2026': { completed: true } } },
    { shows: { 'preview:broadway:titanique:2026-04-12': { sentAt: 'X' } } },
  );
  assert.equal(r.shows['giant-2026'].completed, true);
  assert.equal(r.shows['preview:broadway:titanique:2026-04-12'].sentAt, 'X');
});

test('mergeTrackerEntries: key conflict, no comparable timestamps -> local wins (default winner preserved)', () => {
  const r = mergeTrackerEntries(
    { shows: { 'preview:broadway:x:2026-04-11': { sentAt: 'REMOTE', reviewCount: 10 } } },
    { shows: { 'preview:broadway:x:2026-04-11': { sentAt: 'LOCAL', reviewCount: 15 } } },
  );
  assert.equal(r.shows['preview:broadway:x:2026-04-11'].sentAt, 'LOCAL');
  assert.equal(r.shows['preview:broadway:x:2026-04-11'].reviewCount, 15);
});

// task #1914: the older-observation-clobbers-newer-state regression this fix
// closes. A CLI reconcile polls a key and sees 'queued' (no sentAt yet); a
// concurrent send flips the SAME key to 'sent' and its PUT lands on origin
// first; the CLI's stale in-memory 'queued' write must not then overwrite the
// already-landed 'sent' state on retry.
test('mergeTrackerEntries: remote content is strictly newer than local -> remote wins (does not clobber a newer sent state)', () => {
  const r = mergeTrackerEntries(
    {
      shows: {
        'cats-2026': {
          draftStatus: 'sent',
          sentAt: '2026-04-11T12:05:00Z',
          recipientCount: 5000,
          draftCreatedAt: '2026-04-11T12:00:00Z',
        },
      },
    },
    {
      shows: {
        'cats-2026': {
          draftStatus: 'queued',
          sentAt: null,
          draftCreatedAt: '2026-04-11T12:00:00Z',
        },
      },
    },
  );
  assert.equal(r.shows['cats-2026'].draftStatus, 'sent');
  assert.equal(r.shows['cats-2026'].sentAt, '2026-04-11T12:05:00Z');
  assert.equal(r.shows['cats-2026'].recipientCount, 5000);
});

test('mergeTrackerEntries: local content is strictly newer than remote -> local wins (recency, not position)', () => {
  const r = mergeTrackerEntries(
    {
      shows: {
        'cats-2026': { draftStatus: 'queued', draftCreatedAt: '2026-04-11T12:00:00Z' },
      },
    },
    {
      shows: {
        'cats-2026': { draftStatus: 'sent', sentAt: '2026-04-11T12:05:00Z' },
      },
    },
  );
  assert.equal(r.shows['cats-2026'].draftStatus, 'sent');
  assert.equal(r.shows['cats-2026'].sentAt, '2026-04-11T12:05:00Z');
});

test('mergeTrackerEntries: a fresh no-op reconciler poll (lastReconciledAt only) does NOT outrank a genuinely newer sentAt', () => {
  // Regression for the exact bug an earlier draft of this fix would have
  // introduced: lastReconciledAt is stamped on every poll, including no-op
  // ones. It must never be able to make a stale 'queued' record look newer
  // than a real 'sent' write elsewhere.
  const r = mergeTrackerEntries(
    {
      shows: {
        'cats-2026': { draftStatus: 'sent', sentAt: '2026-04-11T12:00:00Z' },
      },
    },
    {
      shows: {
        'cats-2026': { draftStatus: 'queued', lastReconciledAt: '2026-04-11T23:59:00Z' },
      },
    },
  );
  assert.equal(r.shows['cats-2026'].draftStatus, 'sent');
});

test('mergeTrackerEntries: remote has top-level non-shows key -> preserved', () => {
  const r = mergeTrackerEntries(
    { version: 2, shows: { foo: { a: 1 } } },
    { shows: { bar: { b: 2 } } },
  );
  assert.equal(r.version, 2);
  assert.equal(r.shows.foo.a, 1);
  assert.equal(r.shows.bar.b, 2);
});

test('mergeTrackerEntries: remote without .shows key -> still merges local', () => {
  const r = mergeTrackerEntries({}, { shows: { foo: { a: 1 } } });
  assert.equal(r.shows.foo.a, 1);
});

test('mergeTrackerEntries: a key absent from the local payload is left untouched on remote', () => {
  // This is the property task #1853's reconcile-broadcast-state.js caller
  // depends on for safety: passing a PARTIAL local payload (only
  // freshly-verified keys) must never affect remote keys the caller didn't
  // include, even if those keys exist on remote with different values.
  const r = mergeTrackerEntries(
    { shows: { 'untouched-show-2026': { draftStatus: 'sent', recipientCount: 300 } } },
    { shows: { 'reconciled-show-2026': { draftStatus: 'sent', recipientCount: 42 } } },
  );
  assert.equal(r.shows['untouched-show-2026'].recipientCount, 300, 'a key absent from local must survive unchanged');
  assert.equal(r.shows['reconciled-show-2026'].recipientCount, 42);
});

test('SYNC_REPO / SYNC_REMOTE_PATH point at the private data repo root', () => {
  assert.equal(SYNC_REPO, 'thomaspryor/broadway-scorecard-data');
  assert.equal(SYNC_REMOTE_PATH, 'opening-night-sent.json');
});
