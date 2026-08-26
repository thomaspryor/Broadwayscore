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

test('mergeTrackerEntries: key conflict -> local wins (caller just wrote it, so it is newest)', () => {
  const r = mergeTrackerEntries(
    { shows: { 'preview:broadway:x:2026-04-11': { sentAt: 'REMOTE', reviewCount: 10 } } },
    { shows: { 'preview:broadway:x:2026-04-11': { sentAt: 'LOCAL', reviewCount: 15 } } },
  );
  assert.equal(r.shows['preview:broadway:x:2026-04-11'].sentAt, 'LOCAL');
  assert.equal(r.shows['preview:broadway:x:2026-04-11'].reviewCount, 15);
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
