// Card #1454: headless dispatch lane telemetry. Requires the REAL exported
// functions (CLAUDE.md rule 15) — never reimplements ledger/lease logic here.
//
// Investigation summary (2026-08-16): the card's original measurement
// (2026-08-13, "67 launches, 4 job-spawned, 4 job-done") does not reproduce
// against the live ledger today — every one of the 69 headless launches in
// the trailing 14 days now has at least a job-spawned AND a terminal job
// event. What IS real and still open: three code paths in bsc-runner.js's
// runJob() can produce a `launch` ledger row with NO jobId-bearing event ever
// (lease-held; an exception thrown before acquireLease resolves) — invisible
// to foldJobs()/openJobs() (jobId-keyed) forever. This file tests the fix
// (JOB_EVENTS.ABANDONED) and the new headless success-rate function that
// replaces the previously-silent-zero `--lane=headless` reading.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const dispatchLedger = require('../lib/dispatch-ledger.js');
const dispatchHealth = require('../lib/dispatch-health.js');
const bscRunner = require('../lib/bsc-runner.js');

const { JOB_EVENTS, TERMINAL_JOB_EVENTS, isDeadlikeEvent, isAttemptEvent, isLatestDispatchDead } = dispatchLedger;
const { computeJobLaneOutcomeRate, JOB_LANE } = dispatchHealth;

// bsc-runner.js hardcodes LEASE_ROOT to a Mac-only absolute path (same
// pattern as dispatch-ledger.js's REPO — see that file's header), so a real
// acquireLease() call is only safe where that path is writable. On CI
// (ubuntu-latest, checked out at $GITHUB_WORKSPACE) it is not — a non-root
// user cannot mkdir under /Users. Skip the two runJob/acquireLease tests
// there rather than let an uncaught ENOENT/EACCES fail the whole file
// (ship-check finding, 2026-08-16): the LEASE_ROOT-independent tests above
// still give real coverage on every platform.
const leaseRootUsable = (() => {
  try { fs.mkdirSync(bscRunner.LEASE_ROOT, { recursive: true }); return true; }
  catch { return false; }
})();

// ── JOB_EVENTS.ABANDONED plumbing ───────────────────────────────────────────

test('JOB_EVENTS.ABANDONED is terminal but NOT deadlike', () => {
  assert.equal(typeof JOB_EVENTS.ABANDONED, 'string');
  assert.ok(TERMINAL_JOB_EVENTS.has(JOB_EVENTS.ABANDONED), 'must be terminal — every existing consumer treats non-terminal job-* events as still running');
  // Deliberately excluded from isDeadlikeEvent: a lease-held abandon means a
  // DIFFERENT job for the same task is healthy right now, not that the task
  // failed — feeding it in would let two benign concurrent-dispatch races
  // permanently park a task via DEAD_ATTEMPT_LIMIT (dispatch-ledger.js's own
  // classifyDeadAttemptsForTask comment).
  assert.equal(isDeadlikeEvent(JOB_EVENTS.ABANDONED), false);
});

test('every JOB_EVENTS value is exactly terminal or open (no unclassified event name)', () => {
  const OPEN = new Set([JOB_EVENTS.SPAWNED]);
  for (const [key, value] of Object.entries(JOB_EVENTS)) {
    const classified = TERMINAL_JOB_EVENTS.has(value) || OPEN.has(value);
    assert.ok(classified, `JOB_EVENTS.${key} (${value}) is neither in TERMINAL_JOB_EVENTS nor the known-open set — every consumer that folds job state needs one or the other`);
  }
});

// ── computeJobLaneOutcomeRate (the card's "success rate identically computed") ──

function fixtureEntries() {
  // Six headless launches for six distinct tasks, one of each outcome shape.
  const rows = [
    // 1: done
    { ts: '2026-08-10T00:00:00.000Z', event: 'launch', taskId: 't-done', workspaceRef: 'headless:t-done' },
    { ts: '2026-08-10T00:01:00.000Z', event: JOB_EVENTS.SPAWNED, taskId: 't-done', jobId: 'j-done' },
    { ts: '2026-08-10T00:10:00.000Z', event: JOB_EVENTS.DONE, taskId: 't-done', jobId: 'j-done' },
    // 2: failed via job-failed
    { ts: '2026-08-10T01:00:00.000Z', event: 'launch', taskId: 't-failed', workspaceRef: 'headless:t-failed' },
    { ts: '2026-08-10T01:01:00.000Z', event: JOB_EVENTS.SPAWNED, taskId: 't-failed', jobId: 'j-failed' },
    { ts: '2026-08-10T01:10:00.000Z', event: JOB_EVENTS.FAILED, taskId: 't-failed', jobId: 'j-failed' },
    // 3: failed via job-orphaned
    { ts: '2026-08-10T02:00:00.000Z', event: 'launch', taskId: 't-orphaned', workspaceRef: 'headless:t-orphaned' },
    { ts: '2026-08-10T02:01:00.000Z', event: JOB_EVENTS.SPAWNED, taskId: 't-orphaned', jobId: 'j-orphaned' },
    { ts: '2026-08-10T02:10:00.000Z', event: JOB_EVENTS.ORPHANED, taskId: 't-orphaned', jobId: 'j-orphaned' },
    // 4: failed via job-abandoned (lease-held, never spawned)
    { ts: '2026-08-10T03:00:00.000Z', event: 'launch', taskId: 't-abandoned', workspaceRef: 'headless:t-abandoned' },
    { ts: '2026-08-10T03:00:01.000Z', event: JOB_EVENTS.ABANDONED, taskId: 't-abandoned', jobId: 'j-abandoned', reason: 'lease-held' },
    // 5: in-flight (spawned, no terminal event yet)
    { ts: '2026-08-10T04:00:00.000Z', event: 'launch', taskId: 't-inflight', workspaceRef: 'headless:t-inflight' },
    { ts: '2026-08-10T04:01:00.000Z', event: JOB_EVENTS.SPAWNED, taskId: 't-inflight', jobId: 'j-inflight' },
    // 6: none (launch never even got a job-* event)
    { ts: '2026-08-10T05:00:00.000Z', event: 'launch', taskId: 't-none', workspaceRef: 'headless:t-none' },
    // Not headless — must be excluded from the headless-lane count entirely.
    { ts: '2026-08-10T06:00:00.000Z', event: 'launch', taskId: 't-tab', workspaceRef: 'workspace:900' },
  ];
  return rows;
}

test('computeJobLaneOutcomeRate: classifies every outcome shape correctly', () => {
  const entries = fixtureEntries();
  const nowMs = Date.parse('2026-08-11T00:00:00.000Z');
  const stats = computeJobLaneOutcomeRate(entries, { nowMs, windowDays: 14, lane: JOB_LANE });

  assert.equal(stats.lane, 'headless');
  assert.equal(stats.launches, 6, 'the one workspace:-lane launch must be excluded');
  assert.equal(stats.done, 1);
  assert.equal(stats.failed, 3, 'job-failed + job-orphaned + job-abandoned all count as failed');
  assert.equal(stats.inFlight, 1);
  assert.equal(stats.none, 1);
  assert.equal(stats.resolved, 4, 'done + failed only — in-flight/none have no verdict yet');
  assert.equal(stats.successRate, 1 / 4);
  assert.equal(stats.failureRate, 3 / 4);
  assert.deepEqual(new Set(stats.failedTaskIds), new Set(['t-failed', 't-orphaned', 't-abandoned']));
});

test('computeJobLaneOutcomeRate: a resume (job-retried then a fresh job-spawned, no new launch row) attributes to the SAME launch', () => {
  const entries = [
    { ts: '2026-08-10T00:00:00.000Z', event: 'launch', taskId: 't-resumed', workspaceRef: 'headless:t-resumed' },
    { ts: '2026-08-10T00:01:00.000Z', event: JOB_EVENTS.SPAWNED, taskId: 't-resumed', jobId: 'j1' },
    { ts: '2026-08-10T00:05:00.000Z', event: JOB_EVENTS.RETRIED, taskId: 't-resumed', jobId: 'j1' },
    { ts: '2026-08-10T00:05:01.000Z', event: JOB_EVENTS.SPAWNED, taskId: 't-resumed', jobId: 'j2', resumed: true },
    { ts: '2026-08-10T00:12:00.000Z', event: JOB_EVENTS.DONE, taskId: 't-resumed', jobId: 'j2' },
  ];
  const nowMs = Date.parse('2026-08-11T00:00:00.000Z');
  const stats = computeJobLaneOutcomeRate(entries, { nowMs, windowDays: 14, lane: JOB_LANE });
  assert.equal(stats.launches, 1);
  assert.equal(stats.done, 1, 'the resumed successor finishing counts as the launch succeeding, not a phantom second launch');
  assert.equal(stats.failed, 0);
});

test('computeJobLaneOutcomeRate: a redispatch (new launch row) owns only the job events AFTER it', () => {
  const entries = [
    { ts: '2026-08-10T00:00:00.000Z', event: 'launch', taskId: 't-redispatch', workspaceRef: 'headless:t-redispatch' },
    { ts: '2026-08-10T00:01:00.000Z', event: JOB_EVENTS.SPAWNED, taskId: 't-redispatch', jobId: 'j1' },
    { ts: '2026-08-10T00:10:00.000Z', event: JOB_EVENTS.FAILED, taskId: 't-redispatch', jobId: 'j1' },
    { ts: '2026-08-10T01:00:00.000Z', event: 'launch', taskId: 't-redispatch', workspaceRef: 'headless:t-redispatch' },
    { ts: '2026-08-10T01:01:00.000Z', event: JOB_EVENTS.SPAWNED, taskId: 't-redispatch', jobId: 'j2' },
    { ts: '2026-08-10T01:10:00.000Z', event: JOB_EVENTS.DONE, taskId: 't-redispatch', jobId: 'j2' },
  ];
  const nowMs = Date.parse('2026-08-11T00:00:00.000Z');
  const stats = computeJobLaneOutcomeRate(entries, { nowMs, windowDays: 14, lane: JOB_LANE });
  assert.equal(stats.launches, 2, 'each launch row is its own attempt');
  assert.equal(stats.done, 1);
  assert.equal(stats.failed, 1);
});

test('computeJobLaneOutcomeRate: throws without nowMs (no clock of its own, matches computeDeadRate)', () => {
  assert.throws(() => computeJobLaneOutcomeRate([], {}), /nowMs/);
});

// ── runJob() lease-held → job-abandoned (the actual fix) ────────────────────
//
// Simulating a genuinely-alive holder by spawning a real OS process is unsafe
// here: an earlier version of this test spawned a temp script literally
// named `claude` and hit a real race (2026-08-16) — the setup check saw it
// as alive, but by the time runJob()'s OWN internal liveness check ran
// (microseconds later, after the script's `exec` replaced its process image)
// it looked dead, so acquireLease() STOLE the "stale" lease and runJob()
// proceeded to spawn a REAL claude-cli session ($0.23, no code changes,
// cleanly exited — but a real cost a test must never risk). This sandboxed
// environment separately SIGKILLs a directly-executed binary literally named
// `claude` outright. Neither approach is safe here, so this test drives the
// REAL acquireLease()/runJob() control flow with the liveness PREDICATE
// injected deterministically (`isAliveFn`, threaded through both functions
// for exactly this — see bsc-runner.js's own comment on the parameter) —
// same idiom as this subsystem's `nowMs` threading elsewhere, and a real
// process can never be spawned by construction, not merely by luck.
const FAKE_PID = 999999; // never checked against a real process — isAliveFn always answers directly

test('runJob: lease-held (another job already running this task) writes job-abandoned, not silence',
  { skip: !leaseRootUsable && 'LEASE_ROOT not writable in this environment (CI) — see the guard above' },
  async () => {
    const taskId = `test-1454-lease-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const holderJobId = `${taskId}-holder`;
    const alwaysAlive = () => true;
    let claimed = false;

    const appended = [];
    const originalAppendEntry = dispatchLedger.appendEntry;
    dispatchLedger.appendEntry = (entry) => {
      appended.push(entry);
      return { ts: new Date().toISOString(), ...entry };
    };

    try {
      const claim = bscRunner.acquireLease(taskId, { jobId: holderJobId, subject: 'test-holder', pid: FAKE_PID }, { isAliveFn: alwaysAlive });
      assert.equal(claim.ok, true, 'setup: the fake holder must actually claim the lease');
      claimed = true;

      const res = await bscRunner.runJob({ taskId, subject: 'test dispatch', prompt: 'irrelevant — must never spawn', isAliveFn: alwaysAlive });
      assert.equal(res.ok, false);
      assert.equal(res.stage, 'lease-held');

      const abandonedEntries = appended.filter((e) => e.event === JOB_EVENTS.ABANDONED && String(e.taskId) === taskId);
      assert.equal(abandonedEntries.length, 1, 'expected exactly one job-abandoned entry for this attempt — not silence, not a duplicate');
      assert.equal(abandonedEntries[0].jobId, res.jobId, 'the abandoned entry must carry the SAME jobId runJob() minted for this attempt, so it is attributable');
      assert.match(String(abandonedEntries[0].reason || ''), /already has a live job/);
    } finally {
      dispatchLedger.appendEntry = originalAppendEntry;
      if (claimed) bscRunner.releaseLease(taskId, holderJobId);
    }
  });

test('runJob: a STALE lease (holder not alive) is stolen normally — no job-abandoned, no false positive',
  { skip: !leaseRootUsable && 'LEASE_ROOT not writable in this environment (CI) — see the guard above' },
  async () => {
    const taskId = `test-1454-stale-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const staleHolderJobId = `${taskId}-stale-holder`;
    const neverAlive = () => false;
    let claimed = false;

    const appended = [];
    const originalAppendEntry = dispatchLedger.appendEntry;
    dispatchLedger.appendEntry = (entry) => { appended.push(entry); return { ts: new Date().toISOString(), ...entry }; };

    try {
      const claim = bscRunner.acquireLease(taskId, { jobId: staleHolderJobId, subject: 'stale-holder', pid: FAKE_PID }, { isAliveFn: neverAlive });
      assert.equal(claim.ok, true, 'setup: the stale holder must claim the lease first');
      claimed = true;

      const claimAttempt = bscRunner.acquireLease(taskId, { jobId: 'new-claimant', subject: 'x', pid: FAKE_PID }, { isAliveFn: neverAlive });
      assert.equal(claimAttempt.ok, true, 'a stale (not-alive) holder must be stolen, not treated as held');
      const abandonedEntries = appended.filter((e) => e.event === JOB_EVENTS.ABANDONED);
      assert.equal(abandonedEntries.length, 0, 'a successful steal is not an abandonment — nothing to write');
    } finally {
      dispatchLedger.appendEntry = originalAppendEntry;
      if (claimed) bscRunner.releaseLease(taskId, 'new-claimant');
    }
  });

// ── ABANDONED must be visible to the completion guard (ship-check finding) ──
// dispatch-dead-launch-guard.js's guardTaskCompletion trusts
// isLatestDispatchDead() to decide "did the task's most recent dispatch
// attempt actually run" before letting a task be marked completed. Without
// isAttemptEvent/isLatestDispatchDead recognizing ABANDONED, that guard would
// skip straight past an abandoned attempt to the ORIGINAL launch row and
// never notice the dispatch never ran — reopening the exact invisibility
// class this card exists to close, just at a different consumer.

test('isAttemptEvent recognizes JOB_EVENTS.ABANDONED as an attempt', () => {
  assert.equal(isAttemptEvent(JOB_EVENTS.ABANDONED), true);
});

test('isLatestDispatchDead: an abandoned latest attempt reads as dead (completion guard must not trust it)', () => {
  const entries = [
    { ts: '2026-08-10T00:00:00.000Z', event: 'launch', taskId: 't-guard', workspaceRef: 'headless:t-guard' },
    { ts: '2026-08-10T00:00:01.000Z', event: JOB_EVENTS.ABANDONED, taskId: 't-guard', jobId: 'j-guard', reason: 'task already has a live job' },
  ];
  assert.equal(isLatestDispatchDead('t-guard', entries), true);
});

test('isLatestDispatchDead: a SUBSEQUENT successful redispatch after an abandon is trusted again', () => {
  const entries = [
    { ts: '2026-08-10T00:00:00.000Z', event: 'launch', taskId: 't-guard2', workspaceRef: 'headless:t-guard2' },
    { ts: '2026-08-10T00:00:01.000Z', event: JOB_EVENTS.ABANDONED, taskId: 't-guard2', jobId: 'j-guard2a', reason: 'task already has a live job' },
    { ts: '2026-08-10T01:00:00.000Z', event: 'launch', taskId: 't-guard2', workspaceRef: 'headless:t-guard2' },
    { ts: '2026-08-10T01:01:00.000Z', event: JOB_EVENTS.SPAWNED, taskId: 't-guard2', jobId: 'j-guard2b' },
    { ts: '2026-08-10T01:10:00.000Z', event: JOB_EVENTS.DONE, taskId: 't-guard2', jobId: 'j-guard2b' },
  ];
  assert.equal(isLatestDispatchDead('t-guard2', entries), false);
});
