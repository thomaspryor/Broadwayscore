import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { armingWarning, fabricatedPathReason, KIND_HINTS } = require('./card-arming-warning.js');
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
  // The command is quoted via verdict.reason, which verify-gate built from the
  // correctly SECTIONED candidates. It is deliberately NOT re-derived here —
  // see the note in card-arming-warning.js's armingWarning().
  assert.match(w, /node scripts\/linear-drain-parked\.js --dry-run/, 'quotes the offending command');
});

test('EVERY kind verify-gate documents has a hint — derived, not restated', () => {
  // The previous version of this test built its expected set from three
  // hand-picked fixtures and asserted deepEqual against those same three. It
  // passed while 4 of the 7 real kinds had no hint at all, which is the
  // definition of a vacuous test (ship-check finding). The list now comes from
  // verify-gate.js's own header comment, so adding an 8th kind there breaks
  // this until a hint exists for it.
  const src = readFileSync(new URL('./verify-gate.js', import.meta.url), 'utf8');
  const m = src.match(/machine-readable refusal cause([\s\S]*?)also null whenever armed/);
  assert.ok(m, 'could not read the documented kind list out of verify-gate.js — update this test if that comment moved');
  const documented = [...m[1].matchAll(/'([a-z-]+)'/g)].map((x) => x[1]);
  assert.ok(documented.length >= 7, `expected >= 7 documented kinds, parsed ${documented.length}: ${documented}`);
  for (const k of documented) {
    assert.ok(KIND_HINTS[k], `KIND_HINTS is missing an entry for kind '${k}'`);
  }
});

test('the two kinds that had no hint before now explain themselves', () => {
  // path-prefix and traversal both warned with a bare generic message.
  const outside = '## Acceptance criteria\n\n`test -f data/shows.json`\n';
  const traversal = '## Acceptance criteria\n\n`node --test tests/../../etc/x.test.mjs`\n';
  const wo = armingWarning(outside);
  assert.ok(wo && wo.includes(KIND_HINTS['path-prefix']), 'path-prefix must carry its hint');
  const wt = armingWarning(traversal);
  assert.ok(wt && wt.includes(KIND_HINTS.traversal), 'traversal must carry its hint');
});

test('the warning never names a command from OUTSIDE the acceptance section', () => {
  // Regression for the mislabel: candidatesFrom() is a raw backtick scanner
  // over the whole note, so re-deriving the offender here reported a command
  // quoted in "## Problem". verdict.reason names the correctly sectioned one.
  const twoSpans = [
    '## Problem',
    '',
    'The gate runs `npx tsc --noEmit` today, which is not the issue.',
    '',
    '## Acceptance criteria',
    '',
    '`node scripts/linear-drain-parked.js --dry-run`',
    '',
  ].join('\n');
  const w = armingWarning(twoSpans);
  assert.ok(w, 'expected a warning');
  assert.ok(
    w.includes('node scripts/linear-drain-parked.js --dry-run'),
    'must name the acceptance-section command'
  );
  assert.ok(
    !/The command it found:\s+npx tsc/.test(w),
    'must NOT present the ## Problem command as the offender'
  );
});

test('a missing validator module degrades to null, never to a thrown create', () => {
  assert.equal(armingWarning(PROSE, { verifyGate: { evaluateVerifiability() { throw new Error('boom'); } } }), null);
});

test('the warning never claims the card was rejected — creation is warn-only', () => {
  const w = armingWarning(PROSE);
  assert.match(w, /The card was still saved/);
});

// ── BRO-2789 / ship-check: shape-valid but the LOCATION is fabricated ────
//
// The existence probe delegates to autonomous-triage-core.js's
// resolveCheckPaths(), which encodes the NEW-ARTIFACT ALLOWANCE (card #529):
// a missing file in a REAL directory is a to-be-created test and is correct.
// Only a fabricated DIRECTORY, or a path naming a directory rather than a
// file, is a defect. An earlier version of this file warned on every missing
// path and would have re-broken the 3 cards card #529 was written to unbreak.
const FABRICATED = '## Acceptance criteria\n\n`node --test tests/nosuchdir/nope.test.mjs`\n';
const NEW_ARTIFACT = '## Acceptance criteria\n\n`node --test tests/unit/not-written-yet.test.mjs`\n';
const NAMES_A_DIR = '## Acceptance criteria\n\n`test -f scripts/lib`\n';
const REAL = '## Acceptance criteria\n\n`node --test scripts/lib/card-arming-warning.test.mjs`\n';

test('a fabricated directory warns', () => {
  // Premise guard: it must still be SHAPE-valid, or this passes for the wrong reason.
  assert.equal(verifyGate.evaluateVerifiability(FABRICATED).armed, true, 'premise: shape check calls it armed');
  const w = armingWarning(FABRICATED);
  assert.ok(w, 'expected a warning');
  assert.match(w, /NAMES A LOCATION THAT DOES NOT EXIST/);
  assert.match(w, /tests\/nosuchdir/);
});

test('NEW-ARTIFACT ALLOWANCE: a not-yet-written test in a REAL directory stays silent', () => {
  // This is the case card #529 exists to protect. Warning here would re-break it.
  assert.equal(verifyGate.evaluateVerifiability(NEW_ARTIFACT).armed, true);
  assert.equal(armingWarning(NEW_ARTIFACT), null);
});

test('a command naming a DIRECTORY rather than a file warns', () => {
  const w = armingWarning(NAMES_A_DIR);
  assert.ok(w, 'expected a warning — `test -f <dir>` can never pass');
  assert.match(w, /directory/i);
});

test('a command naming a test file that DOES exist stays silent', () => {
  assert.equal(armingWarning(REAL), null);
});

test('fabricatedPathReason is silent for the non-path forms', () => {
  const root = new URL('../..', import.meta.url).pathname;
  assert.equal(fabricatedPathReason('npx tsc --noEmit', root), null);
  assert.equal(fabricatedPathReason('npx next lint', root), null);
});

test('the probe fails OPEN when the canonical resolver is unavailable', () => {
  // Never block or mislabel a card because our own tooling is missing.
  const root = new URL('../..', import.meta.url).pathname;
  assert.equal(
    fabricatedPathReason('node --test tests/nosuchdir/x.test.mjs', root, {
      triageCore: { resolveCheckPaths() { throw new Error('boom'); } },
    }),
    null
  );
});

test('an owner-judgment declaration short-circuits before the path probe', () => {
  assert.equal(armingWarning(OWNER), null);
});
