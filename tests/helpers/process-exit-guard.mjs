// BRO-2647. A file-level net against the single most expensive CI failure shape
// this repo produces: SILENT TAP DECAPITATION.
//
// THE BUG. A test drives a CLI's main() and stubs every collaborator except
// process.exit, because it expects that run to SUCCEED. In CI a guard refuses
// instead (BRO-2569's phantom-path guard did exactly this, from
// scripts/bsc-next.test.mjs:1261), the refusal calls a REAL process.exit(1), and
// the node --test worker dies mid-file before it can flush anything. The run
// reports the whole FILE as `failureType: 'testCodeFailure'`, `exitCode: 1`, with
// ZERO named subtests and no exception text, against thousands of subtest lines
// from every other file. There is nothing in the TAP output naming the test, the
// assertion, or the reason. Diagnosing it cost multiple sessions.
//
// THE FIX, in two independent halves, because either one alone has a hole:
//
//   1. process.exit THROWS instead of exiting, so a refusal surfaces the normal
//      way: a named failing subtest, with the message.
//   2. It also RECORDS the attempt, and afterEach fails the test on that record.
//      This half exists because half 1 is swallowable. scripts/linear-next.js
//      wraps three of its own refusal paths in
//          try { ... process.exit(1) } catch { console.error('...continuing') }
//      (the parked guard, the dead-dispatch refusal, and the duplicate-workspace
//      refusal). A thrown value there is caught by the code under test, logged as
//      a warning, and execution CONTINUES past the guard into dispatch — so with
//      only half 1, a regression on those three guards would be a silent PASS,
//      strictly worse than the loud-but-unreadable failure this replaced. The
//      record cannot be swallowed: it is asserted in afterEach, outside the code
//      under test. Found in pre-merge review, not by me.
//
// Tests that deliberately drive a refusal path keep stubbing process.exit
// themselves — they save what is installed here and restore it in their finally,
// which composes correctly, and their own stub never touches the record.
//
// WHY before/after AND NOT beforeEach/afterEach for the swap: afterEach fires for
// EVERY subtest, including a nested t.test(). Swapping the real exit back there
// disarmed the guard for the remainder of the enclosing parent test — the parent
// then ran unguarded while the ratchet still reported the file as protected. Also
// found in review. Arming once per FILE has no such window.
//
// process.exitCode is cleared per test: that is the sibling leak documented at
// length in tests/unit/test-exit-code-leak-guard.test.mjs. A CLI that signals
// refusal by setting process.exitCode = 1 rather than by exiting leaves it set on
// the RUNNER's process, failing the file with no named subtest — the same
// unreadable shape by a different route. One helper closes both.
//
// Ratcheted by tests/unit/test-exit-code-leak-guard.test.mjs.
import { before, after, afterEach } from 'node:test';

export function guardProcessExit() {
  let realExit = null;
  let attempted = null;

  before(() => {
    realExit = process.exit;
    process.exit = (code) => {
      // Record BEFORE throwing — see half 2 above. First attempt wins, so a
      // catch-and-continue that reaches a second exit still reports the first.
      if (attempted === null) attempted = code;
      const err = new Error(
        `process.exit(${code}) was called by the code under test but this test did not stub it. ` +
          'Left unstubbed it kills the node --test worker and truncates the TAP stream, so the ' +
          'whole file fails with no named subtest. Stub process.exit in this test (capture the ' +
          'code, throw, assert) if the refusal is expected. See tests/helpers/process-exit-guard.mjs.'
      );
      err.code = 'UNSTUBBED_PROCESS_EXIT';
      throw err;
    };
  });

  afterEach(() => {
    process.exitCode = 0;
    if (attempted !== null) {
      const code = attempted;
      attempted = null;
      throw new Error(
        `UNSTUBBED_PROCESS_EXIT: the code under test called process.exit(${code}) and this test ` +
          'did not stub it. If the thrown error did not already fail an assertion, the code under ' +
          'test SWALLOWED it in a catch block and kept running past its own refusal — which is ' +
          'exactly the regression this hook exists to make visible. Stub process.exit in this ' +
          'test if the refusal is expected. See tests/helpers/process-exit-guard.mjs.'
      );
    }
  });

  after(() => {
    if (realExit !== null) process.exit = realExit;
    realExit = null;
  });
}
