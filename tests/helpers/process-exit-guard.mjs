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
// THE FIX. Install a process.exit that THROWS instead of exiting, for every test
// in the file. A refusal then surfaces the normal way: a named failing subtest,
// with the message. Tests that deliberately drive a refusal path keep stubbing
// process.exit themselves — they save what is installed here and restore it in
// their finally, which composes correctly, and afterEach puts the real one back.
//
// It also clears process.exitCode, the sibling leak documented at length in
// tests/unit/test-exit-code-leak-guard.test.mjs. A CLI that signals refusal with
// `process.exitCode = 1` rather than by exiting leaves that set on the RUNNER's
// process, failing the file with no named subtest — the same unreadable shape by
// a different route. One helper closes both.
//
// Ratcheted by tests/unit/test-exit-code-leak-guard.test.mjs: any test file that
// stubs process.exit must call this.
import { beforeEach, afterEach } from 'node:test';

export function guardProcessExit() {
  let realExit = null;

  beforeEach(() => {
    // Re-entrancy: only capture the genuine exit, never a stub left by a test
    // that threw before its own finally could restore.
    if (realExit === null) realExit = process.exit;
    process.exit = (code) => {
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
    if (realExit !== null) process.exit = realExit;
    realExit = null;
    process.exitCode = 0;
  });
}
