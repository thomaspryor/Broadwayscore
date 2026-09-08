// BRO-392 — "Audit Aggregator Review Gap" workflow repeat-failure.
//
// Root cause: audit-show-review-gap.js's blast-radius guard quarantines a
// show whose coverage state changed too much to trust, and rolls its
// gap-audit-checkpoint.json entry back to the PRE-quarantine timestamp
// (rollbackCheckpointEntries -> applyCheckpointRollback in
// scripts/lib/gap-audit-checkpoint.js). compareAuditPriority
// (scripts/lib/gap-audit-freshness.js) always selects the OLDEST `at`
// timestamp first, so a show whose stamp never advances becomes permanently
// "most overdue" and gets re-selected into nearly every subsequent hourly
// batch — re-tripping the guard and reddening the workflow run after run.
// Confirmed against real production runs (2026-09-07/08): the same ~9-10
// off-broadway shows, frozen at an early-August computedAt, recurred in
// nearly every hourly run and made the job fail on almost every tick.
//
// The fix caps how many times in a row a show's rollback can happen
// (DEFAULT_QUARANTINE_STREAK_CAP in scripts/lib/gap-audit-checkpoint.js):
// once exceeded, the show's freshly-audited stamp from that run is allowed
// to stand instead of being rolled back again, so it falls back to its
// normal freshness cadence and stops starving the checkpoint queue. This
// test proves the starvation loop is bounded, not that it never happens
// once (a real regression + quarantine is still supposed to redden CI).
import { test } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  applyCheckpointRollback,
  DEFAULT_QUARANTINE_STREAK_CAP,
} = require('../../scripts/lib/gap-audit-checkpoint.js');
const { compareAuditPriority } = require('../../scripts/lib/gap-audit-freshness.js');

test('a chronically-risky show cannot be rolled back to the SAME ancient timestamp indefinitely', () => {
  const originalStale = '2026-08-17T09:42:27.329Z';
  let checkpoint = { 'stuck-show': { at: originalStale, gaps: 3 } };

  // Below the cap, every rollback restores the stale timestamp exactly —
  // proves the breaker doesn't fire early.
  for (let run = 1; run <= DEFAULT_QUARANTINE_STREAK_CAP; run++) {
    const checkpointAtStart = JSON.parse(JSON.stringify(checkpoint));
    const freshStamp = { at: new Date(Date.now() + run).toISOString(), gaps: 3 };
    checkpoint = applyCheckpointRollback({ 'stuck-show': freshStamp }, ['stuck-show'], checkpointAtStart);
    assert.strictEqual(checkpoint['stuck-show'].at, originalStale, `run ${run}: still below the cap — must still restore the stale timestamp`);
    assert.strictEqual(checkpoint['stuck-show'].quarantineStreak, run);
  }

  // One more rollback (streak now exceeds the cap) must finally let the
  // show escape the original stale timestamp instead of being pinned to it
  // forever — this is the starvation loop this fix exists to break.
  const checkpointAtStart = JSON.parse(JSON.stringify(checkpoint));
  const freshStamp = { at: new Date(Date.now() + 999).toISOString(), gaps: 3 };
  checkpoint = applyCheckpointRollback({ 'stuck-show': freshStamp }, ['stuck-show'], checkpointAtStart);
  assert.notStrictEqual(checkpoint['stuck-show'].at, originalStale, 'must not still be pinned to the pre-quarantine timestamp once the cap is exceeded');
  assert.strictEqual(checkpoint['stuck-show'].at, freshStamp.at);
  assert.strictEqual(checkpoint['stuck-show'].quarantineStreak, 0);
});

test('before the fix: an un-capped rollback keeps a show permanently "most overdue" against fresh peers', () => {
  // Without a cap, restoring the exact PRE-quarantine snapshot every run
  // means the show's `at` timestamp never advances no matter how many runs
  // pass — this is the literal starvation bug, reproduced with no cap set.
  const ancientStart = { 'stuck-show': { at: '2026-08-17T00:00:00.000Z', gaps: 3 } };
  let checkpoint = ancientStart;
  for (let run = 1; run <= 20; run++) {
    checkpoint = applyCheckpointRollback(
      { 'stuck-show': { at: new Date(Date.now() + run).toISOString(), gaps: 3 } },
      ['stuck-show'],
      ancientStart,
      { streakCap: Infinity }
    );
  }
  assert.strictEqual(checkpoint['stuck-show'].at, '2026-08-17T00:00:00.000Z');

  // compareAuditPriority always ranks the oldest timestamp first, so this
  // show would out-prioritize a peer that was healthily audited yesterday —
  // it dominates every future batch selection.
  const peer = { at: new Date(Date.now() - 24 * 3600 * 1000).toISOString() };
  const now = Date.now();
  const order = compareAuditPriority(
    { id: 'stuck-show', status: 'closed' },
    { id: 'healthy-peer', status: 'closed' },
    { 'stuck-show': checkpoint['stuck-show'], 'healthy-peer': peer },
    now
  );
  assert.ok(order < 0, 'the perpetually-stale show sorts ahead of a normally-audited peer, dominating every batch');
});

test('the breaker never lets a refused run\'s completeness numbers become trusted (Codex adversarial review finding)', () => {
  // newsletter-preflight.js's classifyGapEntry() reads `at` + `uncollected`
  // off this exact file as a HARD send-blocking gate: a fresh `at` with
  // `uncollected: 0` reads as 'ok' and clears a show to send. The first cut
  // of this fix let the circuit breaker adopt the refused run's own
  // gaps/uncollected once it tripped — silently blessing a send on the very
  // data the blast-radius guard just refused to trust. The fix must only
  // ever advance the TIMESTAMP; the completeness fields must keep the last
  // genuinely trusted values (or none).
  const checkpointAtStart = { 'stuck-show': { at: '2026-08-17T00:00:00.000Z', gaps: 5, uncollected: 5, quarantineStreak: DEFAULT_QUARANTINE_STREAK_CAP } };
  const refusedRunClaim = { at: new Date().toISOString(), gaps: 0, uncollected: 0 }; // the lie
  const rolled = applyCheckpointRollback({ 'stuck-show': refusedRunClaim }, ['stuck-show'], checkpointAtStart);
  assert.strictEqual(rolled['stuck-show'].at, refusedRunClaim.at, 'the timestamp does advance once the cap trips');
  assert.strictEqual(rolled['stuck-show'].uncollected, 5, 'must NOT adopt the refused run\'s uncollected count');
  assert.strictEqual(rolled['stuck-show'].gaps, 5, 'must NOT adopt the refused run\'s gaps count');
});

test('after the fix: the same scenario lets the show fall back behind a fresh peer once the cap trips', () => {
  const ancientStart = { 'stuck-show': { at: '2026-08-17T00:00:00.000Z', gaps: 3 } };
  let checkpoint = ancientStart;
  for (let run = 1; run <= DEFAULT_QUARANTINE_STREAK_CAP + 1; run++) {
    checkpoint = applyCheckpointRollback(
      { 'stuck-show': { at: new Date(Date.now() + run).toISOString(), gaps: 3 } },
      ['stuck-show'],
      checkpoint
    );
  }

  const peer = { at: new Date(Date.now() - 24 * 3600 * 1000).toISOString() };
  const now = Date.now();
  const order = compareAuditPriority(
    { id: 'stuck-show', status: 'closed' },
    { id: 'healthy-peer', status: 'closed' },
    { 'stuck-show': checkpoint['stuck-show'], 'healthy-peer': peer },
    now
  );
  assert.ok(order > 0, 'once the breaker trips, the show carries a fresh timestamp and no longer out-prioritizes a normally-audited peer');
});
