// dispatch-guards.test.mjs — direct unit coverage for closedCardGuard's
// trashed-page check (task #1811). closedCardGuard had no colocated test
// file before this — it was only exercised indirectly through
// bsc-next.test.mjs's runSuccessionDispatch harness, which is the right
// place for wiring coverage but the wrong place for the guard's own pure
// decision logic. This file covers that logic directly, matching the
// colocated-test pattern predispatch-guard.test.mjs already establishes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { closedCardGuard, dispatchClaimGuard, sessionAliveForTask, pidStartedNear } = require('./dispatch-guards.js');

const TASK = { id: '1811', subject: 'test task', status: 'in_progress' };

// ── behaviour table (task #1811 acceptance criteria) ───────────────────────
test('closedCardGuard: trashed page + "In progress" status is REFUSED', () => {
  const err = closedCardGuard(TASK, { status: 'In progress', archived: true }, {});
  assert.match(err, /REFUSING to dispatch #1811/);
  assert.match(err, /TRASH/);
});

test('closedCardGuard: trashed page + "Not started" status is REFUSED', () => {
  const err = closedCardGuard(TASK, { status: 'Not started', archived: true }, {});
  assert.match(err, /REFUSING to dispatch #1811/);
  assert.match(err, /TRASH/);
});

test('closedCardGuard: live page + "In progress" status is ALLOWED', () => {
  assert.equal(closedCardGuard(TASK, { status: 'In progress', archived: false }, {}), null);
});

test('closedCardGuard: live page + "Not started" status is ALLOWED', () => {
  assert.equal(closedCardGuard(TASK, { status: 'Not started', archived: false }, {}), null);
});

test('closedCardGuard: "Done" status (not trashed) is still REFUSED — existing behavior preserved', () => {
  const err = closedCardGuard(TASK, { status: 'Done', archived: false }, {});
  assert.match(err, /REFUSING to dispatch #1811/);
  assert.match(err, /already Done/);
});

test('closedCardGuard: card == null (degraded fetch) is ALLOWED — never livelocks the stall sweep', () => {
  assert.equal(closedCardGuard(TASK, null, {}), null);
});

// ── archived flag absent (pre-fix payloads, or any caller bypassing formatCard) ──
test('closedCardGuard: archived flag absent behaves as not-trashed (falsy, no throw)', () => {
  assert.equal(closedCardGuard(TASK, { status: 'In progress' }, {}), null);
});

// ── bypass flags ─────────────────────────────────────────────────────────────
test('closedCardGuard: --allow-closed-card bypasses a trashed-page refusal too (same top-level bypass as any closed card)', () => {
  assert.equal(closedCardGuard(TASK, { status: 'In progress', archived: true }, { 'allow-closed-card': true }), null);
});

test('closedCardGuard: --dry-run / --print-prompt bypass a trashed-page refusal', () => {
  assert.equal(closedCardGuard(TASK, { status: 'In progress', archived: true }, { 'dry-run': true }), null);
  assert.equal(closedCardGuard(TASK, { status: 'In progress', archived: true }, { 'print-prompt': true }), null);
});

// Adversarial review (codex, task #1811): --allow-closed-card only bypasses
// closedCardGuard — predispatch-guard.js's classifyCandidate runs its own
// independent archived check right after and refuses it unless
// --allow-reopen-suspect is ALSO set (card-archived-in-trash never matches
// the `card-status-terminal:${status}` pattern predispatchGuard's
// --allow-closed-card carve-out looks for). A real dispatch onto a trashed
// card therefore needs BOTH flags — this is the same shape a Done+PARKED
// card already required pre-#1811 (closedCardGuard's --allow-closed-card
// clears the status check, but classifyCandidate's parked-marker branch
// still needs --allow-reopen-suspect too), not a new inconsistency. The
// refusal text must say so, since a reader who follows closedCardGuard's
// suggestion literally and adds only --allow-closed-card would otherwise
// hit a second, differently-worded refusal from predispatch-guard.js.
test('closedCardGuard: trashed-page refusal message tells the reader --allow-closed-card alone will not be enough', () => {
  const err = closedCardGuard(TASK, { status: 'In progress', archived: true }, {});
  assert.match(err, /--allow-reopen-suspect/);
});

// ── dispatchClaimGuard (task #1896) ─────────────────────────────────────────
// Pure: the actual acquireClaim() mkdir/EEXIST I/O is scripts/lib/atomic-
// claim.js's job (covered in scripts/lib/dispatch-overlap-check.test.mjs's
// race-simulation cases); this only checks how a claim RESULT becomes a
// refusal (or not).
test('dispatchClaimGuard: claimResult === true is silent (this attempt won the claim)', () => {
  assert.equal(dispatchClaimGuard(TASK, true, {}), null);
});

test('dispatchClaimGuard: claimResult === false (genuinely held elsewhere) refuses, naming the mirror-staleness race', () => {
  const err = dispatchClaimGuard(TASK, false, {});
  assert.match(err, /REFUSING to dispatch #1811/);
  assert.match(err, /mirror-staleness race/);
  assert.match(err, /--force/);
});

test('dispatchClaimGuard: claimResult === \'error\' (unreadable claim meta) fails closed with a distinct message', () => {
  const err = dispatchClaimGuard(TASK, 'error', {});
  assert.match(err, /REFUSING to dispatch #1811/);
  assert.match(err, /claim dir unreadable\/corrupt/);
});

test('dispatchClaimGuard: --force / --dry-run / --print-prompt all bypass it, even on a held claim', () => {
  assert.equal(dispatchClaimGuard(TASK, false, { force: true }), null);
  assert.equal(dispatchClaimGuard(TASK, false, { 'dry-run': true }), null);
  assert.equal(dispatchClaimGuard(TASK, false, { 'print-prompt': true }), null);
  assert.equal(dispatchClaimGuard(TASK, 'error', { force: true }), null);
});

// BRO-268: pidStartedNear cross-checks a lease's recorded pid against its
// OWN process start time (not just "does this pid's argv look like claude"),
// closing the recycled-pid gap two independent adversarial reviews (Codex +
// a Claude codebase review, 2026-08-26) converged on: a stale lease left by
// a hard crash, later recycled by the OS onto an unrelated claude process,
// must not read as "the original lease holder is still alive."
test('pidStartedNear: true when the pid\'s elapsed time (ps etime=) puts its start at/near the lease timestamp', () => {
  const nowMs = Date.parse('2026-08-26T15:10:00.000Z');
  const sinceIso = '2026-08-26T15:00:00.000Z';
  const execFn = () => '00:10:00\n'; // 10 min elapsed -> started exactly at sinceIso
  assert.equal(pidStartedNear(12345, sinceIso, { execFn, nowMs }), true);
});

test('pidStartedNear: false when the pid started well AFTER the lease timestamp (recycled-pid shape)', () => {
  const nowMs = Date.parse('2026-08-26T16:30:00.000Z');
  const sinceIso = '2026-08-26T15:00:00.000Z';
  const execFn = () => '00:00:05\n'; // just started, 5s ago -> ~16:29:55, 89 min after the lease
  assert.equal(pidStartedNear(12345, sinceIso, { execFn, nowMs }), false);
});

test('pidStartedNear: parses the day-prefixed etime form ([dd-]hh:mm:ss)', () => {
  const nowMs = Date.parse('2026-08-26T15:00:00.000Z');
  const sinceIso = '2026-08-24T15:00:03.000Z'; // 2 days + 3s ago
  const execFn = () => '2-00:00:00\n'; // exactly 2 days elapsed
  assert.equal(pidStartedNear(12345, sinceIso, { execFn, nowMs }), true);
});

test('pidStartedNear: fails safe to false on a ps error, missing pid/timestamp, or unparseable output', () => {
  assert.equal(pidStartedNear(12345, '2026-08-26T15:00:00.000Z', { execFn: () => { throw new Error('no such pid'); } }), false);
  assert.equal(pidStartedNear(null, '2026-08-26T15:00:00.000Z', {}), false);
  assert.equal(pidStartedNear(12345, null, {}), false);
  assert.equal(pidStartedNear(12345, '2026-08-26T15:00:00.000Z', { execFn: () => 'garbage, not etime\n' }), false);
});

test('sessionAliveForTask: true only when a lease exists, its pid is confirmed alive, AND the pid started near the lease acquiredAt', () => {
  const lease = { pid: 999, acquiredAt: '2026-08-26T15:00:00.000Z' };
  const good = sessionAliveForTask('t1', {
    readLeaseFn: () => lease,
    isAliveFn: () => true,
    pidStartedNearFn: () => true,
  });
  assert.equal(good, true);
});

test('sessionAliveForTask: false when the pid looks like claude but did NOT start near the lease (recycled-pid case)', () => {
  const lease = { pid: 999, acquiredAt: '2026-08-26T15:00:00.000Z' };
  const result = sessionAliveForTask('t1', {
    readLeaseFn: () => lease,
    isAliveFn: () => true, // pid IS currently a live claude process...
    pidStartedNearFn: () => false, // ...but it started long after this lease was written
  });
  assert.equal(result, false);
});

test('sessionAliveForTask: false when the lease has no acquiredAt at all (can\'t cross-check identity)', () => {
  const result = sessionAliveForTask('t1', {
    readLeaseFn: () => ({ pid: 999 }),
    isAliveFn: () => true,
    pidStartedNearFn: () => true,
  });
  assert.equal(result, false);
});

test('sessionAliveForTask: false on no lease, no pid, or a dead pid (unchanged base cases)', () => {
  assert.equal(sessionAliveForTask('t1', { readLeaseFn: () => null, isAliveFn: () => true, pidStartedNearFn: () => true }), false);
  assert.equal(sessionAliveForTask('t1', { readLeaseFn: () => ({ pid: null, acquiredAt: '2026-08-26T15:00:00.000Z' }), isAliveFn: () => true, pidStartedNearFn: () => true }), false);
  assert.equal(sessionAliveForTask('t1', { readLeaseFn: () => ({ pid: 999, acquiredAt: '2026-08-26T15:00:00.000Z' }), isAliveFn: () => false, pidStartedNearFn: () => true }), false);
});

test('sessionAliveForTask: real integration — a lease matching THIS test process\'s own pid/start time reads alive; a stale-looking lease (old acquiredAt, unrelated dead pid) does not', () => {
  // Use this test process's OWN pid so pidLooksLikeClaude-equivalent liveness
  // is trivially true without spawning anything — but exercise pidStartedNear
  // for real (no execFn override) against this process's real elapsed time.
  const { execFileSync } = require('node:child_process');
  const nowMs = Date.now();
  const realEtime = execFileSync('ps', ['-o', 'etime=', '-p', String(process.pid)], { encoding: 'utf8' }).trim();
  const parts = realEtime.split(':').map(Number);
  const elapsedSec = parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : parts[0] * 60 + parts[1];
  const realStartMs = nowMs - elapsedSec * 1000;
  const closeIso = new Date(realStartMs + 1000).toISOString(); // 1s after real start
  const staleIso = new Date(realStartMs - 24 * 60 * 60 * 1000).toISOString(); // 1 day before — implausible
  assert.equal(sessionAliveForTask('t1', { readLeaseFn: () => ({ pid: process.pid, acquiredAt: closeIso }), isAliveFn: () => true }), true);
  assert.equal(sessionAliveForTask('t1', { readLeaseFn: () => ({ pid: process.pid, acquiredAt: staleIso }), isAliveFn: () => true }), false);
});
