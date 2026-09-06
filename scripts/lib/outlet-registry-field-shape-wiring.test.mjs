/**
 * Wiring tests for the outlet-registry field-shape contract.
 *
 * outlet-registry-field-shape.test.mjs owns the RULE (which values are valid).
 * This file owns the WIRING — that the rule is actually reachable from the two
 * places the 2026-09-06 incident proved it needed to be, and that nothing
 * re-derives it locally:
 *
 *   1. audit-outlet-registry.js --strict, the gate an operator runs WHILE
 *      registering an outlet. It had no field check at all, so registering
 *      `arbuturian` with starScale:null returned exit 0 there and then failed
 *      validate-data.js at an earlier step of the same CI job.
 *   2. audit-outlet-star-scales.js --apply, which WRITES starScale and could
 *      previously emit any dominant denominator (detectDenominator accepts any
 *      0 < denom <= 100), including values both gates now reject.
 *
 * These are structural assertions on purpose. The regression they guard is
 * "someone deletes the import or the check", which a behavioural test against
 * the live registry cannot see while the live registry happens to be clean.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { ALLOWED_STAR_SCALES, outletFieldShapeErrors } = require('./outlet-registry-field-shape.js');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS = path.join(HERE, '..');

test('ALLOWED_STAR_SCALES is pinned — widening it silently relaxes two gates AND a writer', () => {
  assert.deepEqual([...ALLOWED_STAR_SCALES].sort((a, b) => a - b), [4, 5, 10, 100]);
});

test('the registration gate imports the shared rule and does not re-derive one', () => {
  const src = fs.readFileSync(path.join(SCRIPTS, 'audit-outlet-registry.js'), 'utf8');
  assert.match(src, /require\(['"]\.\/lib\/outlet-registry-field-shape['"]\)/,
    'audit-outlet-registry.js must import the shared field-shape rule');
  assert.match(src, /outletFieldShapeErrors\(/,
    'audit-outlet-registry.js must call the shared rule');
  // Catch re-derivation in ANY spelling, not just the one literal the module
  // happens to use: `new Set([4,5,10,100])`, `[4,5,10,100].includes(x)`, a
  // reordered set, or a set with an extra member all count. Matching only the
  // exact literal would have let every one of those through, so the guard did
  // not prevent the drift it names (code-review 2026-09-06). The test is
  // simply "these four magic numbers do not appear together in this file".
  const digitRuns = (src.match(/\b(?:4|5|10|100)\b/g) || []);
  const hasAllFour = ['4', '5', '10', '100'].every(n => digitRuns.includes(n));
  assert.equal(hasAllFour, false,
    'audit-outlet-registry.js appears to re-declare the allowed star scales locally — import ALLOWED_STAR_SCALES instead');
});

test('an invalid field is part of the registration gate --strict FAILURE set, not just printed', () => {
  // Printing a problem while still exiting 0 is the exact shape of the bug:
  // the gate "ran" and reported nothing actionable. Pin that badRegistryFields
  // participates in strictFail.
  const src = fs.readFileSync(path.join(SCRIPTS, 'audit-outlet-registry.js'), 'utf8');
  // Slice from `const strictFail =` to the start of the next statement rather
  // than lazily to the first `;`. The old form broke on a comment containing a
  // semicolon inside the expression, or on the composition growing past an
  // arbitrary 400-char cap — failing for a formatting change rather than a
  // behavioural one (code-review 2026-09-06).
  const start = src.indexOf('const strictFail =');
  assert.notEqual(start, -1, 'could not locate the strictFail composition');
  const rest = src.slice(start);
  const end = rest.search(/;\s*\n/);
  assert.notEqual(end, -1, 'could not find the end of the strictFail composition');
  const strictFail = rest.slice(0, end);
  assert.match(strictFail, /badRegistryFields\.length > 0/,
    'invalid registry fields must make --strict exit non-zero');
});

test('the starScale writer refuses to write a denominator outside the allow-list', () => {
  const src = fs.readFileSync(path.join(SCRIPTS, 'audit-outlet-star-scales.js'), 'utf8');
  assert.match(src, /require\(['"]\.\/lib\/outlet-registry-field-shape['"]\)/,
    'audit-outlet-star-scales.js must import the shared allow-list');
  assert.match(src, /ALLOWED_STAR_SCALES\.has\(/,
    'audit-outlet-star-scales.js must gate its registry write on ALLOWED_STAR_SCALES');
});

test('the shared rule still rejects the exact value that put main red, via this import path', () => {
  // Cheap end-to-end sanity that the module this wiring points at is the one
  // carrying the contract — not a same-named stub.
  const errors = outletFieldShapeErrors('arbuturian', { starScale: null });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /starScale=null is invalid/);
  assert.deepEqual(outletFieldShapeErrors('arbuturian', {}), []);
});

// NOTE — deliberately NO assertion here against the live data/outlet-registry.json.
//
// An earlier draft of this file scanned the real registry. That put a DATA
// failure into a CODE-test job: a bad entry arriving via a data-repo or bot
// commit would have reddened Unit Tests, on top of the two gates that already
// cover it in Data Validation (validate-data.js at step 21 and
// audit-outlet-registry.js --strict at step 43). The repo deliberately moved
// corpus audits out of test.yml for exactly that reason, and duplicating the
// coverage here buys nothing while making an unrelated job's red misleading
// (code-review 2026-09-06). The tests above are pure and carry the regression
// value on their own.
