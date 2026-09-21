// Tests scripts/linear-brain.js's `update --state <Done-type>` path wired to
// scripts/lib/linear-done-gate.js / done-semantics-gate.js (BRO-457).
// done-semantics-gate.js's evaluateDoneTransition() was built and unit-tested
// in BRO-379 but had zero callers — this proves it's now actually enforced at
// the one place a Linear issue's state moves to a completed-type state.
//
// Driven end-to-end IN A REAL SUBPROCESS, not an in-process call with
// process.exit stubbed to throw: the refusal's process.exit(5) sits inside
// the same `try { ... } catch (err) { ...; process.exit(2); }` that wraps the
// whole update body (pre-existing shape — the "unknown state name" exit(1)
// a few lines above it has the identical nesting), so a throwing stub would
// be caught by that same catch and re-exit(2), masking the real refusal
// code. tests/unit/linear-next.test.mjs's "guard parity" test documents this
// exact class of problem and uses the same real-subprocess fix. No
// LINEAR_API_KEY, no live Linear call — getIssue/getTeam/updateIssue/
// createComment are all injected via main()'s `deps` param.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

const TEAM_STATES = [
  { id: 'state-todo', name: 'Todo', type: 'unstarted' },
  { id: 'state-progress', name: 'In Progress', type: 'started' },
  { id: 'state-done', name: 'Done', type: 'completed' },
];

function makeIssue(description, commentBodies = []) {
  return {
    id: 'issue-uuid-457',
    identifier: 'BRO-9457',
    title: 'Fixture issue for the done-semantics gate',
    url: 'https://linear.app/broadway-scorecard/issue/BRO-9457/fixture',
    description,
    state: { id: 'state-progress', name: 'In Progress', type: 'started' },
    // getIssue()'s real query already fetches comments(first: 20) — this
    // fixture matches that shape so the gate's existingComments read is
    // exercised, not just its description/commentText reads.
    comments: { nodes: commentBodies.map((body, i) => ({ id: `c${i}`, body, createdAt: null, user: null })) },
  };
}

// Builds a runnable fixture script that requires the real linear-brain.js,
// injects stub I/O via main()'s deps param, and calls it with the given argv.
// `verify` stubs the origin/main evidence check (done-evidence-verify.js):
// 'ok' = the cited commit is on origin/main, 'not-on-main' = definitively
// not, anything else = could not be determined. No test ever shells out.
//
// `verifyCmd` stubs the recorded-command executor (linear-cmd-execution.js's
// makeVerifyCmdEvidence, BRO-3885). WITHOUT it this file's acceptance-criteria
// case fell through to the REAL executor, which clones/fetches origin/main and
// runs `node --test ...` for real inside a 15s spawnSync cap — ~29s on a loaded
// machine, so the test failed by timeout whenever the box was busy (it blocked
// BRO-3435's land on 2026-09-21). That is also what the paragraph above already
// promised: no test here shells out. What the CLI must prove at THIS seam is
// that it passes the recorded command through to the executor, which the
// VERIFY_CMD_CALLED assertion below covers; that the executor itself really
// runs a command is scripts/lib/linear-cmd-execution.test.mjs's job.
// 'pass' (default) = the command ran and passed, 'fail' = it ran and failed.
function runUpdate({ argv, description, comments = [], updateShouldBeCalled, verify, verifyCmd = 'pass' }) {
  // Shapes match linear-cmd-execution.js's real return (allowed/verdict/
  // reason/notOnMain/sha), and 'own-verify-failed' is the verdict the real
  // executor actually produces on a failing command (close-time-verify.js
  // FAIL) — NOT 'verify-cmd-failed', which is only applyCmdExecution's
  // fallback for a verdict-less result. A stub that invents wording
  // production never prints lets a caption assertion pass on a string no
  // operator will ever see; linear-session-done-gate.test.mjs's twin case
  // deliberately omits `verdict` to cover that fallback branch instead.
  const cmdVerifier = verifyCmd === 'fail'
    ? "(cmd) => { console.error('VERIFY_CMD_CALLED:' + cmd); return { allowed: false, verdict: 'own-verify-failed', reason: 'stub: command failed', notOnMain: false, sha: 'stub000000' }; }"
    : "(cmd) => { console.error('VERIFY_CMD_CALLED:' + cmd); return { allowed: true, verdict: 'own-verify-passed', reason: 'stub: command passed', notOnMain: false, sha: 'stub000000' }; }";
  const verifier = verify === 'ok'
    ? "() => ({ verified: true, reason: 'stub: on origin/main' })"
    : verify === 'not-on-main'
      ? "() => ({ verified: false, reason: 'stub: commit is NOT on origin/main' })"
      : "() => ({ verified: null, reason: 'stub: unknown' })";
  const script = `
    const { main } = require('./scripts/linear-brain.js');
    const issue = ${JSON.stringify(makeIssue(description, comments))};
    main(${JSON.stringify(argv)}, {
      verifyEvidence: ${verifier},
      verifyCmdEvidence: ${cmdVerifier},
      getIssue: async () => issue,
      getTeam: async () => ({ states: ${JSON.stringify(TEAM_STATES)} }),
      // BRO-3435, ship-check finding 2026-09-21: without this stub, a
      // --force / LINEAR_DONE_GATE_DISABLED=1 case below falls through to
      // the REAL appendBypassRow and writes a live row to
      // data/audit/linear-gate-bypass.jsonl on every CI run of this file.
      appendBypassRow: () => {},
      updateIssue: async () => {
        ${updateShouldBeCalled ? "console.error('UPDATE_ISSUE_CALLED');" : "throw new Error('updateIssue must not be called — the gate refused before any write');"}
      },
      createComment: async () => {
        ${updateShouldBeCalled ? "console.error('CREATE_COMMENT_CALLED');" : "throw new Error('createComment must not be called — the gate refused before any write');"}
      },
    });
  `;
  return spawnSync(process.execPath, ['-e', script], { cwd: REPO_ROOT, encoding: 'utf8', timeout: 15000 });
}

test('refused: moving to a completed-type state with neither PR evidence nor a verify command', () => {
  const res = runUpdate({
    argv: ['update', 'BRO-9457', '--state', 'Done'],
    description: 'Fixed the thing, looks good.',
    updateShouldBeCalled: false,
  });
  assert.equal(res.status, 5, `expected exit 5 (done-gate refusal), got ${res.status}. stderr:\n${res.stderr}`);
  assert.match(res.stderr, /REFUSED \(no-done-evidence\)/);
  assert.match(res.stderr, /no PR reference recorded/);
  assert.doesNotMatch(res.stderr, /UPDATE_ISSUE_CALLED/, 'updateIssue must never run once the gate refuses');
  assert.doesNotMatch(res.stderr, /CREATE_COMMENT_CALLED/);
});

test('allowed: a safe-form verify command in the acceptance criteria', () => {
  const res = runUpdate({
    argv: ['update', 'BRO-9457', '--state', 'Done'],
    description: '## Acceptance criteria\n- `node --test tests/unit/done-semantics-gate.test.mjs` passes',
    updateShouldBeCalled: true,
  });
  assert.equal(res.status, 0, `expected exit 0, got ${res.status}. stderr:\n${res.stderr}`);
  assert.match(res.stderr, /UPDATE_ISSUE_CALLED/);
  assert.doesNotMatch(res.stderr, /REFUSED/);
  // The CLI must hand the RECORDED command to the executor seam — a gate that
  // allowed the move without consulting it would still pass the two asserts
  // above.
  assert.match(res.stderr, /VERIFY_CMD_CALLED:node --test tests\/unit\/done-semantics-gate\.test\.mjs/);
});

test('refused: the recorded acceptance command is executed and FAILS', () => {
  const res = runUpdate({
    argv: ['update', 'BRO-9457', '--state', 'Done'],
    description: '## Acceptance criteria\n- `node --test tests/unit/done-semantics-gate.test.mjs` passes',
    updateShouldBeCalled: false,
    verifyCmd: 'fail',
  });
  assert.equal(res.status, 5, `expected exit 5, got ${res.status}. stderr:\n${res.stderr}`);
  assert.match(res.stderr, /VERIFY_CMD_CALLED:/);
  assert.match(res.stderr, /REFUSED \(own-verify-failed\)/);
  assert.doesNotMatch(res.stderr, /UPDATE_ISSUE_CALLED/);
});

// The CLI's `deps.verifyCmdEvidence || makeVerifyCmdEvidence(...)` fallback
// (scripts/linear-brain.js) is the branch a real session takes, and every
// other test here injects a stub, so nothing above proves that fallback is
// not a rubber stamp — the literal BRO-3471 hole the executor exists to
// close. Proven by mutation: replacing that fallback with a never-allow (or
// always-allow) function leaves every other test in this file green, and
// fails only this one. linear-brain.js destructures makeVerifyCmdEvidence at
// require time, so patching the linear-cmd-execution.js export BEFORE
// requiring linear-brain.js hands the CLI a spy — no clone, no fetch, no
// nested test run.
// Same fixture as runUpdate, except it injects NO verifyCmdEvidence dep and
// instead replaces linear-cmd-execution.js's factory export with a spy that
// returns `allowed`. That exercises the production default path end to end:
// the CLI builds its own verifier, hands it the recorded command, and — the
// half a spy that always passes can never prove — actually ACTS on what comes
// back (ship-check finding, Codex, 2026-09-21: with only an always-allow spy,
// a default path that called the verifier and then discarded its result kept
// every test in this file green).
function runWiringFixture(allowed) {
  const spyResult = allowed
    ? "{ allowed: true, verdict: 'own-verify-passed', reason: 'spy: passed', notOnMain: false, sha: 'spy0000000' }"
    : "{ allowed: false, verdict: 'own-verify-failed', reason: 'spy: failed', notOnMain: false, sha: 'spy0000000' }";
  const script = `
    const cmdExec = require('./scripts/lib/linear-cmd-execution.js');
    cmdExec.makeVerifyCmdEvidence = (opts) => {
      // The CLI must hand the factory a WORKING logger, or the operator never
      // sees the "[linear-cmd-execution] running ..." line while it blocks on
      // a real checkout (linear-brain.js passes a console.error logger).
      // Asserting typeof === 'function' is not enough: a CLI that passed a
      // no-op logger would satisfy that and print nothing (ship-check
      // finding, 2026-09-21 — mutation-proven, all 38 tests stayed green).
      // Call it and assert the line actually reaches stderr. NOTE: this
      // comment lives inside a template literal, so no backticks here.
      if (opts && typeof opts.log === 'function') opts.log('LOG_PROBE');
      return (cmd) => {
        console.error('REAL_FACTORY_CMD:' + cmd);
        return ${spyResult};
      };
    };
    const { main } = require('./scripts/linear-brain.js');
    const issue = ${JSON.stringify(makeIssue('## Acceptance criteria\n- `node --test tests/unit/done-semantics-gate.test.mjs` passes'))};
    main(['update', 'BRO-9457', '--state', 'Done'], {
      getIssue: async () => issue,
      getTeam: async () => ({ states: ${JSON.stringify(TEAM_STATES)} }),
      // Stubbed for the same reason runUpdate stubs it: unstubbed, the real
      // makeVerifyEvidence shells out to git remote get-url origin and a
      // shallow-repo read at build time, making this file git-state dependent
      // and breaking its own "no test ever shells out" promise (ship-check
      // finding, 2026-09-21). The subject here is the CMD executor seam.
      // (No backticks in this comment — it is inside a template literal.)
      verifyEvidence: () => ({ verified: null, reason: 'stub: unknown' }),
      appendBypassRow: () => {},
      updateIssue: async () => { console.error('UPDATE_ISSUE_CALLED'); },
      createComment: async () => {},
    });
  `;
  return spawnSync(process.execPath, ['-e', script], { cwd: REPO_ROOT, encoding: 'utf8', timeout: 15000 });
}

test('wiring: with NO verifyCmdEvidence dep, the CLI builds the executor from linear-cmd-execution.js and hands it the recorded command', () => {
  const res = runWiringFixture(true);
  assert.equal(res.status, 0, `expected exit 0, got ${res.status}. stderr:\n${res.stderr}`);
  assert.match(res.stderr, /LOG_PROBE/, 'the CLI must build its executor from linear-cmd-execution.js with a logger that actually reaches the operator');
  assert.match(res.stderr, /REAL_FACTORY_CMD:node --test tests\/unit\/done-semantics-gate\.test\.mjs/);
  assert.match(res.stderr, /UPDATE_ISSUE_CALLED/);
});

test('wiring: the default path REFUSES when the executor it built says the command failed', () => {
  const res = runWiringFixture(false);
  assert.equal(res.status, 5, `expected exit 5, got ${res.status}. stderr:\n${res.stderr}`);
  assert.match(res.stderr, /REAL_FACTORY_CMD:/, 'the verifier it built must still be consulted');
  assert.match(res.stderr, /REFUSED \(own-verify-failed\)/);
  assert.doesNotMatch(res.stderr, /UPDATE_ISSUE_CALLED/, 'a failing recorded command must block the write on the default path too');
});

test('allowed: a PR-EVIDENCE marker recording merged+deployed+checked', () => {
  const res = runUpdate({
    argv: ['update', 'BRO-9457', '--state', 'Done'],
    description: 'PR-EVIDENCE: merged deployed checked (https://github.com/thomaspryor/Broadwayscore/pull/999)',
    updateShouldBeCalled: true,
    verify: 'ok',
  });
  assert.equal(res.status, 0, `expected exit 0, got ${res.status}. stderr:\n${res.stderr}`);
  assert.match(res.stderr, /UPDATE_ISSUE_CALLED/);
  assert.doesNotMatch(res.stderr, /REFUSED/);
});

test('allowed: PR-EVIDENCE arrives via the --comment posted in the same call, not the description', () => {
  const res = runUpdate({
    argv: ['update', 'BRO-9457', '--state', 'Done', '--comment', 'PR-EVIDENCE: merged deployed checked'],
    description: 'Fixed the thing, looks good.',
    updateShouldBeCalled: true,
    verify: 'ok',
  });
  assert.equal(res.status, 0, `expected exit 0, got ${res.status}. stderr:\n${res.stderr}`);
  assert.match(res.stderr, /UPDATE_ISSUE_CALLED/);
  assert.match(res.stderr, /CREATE_COMMENT_CALLED/);
});

test('allowed: PR-EVIDENCE recorded in a PAST comment (no --comment on this call) — getIssue()\'s comments(first: 20) read must be consulted, not just description', () => {
  const res = runUpdate({
    argv: ['update', 'BRO-9457', '--state', 'Done'],
    description: 'Fixed the thing, looks good.',
    comments: ['Started work.', 'PR-EVIDENCE: merged deployed checked (https://github.com/thomaspryor/Broadwayscore/pull/1000)'],
    updateShouldBeCalled: true,
    verify: 'ok',
  });
  assert.equal(res.status, 0, `expected exit 0, got ${res.status}. stderr:\n${res.stderr}`);
  assert.match(res.stderr, /UPDATE_ISSUE_CALLED/);
  assert.doesNotMatch(res.stderr, /REFUSED/);
});

test('refused: a complete PR-EVIDENCE line whose commit is NOT on origin/main — the words alone no longer close an issue', () => {
  const res = runUpdate({
    argv: ['update', 'BRO-9457', '--state', 'Done'],
    description: 'PR-EVIDENCE: merged deployed checked (https://github.com/thomaspryor/Broadwayscore/commit/deadbeefcafe)',
    updateShouldBeCalled: false,
    verify: 'not-on-main',
  });
  assert.equal(res.status, 5, `expected exit 5, got ${res.status}. stderr:\n${res.stderr}`);
  assert.match(res.stderr, /REFUSED \(pr-evidence-not-on-main\)/);
  assert.match(res.stderr, /NOT on origin\/main/);
});

test('refused: a complete PR-EVIDENCE line that cannot be verified (shallow clone, gh down) fails CLOSED', () => {
  const res = runUpdate({
    argv: ['update', 'BRO-9457', '--state', 'Done'],
    description: 'PR-EVIDENCE: merged deployed checked (https://github.com/thomaspryor/Broadwayscore/pull/999)',
    updateShouldBeCalled: false,
    verify: 'unknown',
  });
  assert.equal(res.status, 5, `expected exit 5, got ${res.status}. stderr:\n${res.stderr}`);
  assert.match(res.stderr, /REFUSED \(pr-evidence-unverified\)/);
});

test('refused: a PR-EVIDENCE marker present but only partially true (not deployed)', () => {
  const res = runUpdate({
    argv: ['update', 'BRO-9457', '--state', 'Done'],
    description: 'PR-EVIDENCE: merged',
    updateShouldBeCalled: false,
  });
  assert.equal(res.status, 5, `expected exit 5, got ${res.status}. stderr:\n${res.stderr}`);
  assert.match(res.stderr, /not merged\+deployed\+checked/);
  assert.match(res.stderr, /deployed=false/);
});

test('not gated: moving to a non-completed state (In Progress) never consults the gate', () => {
  const res = runUpdate({
    argv: ['update', 'BRO-9457', '--state', 'In Progress'],
    description: 'Fixed the thing, looks good.',
    updateShouldBeCalled: true,
  });
  assert.equal(res.status, 0, `expected exit 0, got ${res.status}. stderr:\n${res.stderr}`);
  assert.match(res.stderr, /UPDATE_ISSUE_CALLED/);
});

test('--force with a reason ≥10 chars bypasses the gate', () => {
  const res = runUpdate({
    argv: ['update', 'BRO-9457', '--state', 'Done', '--force', 'owner said ship it now'],
    description: 'Fixed the thing, looks good.',
    updateShouldBeCalled: true,
  });
  assert.equal(res.status, 0, `expected exit 0, got ${res.status}. stderr:\n${res.stderr}`);
  assert.match(res.stderr, /UPDATE_ISSUE_CALLED/);
});

test('LINEAR_DONE_GATE_DISABLED=1 bypasses the gate for automation', () => {
  const script = `
    process.env.LINEAR_DONE_GATE_DISABLED = '1';
    const { main } = require('./scripts/linear-brain.js');
    const issue = ${JSON.stringify(makeIssue('Fixed the thing, looks good.'))};
    main(['update', 'BRO-9457', '--state', 'Done'], {
      getIssue: async () => issue,
      getTeam: async () => ({ states: ${JSON.stringify(TEAM_STATES)} }),
      appendBypassRow: () => {},
      updateIssue: async () => { console.error('UPDATE_ISSUE_CALLED'); },
      createComment: async () => {},
    });
  `;
  const res = spawnSync(process.execPath, ['-e', script], { cwd: REPO_ROOT, encoding: 'utf8', timeout: 15000 });
  assert.equal(res.status, 0, `expected exit 0, got ${res.status}. stderr:\n${res.stderr}`);
  assert.match(res.stderr, /UPDATE_ISSUE_CALLED/);
});
