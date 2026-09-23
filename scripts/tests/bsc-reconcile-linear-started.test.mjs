/**
 * Tests for BRO-3925 (backlog-drain R4): the Linear-'started' zombie sweep.
 *
 * Two layers, matching this repo's pure-lib/I/O-wrapper split (CLAUDE.md
 * rule 15):
 *   - scripts/lib/linear-started-zombie-sweep.js's pure functions, tested
 *     directly with plain data, no I/O.
 *   - scripts/bsc-reconcile.js's sweepLinearStartedZombies(), tested with
 *     every dep injected (no real fs/git/network), covering the fail-closed
 *     refuse paths, the reset path (behind its kill switch), the checkPark
 *     2-strike-then-silent-park behavior, the daily reset cap, and dry-run
 *     never calling a single write dep.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const {
  findJobDoneLinearCandidates,
  decideZombieReset,
  buildZombieResetSummary,
  computeZombieContentHash,
  isZombieResetParked,
  zombieLocalDay,
  ZOMBIE_RESET_MARKER,
  COMMENT_PAGE_CAP,
} = require('../lib/linear-started-zombie-sweep.js');
const { JOB_EVENTS } = require('../lib/dispatch-ledger.js');
const { sweepLinearStartedZombies } = require('../bsc-reconcile.js');

// ── findJobDoneLinearCandidates ─────────────────────────────────────────────

test('findJobDoneLinearCandidates: only linear: taskIds whose LATEST attempt is job-done', () => {
  const entries = [
    { event: 'launch', taskId: 'linear:BRO-1', jobId: 'j1', ts: '2026-09-01T00:00:00Z' },
    { event: JOB_EVENTS.SPAWNED, taskId: 'linear:BRO-1', jobId: 'j1', cwd: '/wt/j1', ts: '2026-09-01T00:01:00Z' },
    { event: JOB_EVENTS.DONE, taskId: 'linear:BRO-1', jobId: 'j1', ts: '2026-09-01T01:00:00Z' },
    // A notion-mirror task must never match the linear: prefix.
    { event: JOB_EVENTS.DONE, taskId: '853', jobId: 'j2', ts: '2026-09-01T01:00:00Z' },
    // A linear task whose latest attempt is still just spawned (not done yet).
    { event: JOB_EVENTS.SPAWNED, taskId: 'linear:BRO-2', jobId: 'j3', cwd: '/wt/j3', ts: '2026-09-01T02:00:00Z' },
  ];
  const out = findJobDoneLinearCandidates(entries);
  assert.deepEqual(out.map((c) => c.identifier), ['BRO-1']);
  assert.equal(out[0].cwd, '/wt/j1');
  assert.equal(out[0].spawnedTs, '2026-09-01T00:01:00Z');
  assert.equal(out[0].jobId, 'j1');
});

test('findJobDoneLinearCandidates: a REDISPATCH supersedes an earlier job-done, and only the latest counts', () => {
  const entries = [
    { event: JOB_EVENTS.SPAWNED, taskId: 'linear:BRO-9', jobId: 'j1', cwd: '/wt/j1', ts: '2026-09-01T00:00:00Z' },
    { event: JOB_EVENTS.DONE, taskId: 'linear:BRO-9', jobId: 'j1', ts: '2026-09-01T01:00:00Z' },
    { event: JOB_EVENTS.SPAWNED, taskId: 'linear:BRO-9', jobId: 'j2', cwd: '/wt/j2', ts: '2026-09-02T00:00:00Z' },
    { event: JOB_EVENTS.FAILED, taskId: 'linear:BRO-9', jobId: 'j2', ts: '2026-09-02T01:00:00Z' },
  ];
  // Latest attempt is job-failed, not job-done — must not be a candidate.
  assert.deepEqual(findJobDoneLinearCandidates(entries), []);
});

// ── decideZombieReset ────────────────────────────────────────────────────────

const startedIssue = (comments = []) => ({ state: { type: 'started', name: 'In Progress' }, comments: { nodes: comments } });
const SPAWNED_TS = '2026-09-01T00:00:00.000Z';

test('decideZombieReset: not-started issue is skipped (stale candidate)', () => {
  const issue = { state: { type: 'backlog' }, comments: { nodes: [] } };
  const out = decideZombieReset({ issue, spawnedTs: SPAWNED_TS, worktree: { exists: false }, live: false });
  assert.deepEqual(out, { action: 'skip', reason: 'not-started' });
});

test('decideZombieReset: a session-report comment since spawn means already-reported, skip', () => {
  const issue = startedIssue([
    { createdAt: '2026-09-01T02:00:00.000Z', body: '**Session report (blocked)**\n\nstuck on X' },
  ]);
  const out = decideZombieReset({ issue, spawnedTs: SPAWNED_TS, worktree: { exists: false }, live: false });
  assert.deepEqual(out, { action: 'skip', reason: 'already-reported' });
});

test('decideZombieReset: a PR-EVIDENCE comment since spawn is also already-reported', () => {
  const issue = startedIssue([
    { createdAt: '2026-09-01T02:00:00.000Z', body: 'PR-EVIDENCE: merged deployed checked (https://x/pr/1)' },
  ]);
  const out = decideZombieReset({ issue, spawnedTs: SPAWNED_TS, worktree: { exists: false }, live: false });
  assert.equal(out.action, 'skip');
});

test('decideZombieReset: the dispatch comment ITSELF (posted at/after spawn) is not a human comment', () => {
  const issue = startedIssue([
    { createdAt: '2026-09-01T00:00:01.000Z', body: 'Dispatched ab12cd34 to headless:linear:BRO-1 at 2026-09-01T00:00:01.000Z (headless)' },
  ]);
  const worktree = { exists: true, dirty: false, aheadCount: 0 };
  const out = decideZombieReset({ issue, spawnedTs: SPAWNED_TS, worktree, live: false });
  assert.equal(out.action, 'reset');
});

test('decideZombieReset: ANY other comment since spawn refuses — cannot tell human from machine by author', () => {
  const issue = startedIssue([
    { createdAt: '2026-09-01T02:00:00.000Z', body: 'looking into this now' },
  ]);
  const out = decideZombieReset({ issue, spawnedTs: SPAWNED_TS, worktree: { exists: false }, live: false });
  assert.deepEqual(out, { action: 'refuse', reason: 'human-comment-since-dispatch' });
});

test('decideZombieReset: comments are sorted by createdAt, not trusted in payload order', () => {
  // The Linear-comment-connection-order incident class linear-dispatch.js's
  // header documents: hand the decision an OUT-OF-ORDER array and confirm
  // the human comment (chronologically LAST) is still the one that wins.
  const issue = startedIssue([
    { createdAt: '2026-09-01T03:00:00.000Z', body: 'human note' },
    { createdAt: '2026-09-01T02:00:00.000Z', body: '**Session report (blocked)**\n\nfirst attempt' },
  ]);
  const out = decideZombieReset({ issue, spawnedTs: SPAWNED_TS, worktree: { exists: false }, live: false });
  // The FIRST comment in time order (session report) is a skip signal — it
  // fires before the loop ever reaches the human note.
  assert.deepEqual(out, { action: 'skip', reason: 'already-reported' });
});

test('decideZombieReset: worktree gone refuses (the empirically dominant real case)', () => {
  const out = decideZombieReset({ issue: startedIssue(), spawnedTs: SPAWNED_TS, worktree: { exists: false }, live: false });
  assert.deepEqual(out, { action: 'refuse', reason: 'worktree-gone' });
});

test('decideZombieReset: dirty worktree refuses', () => {
  const out = decideZombieReset({
    issue: startedIssue(), spawnedTs: SPAWNED_TS,
    worktree: { exists: true, dirty: true, aheadCount: 0 }, live: false,
  });
  assert.deepEqual(out, { action: 'refuse', reason: 'worktree-unsafe' });
});

test('decideZombieReset: commits ahead of origin/main refuses', () => {
  const out = decideZombieReset({
    issue: startedIssue(), spawnedTs: SPAWNED_TS,
    worktree: { exists: true, dirty: false, aheadCount: 2 }, live: false,
  });
  assert.deepEqual(out, { action: 'refuse', reason: 'worktree-unsafe' });
});

test('decideZombieReset: a git-check error refuses even if status/ahead LOOK clean', () => {
  const out = decideZombieReset({
    issue: startedIssue(), spawnedTs: SPAWNED_TS,
    worktree: { exists: true, dirty: false, aheadCount: 0, error: true }, live: false,
  });
  assert.deepEqual(out, { action: 'refuse', reason: 'worktree-unsafe' });
});

test('decideZombieReset: a live process (lease or lsof) refuses', () => {
  const out = decideZombieReset({
    issue: startedIssue(), spawnedTs: SPAWNED_TS,
    worktree: { exists: true, dirty: false, aheadCount: 0 }, live: true,
  });
  assert.deepEqual(out, { action: 'refuse', reason: 'live-process' });
});

test('decideZombieReset: clean, unmerged-nothing, no live process, no comments -> reset', () => {
  const out = decideZombieReset({
    issue: startedIssue(), spawnedTs: SPAWNED_TS,
    worktree: { exists: true, dirty: false, aheadCount: 0 }, live: false,
  });
  assert.equal(out.action, 'reset');
});

test('decideZombieReset: no spawnedTs at all refuses (cannot place comments in time)', () => {
  const out = decideZombieReset({ issue: startedIssue(), spawnedTs: null, worktree: { exists: false }, live: false });
  assert.deepEqual(out, { action: 'refuse', reason: 'no-spawned-ts' });
});

test('decideZombieReset: a comment thread AT the fetch page cap refuses (cannot prove nothing was truncated)', () => {
  const comments = Array.from({ length: COMMENT_PAGE_CAP }, (_, i) => ({
    createdAt: `2026-08-01T00:00:${String(i).padStart(2, '0')}.000Z`, body: 'old comment',
  }));
  const issue = { state: { type: 'started' }, comments: { nodes: comments } };
  const out = decideZombieReset({ issue, spawnedTs: SPAWNED_TS, worktree: { exists: false }, live: false });
  assert.deepEqual(out, { action: 'refuse', reason: 'comment-history-truncated' });
});

test('decideZombieReset: a thread well under the page cap is unaffected', () => {
  const comments = [{ createdAt: '2026-08-01T00:00:00.000Z', body: 'old comment' }];
  const issue = { state: { type: 'started' }, comments: { nodes: comments } };
  const out = decideZombieReset({
    issue, spawnedTs: SPAWNED_TS, worktree: { exists: true, dirty: false, aheadCount: 0 }, live: false,
  });
  assert.equal(out.action, 'reset');
});

test('decideZombieReset: our OWN prior write-back sitting on a still-started issue refuses distinctly, never reads as already-reported', () => {
  // The partial-failure shape: cmdReport posted the comment but the
  // state-transition call after it threw, so the issue never left
  // 'started' — a later tick must not mistake our own comment for a real
  // session report and silently forget the card forever.
  const issue = startedIssue([
    { createdAt: '2026-09-01T02:00:00.000Z', body: `${ZOMBIE_RESET_MARKER}: BRO-1's most recent dispatch (job job-1) finished cleanly but never reported back...` },
  ]);
  const out = decideZombieReset({ issue, spawnedTs: SPAWNED_TS, worktree: { exists: false }, live: false });
  assert.deepEqual(out, { action: 'refuse', reason: 'own-reset-attempt-unconfirmed' });
});

// ── computeZombieContentHash / isZombieResetParked ──────────────────────────

test('computeZombieContentHash: keyed on jobId, not description — a redispatch (new jobId) resets the streak', () => {
  const a = computeZombieContentHash({ title: 'Fix the thing', jobId: 'job-1' });
  const b = computeZombieContentHash({ title: 'Fix the thing', jobId: 'job-2' });
  assert.notEqual(a, b);
});

test('isZombieResetParked: parks after 2 consecutive unchanged-contentHash failures', () => {
  const hash = computeZombieContentHash({ title: 'X', jobId: 'job-1' });
  const oneFailure = [{ event: 'card-fail', cardId: 'BRO-1', contentHash: hash, ts: '2026-09-01T00:00:00Z' }];
  assert.equal(isZombieResetParked('BRO-1', { ledgerEntries: oneFailure, contentHash: hash }).parked, false);
  const twoFailures = [...oneFailure, { event: 'card-fail', cardId: 'BRO-1', contentHash: hash, ts: '2026-09-02T00:00:00Z' }];
  assert.equal(isZombieResetParked('BRO-1', { ledgerEntries: twoFailures, contentHash: hash }).parked, true);
});

test('zombieLocalDay: formats a stable YYYY-MM-DD', () => {
  assert.match(zombieLocalDay('2026-09-01T00:00:00Z'), /^\d{4}-\d{2}-\d{2}$/);
});

test('buildZombieResetSummary: names the identifier, job, and reason', () => {
  const s = buildZombieResetSummary({ identifier: 'BRO-1', jobId: 'job-1', reason: 'clean-finished-job-no-writeback' });
  assert.match(s, /BRO-1/);
  assert.match(s, /job-1/);
  assert.match(s, /clean-finished-job-no-writeback/);
});

// ── sweepLinearStartedZombies (I/O wrapper, everything injected) ───────────

function tmpStatePaths() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bsc-reconcile-linear-zombie-'));
  return { statePath: path.join(dir, 'state.json'), ledgerPath: path.join(dir, 'ledger.jsonl') };
}

function harness({ entries = [], issues = {}, worktrees = {}, live = new Set(), resetEnabled = false, maxResetsPerDay = 10 } = {}) {
  const { statePath, ledgerPath } = tmpStatePaths();
  const reported = [];
  const reportedBack = [];
  const deps = {
    readLedgerEntriesFn: () => entries,
    getIssueFn: async (identifier) => issues[identifier] || null,
    reportBackFn: async (identifier, summary) => { reportedBack.push({ identifier, summary }); },
    gitStatusFn: (cwd) => (worktrees[cwd] ? (worktrees[cwd].dirty ? 'M file' : '') : null),
    gitAheadCountFn: (cwd) => (worktrees[cwd] ? (worktrees[cwd].aheadCount ?? 0) : null),
    existsFn: (cwd) => Boolean(worktrees[cwd] && worktrees[cwd].exists),
    hasLiveLeaseFn: (cwd) => live.has(cwd),
    hasLiveProcessFn: () => false,
    reportFn: (line) => reported.push(line),
    nowFn: () => Date.now(),
    statePath,
    ledgerPath,
    maxResetsPerDay,
    resetEnabled,
  };
  return { deps, reported, reportedBack, statePath, ledgerPath };
}

const candidateEntries = (identifier, jobId, cwd, spawnedTs = '2026-09-01T00:00:00.000Z') => ([
  { event: JOB_EVENTS.SPAWNED, taskId: `linear:${identifier}`, jobId, cwd, ts: spawnedTs },
  { event: JOB_EVENTS.DONE, taskId: `linear:${identifier}`, jobId, ts: '2026-09-01T01:00:00.000Z' },
]);

test('sweepLinearStartedZombies: worktree-gone refuses, ledgers a card-fail, never calls reportBackFn', async () => {
  const entries = candidateEntries('BRO-1', 'job-1', '/wt/gone');
  const { deps, reported, reportedBack } = harness({
    entries,
    issues: { 'BRO-1': { title: 'X', state: { type: 'started' }, comments: { nodes: [] } } },
    worktrees: {},
  });
  const { sweepLinearStartedZombies } = require('../bsc-reconcile.js');
  const out = await sweepLinearStartedZombies({ dryRun: false, deps });
  assert.equal(out.refused.length, 1);
  assert.equal(out.refused[0].reason, 'worktree-gone');
  assert.equal(reportedBack.length, 0);
  assert.ok(reported.some((r) => r.kind === 'linear-zombie-refused'));
  const ledgerLines = fs.readFileSync(deps.ledgerPath, 'utf8').trim().split('\n');
  assert.equal(ledgerLines.length, 1);
  const row = JSON.parse(ledgerLines[0]);
  assert.equal(row.event, 'card-fail');
  assert.ok(row.ts, 'every ledger row must carry ts or checkPark silently drops it');
});

test('sweepLinearStartedZombies: reset path calls reportBackFn ONLY when the kill switch is on', async () => {
  const entries = candidateEntries('BRO-2', 'job-2', '/wt/clean');
  const { deps, reportedBack } = harness({
    entries,
    issues: { 'BRO-2': { title: 'Y', state: { type: 'started' }, comments: { nodes: [] } } },
    worktrees: { '/wt/clean': { exists: true, dirty: false, aheadCount: 0 } },
    resetEnabled: false,
  });
  const out = await sweepLinearStartedZombies({ dryRun: false, deps });
  assert.equal(out.reset.length, 1, 'still counted as a would-reset decision');
  assert.equal(reportedBack.length, 0, 'kill switch off -> no real write');

  const { deps: deps2, reportedBack: reportedBack2 } = harness({
    entries,
    issues: { 'BRO-2': { title: 'Y', state: { type: 'started' }, comments: { nodes: [] } } },
    worktrees: { '/wt/clean': { exists: true, dirty: false, aheadCount: 0 } },
    resetEnabled: true,
  });
  await sweepLinearStartedZombies({ dryRun: false, deps: deps2 });
  assert.equal(reportedBack2.length, 1);
  assert.equal(reportedBack2[0].identifier, 'BRO-2');
});

test('sweepLinearStartedZombies: TOCTOU re-check refuses the write when the issue changed between the first read and the write', async () => {
  // Simulates a human (or another machine) resolving the issue in the tiny
  // window between this sweep's decision and its write — the SECOND
  // getIssueFn call (the re-check, right before reportBackFn) sees the
  // issue has already left 'started'.
  const entries = candidateEntries('BRO-10', 'job-10', '/wt/clean10');
  const { statePath, ledgerPath } = tmpStatePaths();
  const reportedBack = [];
  const reported = [];
  let getIssueCalls = 0;
  const deps = {
    readLedgerEntriesFn: () => entries,
    getIssueFn: async () => {
      getIssueCalls++;
      return getIssueCalls === 1
        ? { title: 'T', state: { type: 'started' }, comments: { nodes: [] } }
        : { title: 'T', state: { type: 'completed' }, comments: { nodes: [] } };
    },
    reportBackFn: async (identifier, summary) => { reportedBack.push({ identifier, summary }); },
    gitStatusFn: () => '',
    gitAheadCountFn: () => 0,
    existsFn: () => true,
    hasLiveLeaseFn: () => false,
    hasLiveProcessFn: () => false,
    reportFn: (line) => reported.push(line),
    nowFn: () => Date.now(),
    statePath,
    ledgerPath,
    resetEnabled: true,
  };
  await sweepLinearStartedZombies({ dryRun: false, deps });
  assert.equal(getIssueCalls, 2, 'must re-fetch immediately before writing, not just once at the top');
  assert.equal(reportedBack.length, 0, 'the stale decision must never reach reportBackFn');
  assert.ok(reported.some((r) => r.kind === 'linear-zombie-reset-stale'));
});

test('sweepLinearStartedZombies: daily reset cap stops further resets once reached', async () => {
  const entries = [
    ...candidateEntries('BRO-3', 'job-3', '/wt/a'),
    ...candidateEntries('BRO-4', 'job-4', '/wt/b'),
  ];
  const { deps, reportedBack, statePath } = harness({
    entries,
    issues: {
      'BRO-3': { title: 'A', state: { type: 'started' }, comments: { nodes: [] } },
      'BRO-4': { title: 'B', state: { type: 'started' }, comments: { nodes: [] } },
    },
    worktrees: {
      '/wt/a': { exists: true, dirty: false, aheadCount: 0 },
      '/wt/b': { exists: true, dirty: false, aheadCount: 0 },
    },
    resetEnabled: true,
    maxResetsPerDay: 1,
  });
  await sweepLinearStartedZombies({ dryRun: false, deps });
  assert.equal(reportedBack.length, 1, 'cap of 1/day must stop the second reset in the SAME tick');
});

test('sweepLinearStartedZombies: dry-run never calls reportBackFn or writes the ledger', async () => {
  const entries = candidateEntries('BRO-5', 'job-5', '/wt/clean5');
  const { deps, reportedBack, ledgerPath } = harness({
    entries,
    issues: { 'BRO-5': { title: 'Z', state: { type: 'started' }, comments: { nodes: [] } } },
    worktrees: { '/wt/clean5': { exists: true, dirty: false, aheadCount: 0 } },
    resetEnabled: true,
  });
  const out = await sweepLinearStartedZombies({ dryRun: true, deps });
  assert.equal(out.reset.length, 1);
  assert.equal(reportedBack.length, 0);
  assert.equal(fs.existsSync(ledgerPath), false, 'dry-run must not create the ledger file at all');
});

test('sweepLinearStartedZombies: park suppresses the repeated digest line once checkPark trips (2 EXISTING unchanged failures)', async () => {
  // Matches attempt-memory.js's own contract (same one scripts/linear-drain-
  // parked.js already relies on): checkPark parks once maxFailures (2)
  // PRIOR occurrences are already on the ledger — so occurrence 1 and 2
  // still report (0 and then 1 prior rows exist at decision time), and only
  // occurrence 3 (2 prior rows now exist) goes silent.
  const entries = candidateEntries('BRO-6', 'job-6', '/wt/gone6');
  const runOnce = async (ledgerPath) => {
    const { deps, reported } = harness({
      entries,
      issues: { 'BRO-6': { title: 'P', state: { type: 'started' }, comments: { nodes: [] } } },
      worktrees: {},
    });
    if (ledgerPath) deps.ledgerPath = ledgerPath;
    await sweepLinearStartedZombies({ dryRun: false, deps });
    return { reported, ledgerPath: deps.ledgerPath };
  };
  const first = await runOnce();
  assert.ok(first.reported.some((r) => r.kind === 'linear-zombie-refused'), 'occurrence 1 reports (0 prior rows)');
  const second = await runOnce(first.ledgerPath);
  assert.ok(second.reported.some((r) => r.kind === 'linear-zombie-refused'), 'occurrence 2 reports (1 prior row — not parked yet)');
  const third = await runOnce(first.ledgerPath);
  assert.ok(!third.reported.some((r) => r.kind === 'linear-zombie-refused'), 'occurrence 3 stays silent (2 prior rows — now parked)');
});

test('sweepLinearStartedZombies: a stale candidate (state moved on since the ledger scan) is skipped, not refused', async () => {
  const entries = candidateEntries('BRO-7', 'job-7', '/wt/gone7');
  const { deps, reported, reportedBack } = harness({
    entries,
    issues: { 'BRO-7': { title: 'S', state: { type: 'completed' }, comments: { nodes: [] } } },
    worktrees: {},
  });
  const out = await sweepLinearStartedZombies({ dryRun: false, deps });
  assert.equal(out.refused.length, 0);
  assert.equal(out.reset.length, 0);
  assert.equal(reportedBack.length, 0);
  assert.equal(reported.length, 0);
});
