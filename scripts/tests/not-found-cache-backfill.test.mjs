/**
 * not-found-cache-backfill.test.mjs — card 3bd637c5-416f-8142-8b78-c7405c71bd98.
 *
 * The card's own bulk backfill (~1966 live Show Score / BWW-RR fetches) is
 * PARKED — it needs an explicit owner go per CLAUDE.md, not something a
 * dispatched session runs unattended. What IS this session's job is the
 * machine-checkable acceptance criteria the BRO-343 dispatcher asked for:
 * a regression test proving the backfill's premise — that a show already
 * known-absent is served from the not-found cache instead of re-fetched,
 * and that a show with a real page is never cached as absent — against the
 * real exported cache-lookup functions (CLAUDE.md rule 15), not a
 * reimplementation of that logic in the test.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const {
  loadNotFoundForAggregator,
  saveNotFoundForAggregator,
  shouldSkipAsKnownNotFound,
  applyFetchResultToCache,
} = require(path.join(REPO, 'scripts/lib/not-found-cache.js'));

function makeArchiveDir() {
  return fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'not-found-cache-'));
}

test('a show already known-absent is served from the not-found cache, not re-fetched', () => {
  const cache = { 'some-closed-show-2019': '2026-08-10' };
  assert.equal(shouldSkipAsKnownNotFound(cache, 'some-closed-show-2019', false), true);
});

test('a show never checked before is not skipped — it still gets a live fetch attempt', () => {
  const cache = { 'some-closed-show-2019': '2026-08-10' };
  assert.equal(shouldSkipAsKnownNotFound(cache, 'a-brand-new-show-2026', false), false);
});

test('--force always re-fetches even a cached not-found show', () => {
  const cache = { 'some-closed-show-2019': '2026-08-10' };
  assert.equal(shouldSkipAsKnownNotFound(cache, 'some-closed-show-2019', true), false);
});

test('a show with a real page is not cached as absent — a successful fetch clears any cache entry', () => {
  const cache = { 'boop-2025': '2026-08-01' }; // stale: was absent, now has a page
  const result = { showId: 'boop-2025', aggregator: 'show-score', success: true };
  const next = applyFetchResultToCache(cache, 'boop-2025', result, '2026-08-16');
  assert.equal('boop-2025' in next, false, 'a show with a real page must not stay cached as not-found');
});

test('a confirmed-absent fetch result is cached with the fetch date', () => {
  const cache = {};
  const result = { showId: 'never-existed-2025', aggregator: 'bww-rr', success: false, notFoundReason: true };
  const next = applyFetchResultToCache(cache, 'never-existed-2025', result, '2026-08-16');
  assert.equal(next['never-existed-2025'], '2026-08-16');
});

test('a transient failure (timeout/network error) is NOT cached as absent — it must be retried, not skipped forever', () => {
  const cache = {};
  const result = { showId: 'timed-out-2025', aggregator: 'bww-rr', success: false, error: 'timeout', notFoundReason: undefined };
  const next = applyFetchResultToCache(cache, 'timed-out-2025', result, '2026-08-16');
  assert.equal('timed-out-2025' in next, false);
  assert.equal(shouldSkipAsKnownNotFound(next, 'timed-out-2025', false), false);
});

test('applyFetchResultToCache is pure — it does not mutate the input cache', () => {
  const cache = { 'existing-2020': '2026-01-01' };
  const before = JSON.stringify(cache);
  applyFetchResultToCache(cache, 'existing-2020', { success: true }, '2026-08-16');
  assert.equal(JSON.stringify(cache), before);
});

// ── Integration: load → decide → apply → save round-trips through real files ──

test('end-to-end: a cached not-found show is skipped across a save/load cycle', () => {
  const archiveDir = makeArchiveDir();
  saveNotFoundForAggregator(archiveDir, 'bww-rr', { 'known-absent-2018': '2026-08-01' });

  const reloaded = loadNotFoundForAggregator(archiveDir, 'bww-rr');
  assert.equal(shouldSkipAsKnownNotFound(reloaded, 'known-absent-2018', false), true);

  fs.rmSync(archiveDir, { recursive: true, force: true });
});

test('end-to-end: a show that now has a real page is removed from the persisted cache', () => {
  const archiveDir = makeArchiveDir();
  saveNotFoundForAggregator(archiveDir, 'show-score', { 'reopened-show-2024': '2026-07-01' });

  let cache = loadNotFoundForAggregator(archiveDir, 'show-score');
  const result = { showId: 'reopened-show-2024', aggregator: 'show-score', success: true };
  cache = applyFetchResultToCache(cache, 'reopened-show-2024', result, '2026-08-16');
  saveNotFoundForAggregator(archiveDir, 'show-score', cache);

  const reloaded = loadNotFoundForAggregator(archiveDir, 'show-score');
  assert.equal('reopened-show-2024' in reloaded, false);
  assert.equal(shouldSkipAsKnownNotFound(reloaded, 'reopened-show-2024', false), false);

  fs.rmSync(archiveDir, { recursive: true, force: true });
});

test('loadNotFoundForAggregator returns {} for a missing/never-written cache file (no crash)', () => {
  const archiveDir = makeArchiveDir();
  assert.deepEqual(loadNotFoundForAggregator(archiveDir, 'dtli'), {});
  fs.rmSync(archiveDir, { recursive: true, force: true });
});
