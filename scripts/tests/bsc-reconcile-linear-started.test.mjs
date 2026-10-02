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
const { sweepLinearStartedZombies, readLinearZombieLedger } = require('../bsc-reconcile.js');

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
// BRO-4510: verify-driven. Decision-table cases live in
// scripts/lib/linear-started-zombie-sweep-verify.test.mjs; these cover the
// wrapper: ledger rows, caps, kill switch, budget, dry-run, re-check.

function tmpStatePaths() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bsc-reconcile-linear-zombie-'));
  return { statePath: path.join(dir, 'state.json'), ledgerPath: path.join(dir, 'ledger.jsonl') };
}

const CMD = 'node --test scripts/lib/foo.test.mjs';
const DESC = `Fix\n\n## Acceptance criteria\n\nVERIFY: ${CMD}\n`;
const startedIssue2 = (title, comments = [], description = DESC) => ({ title, description, state: { type: 'started' }, comments: { nodes: comments } });

function harness({ entries = [], issues = {}, worktrees = {}, live = new Set(), maxResetsPerDay = 10, maxDonesPerDay = 30, verifyStatus = 'pass', verifyDetail = null, commitOnMain = true, applyOk = true, extra = {} } = {}) {
  const { statePath, ledgerPath } = tmpStatePaths();
  const reported = [];
  const applied = [];
  const verified = [];
  const deps = {
    readLedgerEntriesFn: () => entries,
    getIssueFn: async (identifier) => issues[identifier] || null,
    makeCheckoutFn: () => ({ wt: '/tmp/fake-checkout', sha: 'abcdef1234567', prepared: true }),
    removeCheckoutFn: () => {},
    cleanCheckoutFn: () => {},
    runVerifyFn: (_co, cmd) => { verified.push(cmd); return { status: verifyStatus, detail: verifyDetail }; },
    commitOnMainFn: () => commitOnMain,
    applyFn: (args) => { applied.push(args); return applyOk ? { ok: true, status: 0, stderr: '' } : { ok: false, status: 5, stderr: 'REFUSED' }; },
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
    maxDonesPerDay,
    ...extra,
  };
  return { deps, reported, applied, verified, statePath, ledgerPath };
}

const candidateEntries = (identifier, jobId, cwd, spawnedTs = '2026-09-01T00:00:00.000Z') => ([
  { event: JOB_EVENTS.SPAWNED, taskId: `linear:${identifier}`, jobId, cwd, ts: spawnedTs },
  { event: JOB_EVENTS.DONE, taskId: `linear:${identifier}`, jobId, ts: '2026-09-01T01:00:00.000Z' },
]);
const readRows = (p) => fs.readFileSync(p, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

test('sweep: worktree-gone + VERIFY passes -> closes Done through the CLI path with the marker comment', async () => {
  const { deps, applied, ledgerPath } = harness({
    entries: candidateEntries('BRO-1', 'job-1', '/wt/gone'),
    issues: { 'BRO-1': startedIssue2('X') },
  });
  const out = await sweepLinearStartedZombies({ dryRun: false, deps });
  assert.equal(out.done.length, 1);
  assert.equal(applied.length, 1);
  assert.equal(applied[0].action, 'done');
  assert.ok(applied[0].comment.includes(ZOMBIE_RESET_MARKER));
  const row = readRows(ledgerPath)[0];
  assert.deepEqual([row.event, row.action], ['card-pass', 'done']);
  assert.ok(row.ts);
});

test('sweep: FAIL is leave on the first tick (verify-fail row), Todo on the second', async () => {
  const entries = candidateEntries('BRO-2', 'job-2', '/wt/gone2');
  const issues = { 'BRO-2': startedIssue2('Y') };
  const first = harness({ entries, issues, verifyStatus: 'fail', verifyDetail: 'assertion failed' });
  const out1 = await sweepLinearStartedZombies({ dryRun: false, deps: first.deps });
  assert.equal(out1.left[0].reason, 'verify-failed-first-strike');
  assert.equal(first.applied.length, 0);
  assert.equal(readRows(first.ledgerPath)[0].event, 'verify-fail');

  const second = harness({ entries, issues, verifyStatus: 'fail', verifyDetail: 'assertion failed' });
  fs.copyFileSync(first.ledgerPath, second.ledgerPath);
  second.deps.nowFn = () => Date.now() + 7 * 3600 * 1000; // next 6h tick, not a carry re-run
  const out2 = await sweepLinearStartedZombies({ dryRun: false, deps: second.deps });
  assert.equal(out2.todo.length, 1);
  assert.equal(second.applied[0].action, 'todo');
});

test('sweep: no safe-form VERIFY -> leave, command never run, card-leave row for the digest', async () => {
  const { deps, applied, verified, ledgerPath } = harness({
    entries: candidateEntries('BRO-3', 'job-3', '/wt/gone3'),
    issues: { 'BRO-3': startedIssue2('Z', [], 'no criteria') },
  });
  const out = await sweepLinearStartedZombies({ dryRun: false, deps });
  assert.equal(out.left[0].reason, 'no-safe-verify');
  assert.equal(verified.length, 0);
  assert.equal(applied.length, 0);
  assert.equal(readRows(ledgerPath)[0].event, 'card-leave');
});

test('sweep: kill switch LINEAR_ZOMBIE_SWEEP_DISABLED does nothing at all', async () => {
  const { deps, applied, verified, ledgerPath } = harness({
    entries: candidateEntries('BRO-4', 'job-4', '/wt/gone4'),
    issues: { 'BRO-4': startedIssue2('K') },
    extra: { disabled: true },
  });
  const out = await sweepLinearStartedZombies({ dryRun: false, deps });
  assert.equal(out.ran, false);
  assert.equal(applied.length + verified.length, 0);
  assert.equal(fs.existsSync(ledgerPath), false);
});

test('sweep: a CLI refusal (Done gate exit 5) is ledgered as card-fail and never counted', async () => {
  const { deps, reported, ledgerPath, statePath } = harness({
    entries: candidateEntries('BRO-5', 'job-5', '/wt/gone5'),
    issues: { 'BRO-5': startedIssue2('R') },
    applyOk: false,
  });
  await sweepLinearStartedZombies({ dryRun: false, deps });
  assert.equal(readRows(ledgerPath)[0].reason, 'apply-failed:done');
  assert.ok(reported.some((r) => r.kind === 'linear-zombie-reset-failed'));
  assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).doneCount, 0);
});

test('sweep: re-check AFTER the command refuses the write when a person commented meanwhile', async () => {
  const entries = candidateEntries('BRO-10', 'job-10', '/wt/gone10');
  let calls = 0;
  const { deps, applied, reported } = harness({ entries });
  deps.getIssueFn = async () => {
    calls++;
    return calls === 1
      ? startedIssue2('T')
      : startedIssue2('T', [{ createdAt: new Date().toISOString(), body: 'wait, I am on this' }]);
  };
  await sweepLinearStartedZombies({ dryRun: false, deps });
  assert.equal(calls, 2, 'must re-fetch after the command, immediately before writing');
  assert.equal(applied.length, 0);
  assert.ok(reported.some((r) => r.kind === 'linear-zombie-reset-stale'));
});

test('sweep: daily Done cap and per-tick verify budget both stop further work', async () => {
  const entries = [...candidateEntries('BRO-3', 'job-3', '/wt/a'), ...candidateEntries('BRO-4', 'job-4', '/wt/b')];
  const issues = { 'BRO-3': startedIssue2('A'), 'BRO-4': startedIssue2('B') };
  const capped = harness({ entries, issues, maxDonesPerDay: 1 });
  await sweepLinearStartedZombies({ dryRun: false, deps: capped.deps });
  assert.equal(capped.applied.length, 1, 'cap of 1/day stops the second close in the SAME tick');

  const budget = harness({ entries, issues, extra: { maxVerifiesPerTick: 1 } });
  const out = await sweepLinearStartedZombies({ dryRun: false, deps: budget.deps });
  assert.equal(budget.verified.length, 1);
  assert.equal(out.carried, 1, 'the unchecked card carries to the next tick');
  const st = JSON.parse(fs.readFileSync(budget.statePath, 'utf8'));
  assert.equal(st.lastRunTs, null, 'a budget-limited tick must not start the 6h cadence clock');
  assert.deepEqual(st.cycleDone, ['BRO-3'], 'decided cards are remembered so the next tick resumes after them');

  // Next tick resumes at BRO-4 instead of re-verifying BRO-3 forever.
  const resume = harness({ entries, issues, extra: { maxVerifiesPerTick: 1, statePath: budget.statePath } });
  const out2 = await sweepLinearStartedZombies({ dryRun: false, deps: resume.deps });
  assert.deepEqual(resume.verified.length, 1);
  assert.equal(out2.carried, 0);
  assert.equal(JSON.parse(fs.readFileSync(budget.statePath, 'utf8')).cycleDone.length, 0, 'finished cycle clears the cursor');
  assert.ok(JSON.parse(fs.readFileSync(budget.statePath, 'utf8')).lastRunTs, 'finished cycle starts the cadence clock');
});

test('sweep: dry-run decides (runs VERIFY) but never applies or writes the ledger', async () => {
  const { deps, applied, verified, ledgerPath } = harness({
    entries: candidateEntries('BRO-5', 'job-5', '/wt/gone5'),
    issues: { 'BRO-5': startedIssue2('Z') },
  });
  const out = await sweepLinearStartedZombies({ dryRun: true, deps });
  assert.equal(out.done.length, 1);
  assert.equal(verified.length, 1);
  assert.equal(applied.length, 0);
  assert.equal(fs.existsSync(ledgerPath), false, 'dry-run must not create the ledger file at all');
});

test('sweep: refusals still ledger card-fail and the digest line goes silent once parked (2 prior unchanged failures)', async () => {
  // Same checkPark contract scripts/linear-drain-parked.js relies on. A tiny
  // real delay between runs keeps genuinely distinct rows from sharing a ms
  // timestamp (readLinearZombieLedger dedupes exact lines for merge=union).
  const entries = candidateEntries('BRO-6', 'job-6', '/wt/gone6');
  const fresh = [{ createdAt: new Date().toISOString(), body: 'I am looking at this' }];
  const runOnce = async (ledgerPath) => {
    const { deps, reported } = harness({ entries, issues: { 'BRO-6': startedIssue2('P', fresh) } });
    if (ledgerPath) deps.ledgerPath = ledgerPath;
    const out = await sweepLinearStartedZombies({ dryRun: false, deps });
    await new Promise((resolve) => setTimeout(resolve, 2));
    return { reported, ledgerPath: deps.ledgerPath, out };
  };
  const first = await runOnce();
  assert.equal(first.out.refused[0].reason, 'human-comment-recent');
  assert.ok(first.reported.some((r) => r.kind === 'linear-zombie-refused'));
  const second = await runOnce(first.ledgerPath);
  assert.ok(second.reported.some((r) => r.kind === 'linear-zombie-refused'));
  const third = await runOnce(first.ledgerPath);
  assert.ok(!third.reported.some((r) => r.kind === 'linear-zombie-refused'), 'occurrence 3 stays silent');
});

test('sweep: a stale candidate (state moved on since the ledger scan) is skipped, not refused', async () => {
  const { deps, reported, applied } = harness({
    entries: candidateEntries('BRO-7', 'job-7', '/wt/gone7'),
    issues: { 'BRO-7': { title: 'S', state: { type: 'completed' }, comments: { nodes: [] } } },
  });
  const out = await sweepLinearStartedZombies({ dryRun: false, deps });
  assert.equal(out.refused.length + out.done.length + out.todo.length + out.left.length, 0);
  assert.equal(applied.length, 0);
  assert.equal(reported.length, 0);
});

test('readLinearZombieLedger: exact-duplicate lines are dropped (merge=union safety) so one real failure never reads as two', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bsc-reconcile-linear-zombie-dedup-'));
  const ledgerPath = path.join(dir, 'ledger.jsonl');
  const row = JSON.stringify({ ts: '2026-09-01T00:00:00.000Z', event: 'card-fail', cardId: 'BRO-1', contentHash: 'abc' });
  // A union merge can leave the exact same line twice (sync-audit-checkout.sh's
  // recovery stage re-appending locally-saved rows on top of origin's).
  fs.writeFileSync(ledgerPath, `${row}\n${row}\n`);
  const entries = readLinearZombieLedger(ledgerPath);
  assert.equal(entries.length, 1, 'the duplicate line must collapse to one entry');
  const park = isZombieResetParked('BRO-1', { ledgerEntries: entries, contentHash: 'abc' });
  assert.equal(park.parked, false, 'one real failure (however many times its line is duplicated on disk) must never park at maxFailures=2');
});
