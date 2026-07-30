import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { evaluateVerifiability } = require('./verify-gate.js');

test('accepts a backticked safe-form command in Acceptance criteria', () => {
  const notes = `## Problem
Something is broken.

## Acceptance criteria
- \`node --test tests/unit/review-guards.test.mjs\` passes`;
  const r = evaluateVerifiability(notes);
  assert.equal(r.armed, true);
  assert.equal(r.cmd, 'node --test tests/unit/review-guards.test.mjs');
  assert.equal(r.reason, null);
  assert.equal(r.ownerJudgment, false);
});

test('rejects prose-only acceptance criteria', () => {
  const notes = `## Acceptance criteria
- The owner agrees the email reads better.`;
  const r = evaluateVerifiability(notes);
  assert.equal(r.armed, false);
  assert.equal(r.cmd, null);
  assert.match(r.reason, /names no runnable command/);
  assert.equal(r.ownerJudgment, false);
});

test('accepts VERIFY: owner-judgment with no command needed', () => {
  const notes = `## Problem\nEmail Matt about cross-promo.\n\nVERIFY: owner-judgment`;
  const r = evaluateVerifiability(notes);
  assert.equal(r.armed, true);
  assert.equal(r.cmd, null);
  assert.equal(r.reason, null);
  assert.equal(r.ownerJudgment, true);
});

test('a card with no acceptance-criteria section or VERIFY line is unarmed', () => {
  const r = evaluateVerifiability('Just some notes about a thing.');
  assert.equal(r.armed, false);
  assert.equal(r.ownerJudgment, false);
  assert.match(r.reason, /no acceptance-criteria section/);
});

test('a mutating command is refused even inside Acceptance criteria', () => {
  const notes = '## Acceptance criteria\n- run `node scripts/rebuild-all-reviews.js` and check the diff';
  const r = evaluateVerifiability(notes);
  assert.equal(r.armed, false);
  assert.equal(r.cmd, null);
  assert.match(r.reason, /rebuild-all-reviews/);
});

test('a real command alongside VERIFY: owner-judgment is preserved, not dropped (ship-check finding)', () => {
  const notes = `## Acceptance criteria\n- \`npx tsc --noEmit\`\n\nVERIFY: owner-judgment`;
  const r = evaluateVerifiability(notes);
  assert.equal(r.armed, true);
  assert.equal(r.cmd, 'npx tsc --noEmit');
  assert.equal(r.reason, null);
  assert.equal(r.ownerJudgment, true);
});

test('empty/null notes are unarmed, not a crash', () => {
  assert.equal(evaluateVerifiability(null).armed, false);
  assert.equal(evaluateVerifiability(undefined).armed, false);
  assert.equal(evaluateVerifiability('').armed, false);
});
