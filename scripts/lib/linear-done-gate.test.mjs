/**
 * linear-done-gate.test.mjs — BRO-3885 acceptance.
 *
 * The Linear Done gate (checkLinearDoneTransition) inherited
 * done-semantics-gate.js's VERIFY_CMD_RECORDED verdict, which only checks a
 * command's SHAPE (evaluateVerifiability/isSafeCheckCommand never run
 * anything) — the Notion→Linear migration dropped the execution half
 * (scripts/lib/close-time-verify.js) that Notion's `update --status Done`
 * still gets. BRO-3471 closed Done twice on a VERIFY: command naming a test
 * file that had never been created.
 *
 * These tests require() the real checkLinearDoneTransition and compose the
 * REAL runVerify (acceptance-check-core.js) + decideClose (close-time-verify.js)
 * — the exact functions notion-brain.js's close-time check uses — pointed at
 * a plain tmp directory instead of a real origin/main checkout, the same
 * substitution acceptance-check-core.test.mjs itself makes ("cwd - the fresh
 * checkout (or any directory, for tests)"). No stubbed verdicts: a real
 * missing-file command really returns 'unverifiable', a real passing test
 * file really returns 'pass', through the unmodified production functions.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { checkLinearDoneTransition } = require(path.join(REPO, 'scripts/lib/linear-done-gate.js'));
const { runVerify } = require(path.join(REPO, 'scripts/lib/acceptance-check-core.js'));
const { decideClose, VERDICTS: CLOSE_VERDICTS } = require(path.join(REPO, 'scripts/lib/close-time-verify.js'));
const { VERDICTS: DONE_VERDICTS } = require(path.join(REPO, 'scripts/lib/done-semantics-gate.js'));

function tmpCheckout() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'linear-done-gate-test-'));
}

/** Real composition of runVerify + decideClose, exactly what
 * linear-cmd-execution.js's makeVerifyCmdEvidence() does, minus the git
 * checkout (cwd is handed in directly, same substitution runVerify's own
 * tests use). */
function realVerifyCmdEvidence(cwd) {
  return function verifyCmdEvidence(cmd) {
    const verifyResult = runVerify(cwd, cmd, { attempts: 1 });
    const dispatch = { verifyCmd: cmd, allowUnverifiable: false, verifyReason: null, taskId: null, matchedBy: null, entry: { source: 'test' } };
    const decision = decideClose({ dispatch, verifyResult });
    return { allowed: decision.verdict === CLOSE_VERDICTS.PASS, verdict: decision.verdict, reason: decision.message };
  };
}

test('BRO-3885: a VERIFY command naming a NONEXISTENT path is REFUSED, not trusted on shape', () => {
  const cwd = tmpCheckout();
  try {
    const gate = checkLinearDoneTransition({
      targetStateType: 'completed',
      description: 'VERIFY: node --test scripts/lib/does-not-exist-bro-3885.test.mjs',
      verifyCmdEvidence: realVerifyCmdEvidence(cwd),
    });
    assert.equal(gate.gated, true);
    assert.equal(gate.allowed, false);
    assert.match(gate.reason, /does-not-exist-bro-3885\.test\.mjs/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('BRO-3885: a VERIFY command that actually PASSES is allowed', () => {
  const cwd = tmpCheckout();
  try {
    fs.mkdirSync(path.join(cwd, 'tests/unit'), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, 'tests/unit/ok.test.mjs'),
      "import test from 'node:test';\ntest('ok', () => {});\n",
    );
    const gate = checkLinearDoneTransition({
      targetStateType: 'completed',
      description: 'VERIFY: node --test tests/unit/ok.test.mjs',
      verifyCmdEvidence: realVerifyCmdEvidence(cwd),
    });
    assert.equal(gate.gated, true);
    assert.equal(gate.allowed, true);
    assert.equal(gate.verdict, DONE_VERDICTS.VERIFY_CMD_RECORDED);
    // The proof this was actually EXECUTED, not just shape-checked.
    assert.equal(gate.cmdExecution.verdict, CLOSE_VERDICTS.PASS);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('BRO-3885: a VERIFY command that FAILS is refused (not just missing paths)', () => {
  const cwd = tmpCheckout();
  try {
    fs.mkdirSync(path.join(cwd, 'tests/unit'), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, 'tests/unit/broken.test.mjs'),
      "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('broken', () => { assert.equal(1, 2); });\n",
    );
    const gate = checkLinearDoneTransition({
      targetStateType: 'completed',
      description: 'VERIFY: node --test tests/unit/broken.test.mjs',
      verifyCmdEvidence: realVerifyCmdEvidence(cwd),
    });
    assert.equal(gate.allowed, false);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

// The regression guard: if applyCmdExecution's call to verifyCmdEvidence is
// ever removed from checkLinearDoneTransition, a safe-shaped VERIFY command
// goes straight back to being trusted on shape alone (the old BRO-3471 hole)
// and this passes NO verifyCmdEvidence at all — so a caller that dropped the
// execution wiring would have this same shape and would need to be refused
// here exactly like a caller that forgot to build the real executor.
test('BRO-3885: with NO execution verifier wired in, a shape-only VERIFY command is refused, not trusted', () => {
  const gate = checkLinearDoneTransition({
    targetStateType: 'completed',
    description: 'VERIFY: node --test scripts/lib/some-real-looking-path.test.mjs',
    // verifyCmdEvidence deliberately omitted.
  });
  assert.equal(gate.gated, true);
  assert.equal(gate.allowed, false, 'a recorded command must never be treated as done-evidence without actually being run');
  assert.equal(gate.verdict, 'verify-cmd-unexecuted');
});

test('BRO-3885: PR-EVIDENCE path is untouched — a fully verified PR claim needs no cmd execution at all', () => {
  const gate = checkLinearDoneTransition({
    targetStateType: 'completed',
    description: 'PR-EVIDENCE: merged deployed checked (https://github.com/thomaspryor/Broadwayscore/commit/abcdef12345)',
    verifyEvidence: () => ({ verified: true, reason: 'commit is on origin/main', checked: [] }),
    // No verifyCmdEvidence — must not be needed on this path.
  });
  assert.equal(gate.gated, true);
  assert.equal(gate.allowed, true);
  assert.equal(gate.verdict, DONE_VERDICTS.PR_MERGED_DEPLOYED_CHECKED);
});

test('BRO-3885: no evidence at all is still refused (unchanged baseline)', () => {
  const gate = checkLinearDoneTransition({
    targetStateType: 'completed',
    description: 'just some prose with no acceptance criteria',
  });
  assert.equal(gate.gated, true);
  assert.equal(gate.allowed, false);
  assert.equal(gate.verdict, DONE_VERDICTS.BLOCKED_NO_EVIDENCE);
});
