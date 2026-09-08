import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { armingWarning, missingTestPaths, KIND_HINTS } = require('./card-arming-warning.js');
// Rule 15: require the REAL validator the production path uses, so a change to
// SAFE_CHECK_FORMS breaks this test rather than drifting silently past it.
const verifyGate = require('./verify-gate.js');

// Names a file that REALLY exists — since BRO-2789 the warning also probes
// existence, so a placeholder path here would (correctly) trip it.
const SAFE = '## Acceptance criteria\n\n`node --test scripts/lib/verify-gate.test.mjs`\n';
const OWNER = '## Acceptance criteria\n\nVERIFY: owner-judgment\n';
const PROSE = '## Acceptance criteria\n\nThe thing works properly.\n';
const NO_SECTION = 'Some prose about a bug, with no criteria at all.';
// The real BRO-3060 command, verbatim. A correct, runnable command that no
// safe form accepts — the exact shape that made that card un-closable.
const UNSAFE = '## Acceptance criteria\n\n`node scripts/linear-drain-parked.js --dry-run`\n';

test('an armed card produces no warning', () => {
  assert.equal(armingWarning(SAFE), null);
});

test('an explicit owner-judgment declaration counts as armed', () => {
  assert.equal(armingWarning(OWNER), null);
});

test('prose-only criteria warn', () => {
  const w = armingWarning(PROSE);
  assert.ok(w, 'expected a warning');
  assert.match(w, /cannot be closed as filed/);
  assert.ok(w.includes(KIND_HINTS['no-command']), 'names the no-command hint');
});

test('a card with no acceptance section at all warns', () => {
  const w = armingWarning(NO_SECTION);
  assert.ok(w, 'expected a warning');
  assert.ok(w.includes(KIND_HINTS['no-section']), 'names the no-section hint');
});

test('BRO-3060 regression: a real command that fails safe-form warns AND names the command', () => {
  // Guard the premise first — if this ever becomes safe-form, the test below
  // would pass vacuously for the wrong reason.
  assert.equal(
    verifyGate.isSafeCheckCommand('node scripts/linear-drain-parked.js --dry-run'),
    false,
    'premise: this command must still be rejected by safe-form'
  );
  const w = armingWarning(UNSAFE);
  assert.ok(w, 'expected a warning');
  assert.ok(w.includes(KIND_HINTS.shape), 'names the shape hint');
  assert.match(w, /node scripts\/linear-drain-parked\.js --dry-run/, 'quotes the offending command');
  assert.match(w, /Rejected as:\s+shape/, 'reports the diagnosis kind');
});

test('every kind evaluateVerifiability can return has a hint', () => {
  // Negative half: a new `kind` added to verify-gate.js without a hint here
  // would otherwise degrade silently to a generic message.
  const kinds = new Set();
  for (const notes of [PROSE, NO_SECTION, UNSAFE]) {
    const v = verifyGate.evaluateVerifiability(notes);
    if (!v.armed && !v.ownerJudgment) kinds.add(v.kind);
  }
  assert.deepEqual([...kinds].sort(), ['no-command', 'no-section', 'shape']);
  for (const k of kinds) {
    assert.ok(KIND_HINTS[k], `KIND_HINTS is missing an entry for kind '${k}'`);
  }
});

test('a missing validator module degrades to null, never to a thrown create', () => {
  assert.equal(armingWarning(PROSE, { verifyGate: { evaluateVerifiability() { throw new Error('boom'); } } }), null);
});

test('the warning never claims the card was rejected — creation is warn-only', () => {
  const w = armingWarning(PROSE);
  assert.match(w, /The card was still saved/);
});

// ── BRO-2789: shape-valid but the named file does not exist ──────────────
//
// The real acceptance command from BRO-2789, verbatim. It passes safe-form and
// so LOOKS armed, but tests/unit/cmux-swap-memory.test.mjs has never existed.
// `node --test <missing path>` exits 1 and runVerify() calls that 'fail', so a
// card armed this way goes permanently red on the nightly recheck once it is
// Done — measured, not assumed:
//   runVerify(cwd, 'node --test tests/unit/definitely-not-a-real-file.test.mjs')
//   -> {"status":"fail","detail":"Could not find '...'"}
const PHANTOM = '## Acceptance criteria\n\n`node --test tests/unit/cmux-swap-memory.test.mjs`\n';
const REAL = '## Acceptance criteria\n\n`node --test scripts/lib/card-arming-warning.test.mjs`\n';

test('BRO-2789 regression: a safe-form command naming a nonexistent test file warns', () => {
  // Premise guard: this must still be SHAPE-valid, or the test passes for the
  // wrong reason.
  assert.equal(verifyGate.isSafeCheckCommand('node --test tests/unit/cmux-swap-memory.test.mjs'), true);
  assert.equal(verifyGate.evaluateVerifiability(PHANTOM).armed, true, 'premise: shape check calls it armed');

  const w = armingWarning(PHANTOM);
  assert.ok(w, 'expected a warning despite the card reading as armed');
  assert.match(w, /NAMES A FILE THAT DOES NOT EXIST/);
  assert.match(w, /tests\/unit\/cmux-swap-memory\.test\.mjs/);
});

test('a command naming a test file that DOES exist stays silent', () => {
  assert.equal(armingWarning(REAL), null);
});

test('missingTestPaths only reports the paths that are actually absent', () => {
  const repoRoot = new URL('../..', import.meta.url).pathname;
  assert.deepEqual(
    missingTestPaths('node --test scripts/lib/card-arming-warning.test.mjs tests/unit/nope.test.mjs', repoRoot),
    ['tests/unit/nope.test.mjs']
  );
  assert.deepEqual(missingTestPaths('npx tsc --noEmit', repoRoot), [], 'a non-runner form names no paths');
  assert.deepEqual(missingTestPaths('node --test scripts/lib/card-arming-warning.test.mjs', repoRoot), []);
});

test('missingTestPaths never probes outside the repo via traversal', () => {
  const repoRoot = new URL('../..', import.meta.url).pathname;
  assert.deepEqual(missingTestPaths('node --test ../../../etc/passwd', repoRoot), []);
});

test('the tsx runner form is covered too, not just plain node', () => {
  const repoRoot = new URL('../..', import.meta.url).pathname;
  assert.deepEqual(missingTestPaths('npx tsx --test tests/unit/nope.test.ts', repoRoot), ['tests/unit/nope.test.ts']);
});

test('an owner-judgment declaration still short-circuits before the existence probe', () => {
  assert.equal(armingWarning(OWNER), null);
});
