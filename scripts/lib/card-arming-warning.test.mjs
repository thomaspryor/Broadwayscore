import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { armingWarning, KIND_HINTS } = require('./card-arming-warning.js');
// Rule 15: require the REAL validator the production path uses, so a change to
// SAFE_CHECK_FORMS breaks this test rather than drifting silently past it.
const verifyGate = require('./verify-gate.js');

const SAFE = '## Acceptance criteria\n\n`node --test tests/unit/thing.test.mjs`\n';
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
