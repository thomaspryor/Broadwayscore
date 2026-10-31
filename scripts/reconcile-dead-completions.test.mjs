import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { reopenTask } = require('./reconcile-dead-completions.js');

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'rdc-')); }

// BRO-5845: resetPushedFlag()/correctNotionCard() and their tests were removed
// with the Notion leg; a guard below asserts the CLI never shells notion-brain.js.

function writeTask(dir, id, task) {
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ id, ...task }, null, 2));
}
function readTask(dir, id) {
  return JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), 'utf8'));
}

// Card #1795: the actual regression this card is about. reopenTask()'s old
// any-marker no-op couldn't distinguish "this exact dead-dispatch event was
// already handled" from "a NEW dead completion happened since a previous
// reopen" — a task reopened once, redispatched, and genuinely re-completed
// via a SECOND dead session stayed stuck 'completed' forever (live
// incidents: tasks #1756/#1763).
test('#1795: reopenTask reopens a task that already carries an OLD marker (different dead-dispatch event)', () => {
  const dir = tmpDir();
  writeTask(dir, '1756', {
    status: 'completed',
    owner: 'someone',
    description: '[reconcile-dead-completions 2026-08-17] reopened — marked completed while its most recent dispatch was journaled dead in dispatch-ledger.jsonl (card #1144).\n\noriginal task text',
    lastReopenedForEventTs: '2026-08-17T09:00:00.000Z',
  });

  reopenTask('1756', dir, '2026-08-18T09:00:00.000Z');

  const task = readTask(dir, '1756');
  assert.equal(task.status, 'pending');
  assert.equal(task.owner, null);
  assert.equal(task.lastReopenedForEventTs, '2026-08-18T09:00:00.000Z');
  assert.ok(task.description.startsWith('[reconcile-dead-completions '), 'new banner is stacked, not skipped');
  assert.ok(task.description.includes('original task text'), 'original description survives');
  fs.rmSync(dir, { recursive: true, force: true });
});

// The behavior the original marker was protecting: a repeat --fix run for
// the SAME dead-dispatch event (e.g. a scheduled job firing twice before
// the reopened task is re-dispatched) must still no-op, not stack a second
// banner or re-touch status/owner.
test('#1795: reopenTask still no-ops on a repeat call for the SAME dead-dispatch event', () => {
  const dir = tmpDir();
  writeTask(dir, '1756', {
    status: 'pending', // already reopened by a first call
    owner: null,
    description: '[reconcile-dead-completions 2026-08-18] reopened — ...\n\noriginal',
    lastReopenedForEventTs: '2026-08-18T09:00:00.000Z',
  });

  reopenTask('1756', dir, '2026-08-18T09:00:00.000Z');

  const task = readTask(dir, '1756');
  assert.equal(task.status, 'pending');
  assert.equal((task.description.match(/\[reconcile-dead-completions /g) || []).length, 1, 'no second banner stacked');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('#1795: reopenTask on a task with no prior marker reopens and stamps lastReopenedForEventTs', () => {
  const dir = tmpDir();
  writeTask(dir, '999', { status: 'completed', owner: 'x', description: 'plain task, never reopened' });

  reopenTask('999', dir, '2026-08-18T09:00:00.000Z');

  const task = readTask(dir, '999');
  assert.equal(task.status, 'pending');
  assert.equal(task.lastReopenedForEventTs, '2026-08-18T09:00:00.000Z');
  fs.rmSync(dir, { recursive: true, force: true });
});

// Conservative fallback for malformed/legacy ledger data with no ts to key
// off — preserves the original any-marker guard rather than risk stacking.
test('#1795: reopenTask falls back to the old any-marker no-op when deadAttemptTs is unknown', () => {
  const dir = tmpDir();
  writeTask(dir, '1756', {
    status: 'completed',
    description: '[reconcile-dead-completions 2026-08-17] reopened — ...\n\noriginal',
    lastReopenedForEventTs: '2026-08-17T09:00:00.000Z',
  });

  reopenTask('1756', dir, null);

  const task = readTask(dir, '1756');
  assert.equal(task.status, 'completed', 'no deadAttemptTs to key off of, so the legacy any-marker guard applies');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── BRO-4075: must not reopen a Done Linear issue whose "dead" attempt was
// actually landed-and-acked ────────────────────────────────────────────────
//
// main()'s Linear pass (lines 264-287) only ever calls correctLinearIssue()
// for taskIds that findLinearDeadLaunchCandidates() returns — that function
// (linear-dead-completion-source.js, BRO-3431) is the SAME candidate source
// this file's own header describes as the Linear counterpart of the Notion
// completed-task scan. It is exercised directly here (not through main(),
// which does live Linear/spawnSync I/O) for the same reason this file never
// calls correctNotionCard()/correctLinearIssue() directly elsewhere: the gate
// worth regression-testing is "does this taskId even become a candidate",
// because that gate is what main()'s loop is unconditionally built on.
const { findLinearDeadLaunchCandidates } = require('./lib/linear-dead-completion-source.js');

test('BRO-4075: a landed-acked row after job-stopped-short means the task is never even offered to correctLinearIssue', () => {
  // Live BRO-4065 shape: bsc-runner classified the job job-stopped-short,
  // then a separate session re-verified the sha on origin/main and wrote
  // landed-acked. Before the dispatch-ledger.js isAttemptEvent fix, this
  // taskId still showed up in findLinearDeadLaunchCandidates()'s output, and
  // reconcile-dead-completions.js's main() reopened the already-Done Linear
  // issue for it.
  const entries = [
    { event: 'launch', taskId: 'linear:BRO-4065', ts: '2026-09-23T06:00:00.000Z', workspaceRef: 'headless:linear:BRO-4065' },
    { event: 'job-spawned', taskId: 'linear:BRO-4065', jobId: 'j4065', ts: '2026-09-23T06:01:00.000Z' },
    { event: 'job-stopped-short', taskId: 'linear:BRO-4065', jobId: 'j4065', ts: '2026-09-23T06:11:07.000Z' },
    { event: 'landed-acked', taskId: 'linear:BRO-4065', jobId: 'j4065', sha: 'ff10e4de1a6', ts: '2026-09-23T06:15:41.000Z' },
    { event: 'fanout-verified', taskId: 'fanout', refs: ['linear:BRO-4065'], ts: '2026-09-23T06:15:53.000Z' },
  ];
  const candidates = findLinearDeadLaunchCandidates(entries);
  assert.deepEqual(candidates, [], 'main() only calls correctLinearIssue() for candidates in this list — an empty list means the Done issue is never touched');
});

test('BRO-4075: a genuinely dead launch (no ack row) still reaches correctLinearIssue as a candidate', () => {
  const entries = [
    { event: 'launch', taskId: 'linear:BRO-4070', ts: '2026-09-23T06:00:00.000Z', workspaceRef: 'headless:linear:BRO-4070' },
    { event: 'job-spawned', taskId: 'linear:BRO-4070', jobId: 'j4070', ts: '2026-09-23T06:01:00.000Z' },
    { event: 'job-stopped-short', taskId: 'linear:BRO-4070', jobId: 'j4070', ts: '2026-09-23T06:11:07.000Z' },
  ];
  const candidates = findLinearDeadLaunchCandidates(entries);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].taskId, 'linear:BRO-4070');
});

// Codex adversarial review catch: main()'s candidate list is a snapshot from
// one readEntries() call at startup; correctLinearIssue() is a slow network
// round-trip. If ack-landed.js finishes acking this exact taskId in that
// window, a stale candidate must not still reopen the issue. correctLinearIssue
// re-verifies against opts.entries (a fresh read in production) before ever
// reaching linearClient.getIssue — this test never mocks the network at all
// because the fix must return false BEFORE getting that far.
test('BRO-4075: correctLinearIssue refuses (never touches Linear) when a fresh ledger read shows the task is no longer dead', async () => {
  const { correctLinearIssue } = require('./reconcile-dead-completions.js');
  const freshEntries = [
    { event: 'launch', taskId: 'linear:BRO-4071', ts: '2026-09-23T06:00:00.000Z', workspaceRef: 'headless:linear:BRO-4071' },
    { event: 'job-spawned', taskId: 'linear:BRO-4071', jobId: 'j4071', ts: '2026-09-23T06:01:00.000Z' },
    { event: 'job-stopped-short', taskId: 'linear:BRO-4071', jobId: 'j4071', ts: '2026-09-23T06:11:07.000Z' },
    { event: 'landed-acked', taskId: 'linear:BRO-4071', jobId: 'j4071', sha: 'ccc333', ts: '2026-09-23T06:20:00.000Z' },
  ];
  const result = await correctLinearIssue('BRO-4071', 'linear:BRO-4071', { entries: freshEntries });
  assert.equal(result, false, 'a fresh ledger showing the task landed must refuse the reopen without ever calling the Linear API');
});

test('BRO-5845: reconcile-dead-completions no longer calls the retired Notion board', () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, 'reconcile-dead-completions.js'), 'utf8');
  assert.doesNotMatch(src, /notion-brain|notion-tasks-sync/);
  const mod = require('./reconcile-dead-completions.js');
  assert.equal(mod.correctNotionCard, undefined);
  assert.equal(mod.resetPushedFlag, undefined);
});
