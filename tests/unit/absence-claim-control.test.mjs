// Repo-side coverage for finish-line-gate's Gate 7 absence-claim guard
// (BRO-4137, BRO-4374).
//
// The predicate lives in ~/.claude/hooks/lib/absence-claim-control.js and the
// gate shells out to it, so there is exactly one copy of the phrase list
// (CLAUDE.md rule 15). This file require()s that real module, never a copy,
// and gives the card a safe-form acceptance command (`node --test` is the only
// shape the done-gate's allowlist accepts).
//
// ~/.claude is a separate repo that is not checked out on CI runners. When it
// is absent this SKIPS LOUDLY rather than passing green (same contract as
// board-gate-failopen.test.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';

const LIB = path.join(homedir(), '.claude/hooks/lib/absence-claim-control.js');
const require = createRequire(import.meta.url);

function loadLib(t) {
  if (!existsSync(LIB)) {
    console.warn(`SKIP: ${LIB} not present (expected on CI — ~/.claude is a separate repo)`);
    t.skip('hook lib not present on this machine');
    return null;
  }
  return require(LIB);
}

const CLAIM = 'Checked test.yml: the audit runs in no workflow, so it never runs.';
const CONTROL = 'CONTROL: grep -c "audit-show-score-urls" check-corpus-drift.js -> 2 (the same grep finds a known wiring)';

test('absence claim with no positive control is BLOCKED', (t) => {
  const lib = loadLib(t);
  if (!lib) return;
  const v = lib.checkAbsenceClaimGate(CLAIM);
  assert.equal(v.blocked, true);
  assert.ok(v.claims.length >= 1);
});

test('the same claim citing a control command PASSES', (t) => {
  const lib = loadLib(t);
  if (!lib) return;
  const v = lib.checkAbsenceClaimGate(`${CLAIM}\n${CONTROL}`);
  assert.equal(v.blocked, false);
  assert.equal(v.bypassKind, 'control');
});

test('a message with no absence language is unaffected', (t) => {
  const lib = loadLib(t);
  if (!lib) return;
  const v = lib.checkAbsenceClaimGate('Shipped the fix; 14/14 tests pass and the deploy is live.');
  assert.deepEqual(v, { blocked: false, claims: [], reason: null, bypassKind: null });
});

// End to end through the real hook. BRO-4374 specimen: Gate 7 blocked a
// wrap-up block because a line quoted BRO-4137's own 195-char title
// ("...search returned nothing..."). The gate strips quoted spans before
// calling the lib (hooks/lib/transcript.py), and that stripper capped spans at
// 160 chars, so the title leaked through; titles next to a ref now strip at
// any length (transcript.py _TITLED_REF_SPAN_RE). The g7-long-* / g3-long-* fixtures
// pin both directions: a long quoted title passes, an unquoted claim on the
// same line still blocks.
test('finish-line-gate fixture suite passes, including the long-quoted-title fixtures', (t) => {
  const suite = path.join(homedir(), '.claude/hooks/tests/finish-line-gate/run.sh');
  if (!existsSync(suite)) {
    console.warn(`SKIP: ${suite} not present (expected on CI)`);
    t.skip('hook suite not present on this machine');
    return;
  }
  let out;
  try {
    out = execFileSync('bash', [suite], { encoding: 'utf8', timeout: 300_000 });
  } catch (err) {
    assert.fail(`finish-line-gate suite failed:\n${err.stdout || ''}${err.stderr || ''}`);
  }
  assert.match(out, /\d+ passed, 0 failed/, `suite did not report a clean run:\n${out}`);
  for (const name of [
    'g7-long-quoted-title-passes (exit=0)',
    'g7-long-quoted-title-plus-unquoted-claim-blocks (exit=2)',
    'g3-long-quoted-title-passes (exit=0)',
    // Only titles next to a card/workspace ref strip at any length; a long
    // quoted conclusion or a claim between inch marks must still block.
    'g7-long-quoted-conclusion-blocks (exit=2)',
    'g7-claim-between-inch-marks-blocks (exit=2)',
    'g7-absence-claim-no-control-blocks (exit=2)',
    'g7-absence-claim-with-control-passes (exit=0)',
  ]) {
    assert.ok(out.includes(`PASS ${name}`), `fixture did not run and pass: ${name}`);
  }
});

// Mutation check: gutting the phrase list must make the BLOCKED assertion fail,
// otherwise these tests would pass against a gate that catches nothing.
test('emptying ABSENCE_PATTERNS disables blocking (the tests above would fail)', (t) => {
  if (!existsSync(LIB)) {
    console.warn(`SKIP: ${LIB} not present`);
    t.skip('hook lib not present on this machine');
    return;
  }
  const src = readFileSync(LIB, 'utf8');
  const gutted = src.replace(/const ABSENCE_PATTERNS = \[[\s\S]*?\n\];/, 'const ABSENCE_PATTERNS = [];');
  assert.notEqual(gutted, src, 'could not locate ABSENCE_PATTERNS to mutate');
  const dir = mkdtempSync(path.join(tmpdir(), 'absence-mut-'));
  try {
    const mutPath = path.join(dir, 'absence-claim-control.js');
    writeFileSync(mutPath, gutted);
    const mut = require(mutPath);
    assert.equal(mut.checkAbsenceClaimGate(CLAIM).blocked, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
