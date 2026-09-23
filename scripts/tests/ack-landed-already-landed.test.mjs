/**
 * ack-landed-already-landed.test.mjs — BRO-4069: ack-landed.js could not
 * acknowledge a card whose real work landed BEFORE any dispatch attempt on
 * its ledger — decideAck ties a sha to ONE attempt by requiring it be
 * authored AFTER that attempt's launch, which can never pass when the sha
 * genuinely predates every attempt (real case: linear:BRO-3471 landed
 * 2026-09-15T21:33:34-04:00, commit d275bfaef0c, then got mistakenly
 * re-dispatched on 2026-09-20 and 2026-09-21 — both retracted no-ops; every
 * ledger row's launch postdates the real landing). decideAlreadyLanded
 * asserts the OPPOSITE timing: authored before the ref's EARLIEST
 * launch/job-spawned row. Per CLAUDE.md §15 this require()s the real
 * function; a production change breaks the test, which is the point.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const core = require('../lib/ack-landed-core.js');

const REF = 'BRO-3471';
const TASK = `linear:${REF}`;

// Mirrors the real incident: the card's actual fix landed on 2026-09-15,
// long before either re-dispatch attempt below ever launched.
const REAL_LANDING_TS = '2026-09-15T21:33:34-04:00';
const REAL_SHA = 'd275bfaef0c5c97843bf2733493deb7c54a830c';

const ATTEMPT1_LAUNCH_TS = '2026-09-20T14:00:00.000Z';
const ATTEMPT1_STOP_TS = '2026-09-20T14:40:00.000Z';
const ATTEMPT2_LAUNCH_TS = '2026-09-21T00:30:45.978Z';
const ATTEMPT2_STOP_TS = '2026-09-21T01:10:00.000Z';

const rows = [
  { ts: ATTEMPT1_LAUNCH_TS, event: 'job-spawned', taskId: TASK, jobId: `${TASK}-muaie1st`, cwd: '/tmp/job1' },
  { ts: ATTEMPT1_STOP_TS, event: 'job-stopped-short', taskId: TASK, jobId: `${TASK}-muaie1st`, reason: 'no THIS SESSION: status line' },
  { ts: ATTEMPT2_LAUNCH_TS, event: 'job-spawned', taskId: TASK, jobId: `${TASK}-muaie9ja`, cwd: '/tmp/job2' },
  { ts: ATTEMPT2_STOP_TS, event: 'job-stopped-short', taskId: TASK, jobId: `${TASK}-muaie9ja`, reason: 'no THIS SESSION: status line' },
];

const REAL_LANDING = {
  verdict: 'LANDED',
  sha: REAL_SHA,
  commitTs: REAL_LANDING_TS,
  authorTs: REAL_LANDING_TS,
  message: 'fix(BRO-3471): gate Show Score URL duplicate-mapping in CI, close recurrence path',
};

function base(overrides = {}) {
  return {
    ref: REF,
    rows,
    checkout: { containsSha: true, dirtyCodePaths: [] },
    verify: { cmd: 'node --test scripts/lib/show-score-urls-baseline.test.mjs', safe: true, unsafeReason: null, exitCode: 0 },
    reason: 'owning session verified the earlier landing predates every dispatch attempt',
    ackedBy: 'session-abc',
    ...overrides,
  };
}

test('a sha authored BEFORE the earliest dispatch launch is REFUSED under decideAck (reproduces the BRO-3471 bug)', () => {
  const d = core.decideAck(base({ landing: REAL_LANDING }));
  assert.equal(d.ok, false);
  assert.equal(d.row, null);
  assert.match(d.refusals.join('\n'), /BEFORE this dispatch launched/);
});

test('the same sha is ACCEPTED under decideAlreadyLanded, with a distinct landed-before-dispatch row', () => {
  const d = core.decideAlreadyLanded(base({ landing: REAL_LANDING }));
  assert.deepEqual(d.refusals, []);
  assert.equal(d.ok, true);
  assert.equal(d.row.event, 'landed-before-dispatch');
  assert.notEqual(d.row.event, 'landed-acked');
  assert.equal(d.row.taskId, TASK);
  assert.equal(d.row.sha, REAL_SHA);
  assert.equal(d.row.jobId, `${TASK}-muaie9ja`); // newest row's own jobId
  assert.equal(d.row.priorEvent, 'job-stopped-short');
  assert.equal(core.formatAckLine(REF, d.row), `ACKED: ${REF} — ${REAL_SHA} on origin/main, node --test scripts/lib/show-score-urls-baseline.test.mjs exit 0`);
});

test('a sha authored AFTER the earliest launch is REFUSED under decideAlreadyLanded, even if it is before a LATER attempt\'s launch', () => {
  // Authored between attempt 1's launch and attempt 2's launch — this is
  // plausibly attempt 1's OWN work, not "before any dispatch." Using
  // --already-landed here would mislabel real dispatched work as a no-op;
  // the correct tool is decideAck (optionally --job-id attempt1).
  const midAttempt = {
    verdict: 'LANDED',
    sha: 'cafef00dbeef456',
    commitTs: '2026-09-20T14:20:00.000Z',
    authorTs: '2026-09-20T14:20:00.000Z',
    message: `${REF}: attempt 1's own real work`,
  };
  const d = core.decideAlreadyLanded(base({ landing: midAttempt }));
  assert.equal(d.ok, false);
  assert.equal(d.row, null);
  assert.match(d.refusals.join('\n'), /not before the ref's earliest dispatch launch/);
  // Attempt 1's own window does accept it under the ordinary decideAck path.
  const viaAck = core.decideAck(base({ jobId: `${TASK}-muaie1st`, landing: midAttempt }));
  assert.equal(viaAck.ok, true, viaAck.refusals.join('\n'));
});

test('a sha authored AFTER the earliest launch is refused regardless of terminal-row proximity (no upper bound needed)', () => {
  const late = {
    verdict: 'LANDED',
    sha: 'deadbeefcafe789',
    commitTs: ATTEMPT2_STOP_TS,
    authorTs: ATTEMPT2_STOP_TS,
    message: `${REF}: something authored right at the end`,
  };
  const d = core.decideAlreadyLanded(base({ landing: late }));
  assert.equal(d.ok, false);
  assert.match(d.refusals.join('\n'), /not before the ref's earliest dispatch launch/);
});

test('the verify command is still executed (exitCode checked) in BOTH accepted paths', () => {
  // decideAck's own accepted path (attempt 1, tied normally).
  const ackAccepted = core.decideAck(base({
    jobId: `${TASK}-muaie1st`,
    landing: { verdict: 'LANDED', sha: 'cafef00dbeef456', commitTs: '2026-09-20T14:20:00.000Z', message: `${REF}: attempt 1's own real work` },
  }));
  assert.equal(ackAccepted.ok, true, ackAccepted.refusals.join('\n'));
  const ackRedVerify = core.decideAck(base({
    jobId: `${TASK}-muaie1st`,
    landing: { verdict: 'LANDED', sha: 'cafef00dbeef456', commitTs: '2026-09-20T14:20:00.000Z', message: `${REF}: attempt 1's own real work` },
    verify: { cmd: 'node --test scripts/lib/show-score-urls-baseline.test.mjs', safe: true, unsafeReason: null, exitCode: 1 },
  }));
  assert.equal(ackRedVerify.ok, false);
  assert.match(ackRedVerify.refusals.join('\n'), /verify command exited 1, not 0/);

  // decideAlreadyLanded's accepted path.
  const alreadyAccepted = core.decideAlreadyLanded(base({ landing: REAL_LANDING }));
  assert.equal(alreadyAccepted.ok, true, alreadyAccepted.refusals.join('\n'));
  const alreadyRedVerify = core.decideAlreadyLanded(base({
    landing: REAL_LANDING,
    verify: { cmd: 'node --test scripts/lib/show-score-urls-baseline.test.mjs', safe: true, unsafeReason: null, exitCode: 1 },
  }));
  assert.equal(alreadyRedVerify.ok, false);
  assert.match(alreadyRedVerify.refusals.join('\n'), /verify command exited 1, not 0/);
});

test('refuse: sha not on origin/main under decideAlreadyLanded', () => {
  const d = core.decideAlreadyLanded(base({ landing: { ...REAL_LANDING, verdict: 'NOT_LANDED' } }));
  assert.equal(d.ok, false);
  assert.match(d.refusals.join('\n'), /not an ancestor of origin\/main/);
});

test('refuse: commit message does not name the ref under decideAlreadyLanded', () => {
  const d = core.decideAlreadyLanded(base({ landing: { ...REAL_LANDING, message: 'chore: unrelated cleanup' } }));
  assert.equal(d.ok, false);
  assert.match(d.refusals.join('\n'), new RegExp(`commit message does not name ${REF}`));
});

test('refuse: newest ledger row is not terminal under decideAlreadyLanded (same precondition as decideAck)', () => {
  const openRows = rows.slice(0, 3); // ends on job-spawned, still open
  const d = core.decideAlreadyLanded(base({ rows: openRows, landing: REAL_LANDING }));
  assert.equal(d.ok, false);
  assert.match(d.refusals.join('\n'), /not a terminal event/);
});

test('refuse: no launch/job-spawned row at all under decideAlreadyLanded', () => {
  const d = core.decideAlreadyLanded(base({ rows: [], landing: REAL_LANDING }));
  assert.equal(d.ok, false);
  assert.match(d.refusals.join('\n'), /no dispatch-ledger row/);
});

test('earliestLaunch returns the EARLIEST launch/job-spawned row, not the latest', () => {
  const earliest = core.earliestLaunch(rows);
  assert.equal(earliest.ts, ATTEMPT1_LAUNCH_TS);
  assert.equal(earliest.jobId, `${TASK}-muaie1st`);
});

test('refuse: reason shorter than 15 chars under decideAlreadyLanded', () => {
  const d = core.decideAlreadyLanded(base({ landing: REAL_LANDING, reason: 'too short' }));
  assert.equal(d.ok, false);
  assert.match(d.refusals.join('\n'), /--reason must be at least 15 characters/);
});
