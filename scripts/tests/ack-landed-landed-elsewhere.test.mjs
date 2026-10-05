/**
 * ack-landed-landed-elsewhere.test.mjs — BRO-4662: ack-landed.js could say
 * "a dispatched job's work landed" (decideAck) and "the work predates every
 * dispatch" (decideAlreadyLanded), but never "every attempt produced nothing
 * and the card's work landed later by a route outside the ledger". Real
 * case: linear:BRO-4137 — dispatched 2026-09-24 (job-done, no work) and
 * 2026-09-25 (job-stranded at an unrelated housekeeping sha 479367e3f69);
 * the work landed 2026-09-29 as 73975937bae from a crowned OWNER tab. Every
 * ack path refused it. Rows below mirror the real ledger rows.
 *
 * CLAUDE.md §15: require()s the real core + CLI helpers.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const core = require('../lib/ack-landed-core.js');
const { parseArgs, runVerifyAndDecide } = require('../ack-landed.js');
const ledger = require('../lib/dispatch-ledger.js');

const REF = 'BRO-4137';
const TASK = `linear:${REF}`;
const JOB1 = `${TASK}-mug6rv6c`;
const JOB2 = `${TASK}-mugff0ua`;
const STRANDED_SHA = '479367e3f698e9a826f125ed97714513499331f4';
const WORK_SHA = '73975937bae';

const rows = [
  { ts: '2026-09-24T23:51:56.818Z', event: 'launch', taskId: TASK, workspaceRef: `headless:${TASK}`, verifyCmd: 'node --test tests/unit/absence-claim-control.test.mjs', correlationId: '0eccd007' },
  { ts: '2026-09-24T23:52:15.156Z', event: 'job-spawned', taskId: TASK, jobId: JOB1 },
  { ts: '2026-09-25T00:13:01.686Z', event: 'direct-push-attempt', taskId: 'direct-push' },
  { ts: '2026-09-25T00:34:23.170Z', event: 'job-done', taskId: TASK, jobId: JOB1 },
  { ts: '2026-09-25T03:53:54.176Z', event: 'launch', taskId: TASK, workspaceRef: `headless:${TASK}`, verifyCmd: 'node --test tests/unit/absence-claim-control.test.mjs', correlationId: '90f5e0d8' },
  { ts: '2026-09-25T03:54:05.428Z', event: 'job-spawned', taskId: TASK, jobId: JOB2 },
  { ts: '2026-09-25T04:40:52.766Z', event: 'job-stranded', taskId: TASK, jobId: JOB2, sha: STRANDED_SHA },
].filter((r) => r.taskId === TASK); // rowsForRef's view

const WORK = {
  verdict: 'LANDED',
  sha: WORK_SHA,
  authorTs: '2026-09-29T15:08:22-04:00',
  commitTs: '2026-09-29T19:57:08Z',
  message: 'test: repo-side acceptance for Gate 7 absence-claim guard (BRO-4137, BRO-4374)',
  tiedToStranded: false,
  tiedToStrandedByPatch: false,
};

function base(overrides = {}) {
  return {
    ref: REF,
    rows,
    landing: WORK,
    checkout: { containsSha: true, dirtyCodePaths: [] },
    verify: { cmd: 'node --test tests/unit/absence-claim-control.test.mjs', safe: true, unsafeReason: null, exitCode: 0 },
    reason: 'work landed from a crowned OWNER tab after both dispatches produced nothing',
    ackedBy: 'session-test',
    ...overrides,
  };
}

test('reproduces BRO-4137: the card-naming sha on origin/main is REFUSED by decideAck (stranded-sha tie) and by decideAlreadyLanded', () => {
  const ack = core.decideAck(base());
  assert.equal(ack.ok, false);
  assert.match(ack.refusals.join('\n'), /stranded sha 479367e3f69/);
  const before = core.decideAlreadyLanded(base());
  assert.equal(before.ok, false);
  assert.match(before.refusals.join('\n'), /not before the ref's earliest dispatch launch/);
});

test('the same sha is ACCEPTED under decideLandedElsewhere, with a distinct landed-outside-dispatch row', () => {
  const d = core.decideLandedElsewhere(base());
  assert.deepEqual(d.refusals, []);
  assert.equal(d.ok, true);
  assert.equal(d.row.event, 'landed-outside-dispatch');
  assert.notEqual(d.row.event, 'landed-acked');
  assert.equal(d.row.event, ledger.JOB_EVENTS.LANDED_OUTSIDE_DISPATCH);
  assert.equal(d.row.taskId, TASK);
  assert.equal(d.row.sha, WORK_SHA);
  assert.equal(d.row.jobId, JOB2);
  assert.equal(d.row.priorEvent, 'job-stranded');
});

test('an arbitrary commit that does not name the card is REFUSED, even on origin/main and outside every window', () => {
  const d = core.decideLandedElsewhere(base({ landing: { ...WORK, message: 'data: alert-router ledger update (land.yml) [skip ci]' } }));
  assert.equal(d.ok, false);
  assert.equal(d.row, null);
  assert.match(d.refusals.join('\n'), /does not name BRO-4137/);
});

test('a sibling id that merely shares the prefix (BRO-41370) does not count as naming the card', () => {
  const d = core.decideLandedElsewhere(base({ landing: { ...WORK, message: 'fix (BRO-41370)' } }));
  assert.equal(d.ok, false);
});

test('a sha authored INSIDE an attempt window is refused (that is the attempt\'s own work — default ack / --job-id)', () => {
  for (const authorTs of ['2026-09-25T00:10:00Z', '2026-09-25T04:00:00Z', '2026-09-25T04:44:00Z' /* inside +5min grace */]) {
    const d = core.decideLandedElsewhere(base({ landing: { ...WORK, authorTs } }));
    assert.equal(d.ok, false, authorTs);
    assert.match(d.refusals.join('\n'), /INSIDE the dispatch attempt/, authorTs);
  }
});

test('a sha authored between two attempts (after the first ended, before the second launched) is accepted', () => {
  const d = core.decideLandedElsewhere(base({ landing: { ...WORK, authorTs: '2026-09-25T02:00:00Z' } }));
  assert.deepEqual(d.refusals, []);
});

test('a sha authored BEFORE the earliest launch is refused here (that is --already-landed)', () => {
  const d = core.decideLandedElsewhere(base({ landing: { ...WORK, authorTs: '2026-09-20T00:00:00Z' } }));
  assert.equal(d.ok, false);
  assert.match(d.refusals.join('\n'), /--already-landed case/);
});

test('refused: not on origin/main; checkout dirty; verify unsafe; verify non-zero; short reason', () => {
  assert.match(core.decideLandedElsewhere(base({ landing: { ...WORK, verdict: 'NOT_LANDED' } })).refusals.join('\n'), /not an ancestor of origin\/main/);
  assert.match(core.decideLandedElsewhere(base({ checkout: { containsSha: true, dirtyCodePaths: ['scripts/x.js'] } })).refusals.join('\n'), /uncommitted code changes/);
  assert.match(core.decideLandedElsewhere(base({ verify: { cmd: 'rm -rf /', safe: false, unsafeReason: 'nope', exitCode: 0 } })).refusals.join('\n'), /not a safe-form command/);
  assert.match(core.decideLandedElsewhere(base({ verify: { cmd: 'node --test x', safe: true, exitCode: 1 } })).refusals.join('\n'), /exited 1, not 0/);
  assert.match(core.decideLandedElsewhere(base({ reason: 'short' })).refusals.join('\n'), /at least 15 characters/);
});

test('refused: newest row still live (a relaunch after the stranding) and no double-ack after landed-outside-dispatch', () => {
  const live = [...rows, { ts: '2026-10-01T00:00:00Z', event: 'launch', taskId: TASK, workspaceRef: `headless:${TASK}` }];
  assert.match(core.decideLandedElsewhere(base({ rows: live })).refusals.join('\n'), /not a terminal event/);
  const acked = [...rows, { ts: '2026-10-04T00:00:00Z', event: 'landed-outside-dispatch', taskId: TASK, jobId: JOB2, sha: WORK_SHA }];
  assert.match(core.decideLandedElsewhere(base({ rows: acked })).refusals.join('\n'), /already landed-outside-dispatch .* do not double-ack/);
  assert.match(core.decideAck(base({ rows: acked })).refusals.join('\n'), /do not double-ack/);
});

test('attemptWindows: launch+job-spawned is one attempt; a launch with no terminal row is bounded by the next relaunch', () => {
  assert.deepEqual(core.attemptWindows(rows).map((w) => [w.launchTs, w.endEvent]), [
    ['2026-09-24T23:51:56.818Z', 'job-done'],
    ['2026-09-25T03:53:54.176Z', 'job-stranded'],
  ]);
  const cmux = [
    { ts: '2026-09-01T00:00:00Z', event: 'launch', taskId: TASK, workspaceRef: 'workspace:9' },
    { ts: '2026-09-02T00:00:00Z', event: 'launch', taskId: TASK, workspaceRef: 'workspace:10' },
    { ts: '2026-09-02T01:00:00Z', event: 'vanished', taskId: TASK, workspaceRef: 'workspace:10' },
  ];
  const w = core.attemptWindows(cmux);
  assert.equal(w.length, 2);
  assert.equal(w[0].endTs, '2026-09-02T00:00:00Z');
  assert.equal(w[1].endEvent, 'vanished');
  // A sha between the two cmux launches is inside the first (unterminated) attempt.
  const d = core.decideLandedElsewhere(base({ rows: cmux, landing: { ...WORK, authorTs: '2026-09-01T12:00:00Z' } }));
  assert.match(d.refusals.join('\n'), /INSIDE the dispatch attempt/);
  // ...and one after the last attempt ended is accepted.
  assert.deepEqual(core.decideLandedElsewhere(base({ rows: cmux, landing: { ...WORK, authorTs: '2026-09-05T00:00:00Z' } })).refusals, []);
});

test('the verify command is actually EXECUTED in the accepted path, and its real exit code decides', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ack-elsewhere-'));
  try {
    const decide = (extra) => core.decideLandedElsewhere(base(extra));
    const ok = runVerifyAndDecide(decide, { cmd: 'echo ran > marker.txt', safe: true, unsafeReason: null, exitCode: null }, { cwd: dir });
    assert.equal(fs.readFileSync(path.join(dir, 'marker.txt'), 'utf8').trim(), 'ran');
    assert.equal(ok.ok, true);
    assert.equal(ok.row.event, 'landed-outside-dispatch');
    assert.equal(ok.row.verifyCmd, 'echo ran > marker.txt');
    const bad = runVerifyAndDecide(decide, { cmd: 'exit 3', safe: true, unsafeReason: null, exitCode: 0 }, { cwd: dir });
    assert.equal(bad.ok, false);
    assert.match(bad.refusals.join('\n'), /exited 3, not 0/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('parseArgs: --landed-elsewhere parses alone and refuses --job-id / --already-landed', () => {
  assert.equal(parseArgs(['--landed-elsewhere', '--id', REF]).landedElsewhere, true);
  assert.match(parseArgs(['--landed-elsewhere', '--job-id', JOB2]).error, /cannot be combined/);
  assert.match(parseArgs(['--landed-elsewhere', '--already-landed']).error, /cannot be combined/);
});

test('every consumer of the ack-event family accepts landed-outside-dispatch (the set has been hand-propagated three times)', () => {
  const family = ledger.LANDED_ACK_EVENTS;
  assert.ok(family.has('landed-acked') && family.has('landed-before-dispatch') && family.has('landed-outside-dispatch'));
  for (const ev of family) assert.ok(core.NOTHING_TO_ACK_EVENTS.has(ev), `ack-landed-core NOTHING_TO_ACK_EVENTS lacks ${ev}`);
  const fanout = require('../lib/fanout-verified-core.js');
  for (const ev of family) {
    assert.ok(fanout.LANDED_EVENTS.has(ev), `fanout LANDED_EVENTS lacks ${ev}`);
    assert.ok(fanout.ACK_EVENTS.has(ev), `fanout ACK_EVENTS lacks ${ev}`);
  }
  const watchdog = require('../lib/dispatch-watchdog-core.js');
  for (const ev of family) assert.ok(watchdog.NO_FURTHER_DISPATCH_EVENTS.has(ev), `watchdog NO_FURTHER_DISPATCH_EVENTS lacks ${ev}`);
  // landedAckOverridesDeath: the dead stranded attempt is no longer "needs re-dispatch".
  const all = [...rows, { ts: '2026-10-04T00:00:00Z', event: 'landed-outside-dispatch', taskId: TASK, jobId: JOB2, sha: WORK_SHA }];
  const dead = rows[rows.length - 1];
  assert.equal(ledger.landedAckOverridesDeath(TASK, dead, all), true);
  assert.equal(ledger.landedAckOverridesDeath(TASK, dead, rows), false);
});
