// BRO-7277: a stale-announced flag only warns (files a card) once it outlives the grace window.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { carryFirstFlagged, partitionByGrace, staleAnnouncedFlagResult, GRACE_DAYS } = require('../lib/stale-announced-audit.js');

const NOW = new Date('2026-11-10T12:00:00Z');
const daysAgo = d => new Date(NOW.getTime() - d * 86400000).toISOString();

test('first-day flag is settling: digest passes, no card', () => {
  const r = staleAnnouncedFlagResult({ flagged: [{ id: 'a', firstFlaggedAt: daysAgo(0) }] }, 3, NOW);
  assert.equal(r.status, 'pass');
  assert.match(r.message, /waiting on the status flip/);
});

test('flag older than the grace window warns and names the show', () => {
  const r = staleAnnouncedFlagResult({ flagged: [{ id: 'a', firstFlaggedAt: daysAgo(GRACE_DAYS + 1) }, { id: 'b', firstFlaggedAt: daysAgo(1) }] }, 3, NOW);
  assert.equal(r.status, 'warn');
  assert.match(r.message, /: a /);
  assert.match(r.message, /1 newer still settling/);
});

test('snapshot row with no stamp fails loud (age unknown)', () => {
  assert.equal(partitionByGrace([{ id: 'old' }], NOW).persistent.length, 1);
});

test('no flags passes clean', () => {
  assert.equal(staleAnnouncedFlagResult({ flagged: [] }, 3, NOW).status, 'pass');
});

test('carryFirstFlagged keeps the original stamp and resets for new shows', () => {
  const { flagged } = carryFirstFlagged({ flagged: [{ id: 'a', firstFlaggedAt: '2026-11-01T00:00:00Z' }] }, [{ id: 'a' }, { id: 'c' }], '2026-11-10T00:00:00Z');
  assert.equal(flagged[0].firstFlaggedAt, '2026-11-01T00:00:00Z');
  assert.equal(flagged[1].firstFlaggedAt, '2026-11-10T00:00:00Z');
});

test('a degraded (no review-texts) run does not restart the clock', () => {
  const day1 = { flagged: [{ id: 'a', firstFlaggedAt: '2026-11-01T00:00:00Z' }] };
  const degraded = carryFirstFlagged(day1, [], '2026-11-05T00:00:00Z', true);
  assert.deepEqual(degraded.history, { a: '2026-11-01T00:00:00Z' });
  const next = carryFirstFlagged({ flagged: [], firstFlaggedHistory: degraded.history, reviewTextsAvailable: false }, [{ id: 'a' }], '2026-11-06T00:00:00Z');
  assert.equal(next.flagged[0].firstFlaggedAt, '2026-11-01T00:00:00Z');
});

test('a healthy run that no longer flags a show forgets it', () => {
  const r = carryFirstFlagged({ flagged: [{ id: 'a', firstFlaggedAt: '2026-11-01T00:00:00Z' }] }, [], '2026-11-05T00:00:00Z', false);
  assert.deepEqual(r.history, {});
});

test('replay of the 30-day history: every transient flag run stays silent, persistent one warns', () => {
  // Real runs: private-lives-2025 / death-of-a-salesman cleared within 4 daily snapshots.
  const flagged = [{ id: 'death-of-a-salesman-west-end-2026', firstFlaggedAt: '2026-10-21T06:00:00Z' }];
  assert.equal(staleAnnouncedFlagResult({ flagged }, 3, new Date('2026-10-24T06:00:00Z')).status, 'pass');
  assert.equal(staleAnnouncedFlagResult({ flagged }, 3, new Date('2026-10-27T06:00:00Z')).status, 'warn');
});
