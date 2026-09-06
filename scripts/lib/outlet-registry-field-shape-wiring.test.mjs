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
  assert.doesNotMatch(src, /new Set\(\[\s*4\s*,\s*5\s*,\s*10\s*,\s*100\s*\]\)/,
    'audit-outlet-registry.js must not re-declare the allowed-scale set locally');
});

test('an invalid field is part of the registration gate --strict FAILURE set, not just printed', () => {
  // Printing a problem while still exiting 0 is the exact shape of the bug:
  // the gate "ran" and reported nothing actionable. Pin that badRegistryFields
  // participates in strictFail.
  const src = fs.readFileSync(path.join(SCRIPTS, 'audit-outlet-registry.js'), 'utf8');
  const strictFail = src.match(/const strictFail =[\s\S]{0,400}?;/);
  assert.ok(strictFail, 'could not locate the strictFail composition');
  assert.match(strictFail[0], /badRegistryFields\.length > 0/,
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

test('the live registry passes the rule through the registration gate\'s own sweep', (t) => {
  const registryPath = path.join(SCRIPTS, '..', 'data', 'outlet-registry.json');
  if (!fs.existsSync(registryPath)) {
    // Loud skip, never a vacuous pass — this file is gitignored core data and
    // is absent in a bare worktree.
    t.skip(`SKIPPED — ${registryPath} absent (gitignored core data not present here)`);
    return;
  }
  const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  const outlets = registry.outlets || registry;
  assert.ok(Object.keys(outlets).length > 100, 'expected a real registry');
  const errors = [];
  for (const [id, entry] of Object.entries(outlets)) {
    if (id === '_aliasIndex' || id === '_meta') continue;
    errors.push(...outletFieldShapeErrors(id, entry));
  }
  assert.deepEqual(errors, [], 'live outlet-registry.json violates the field-shape contract');
});
