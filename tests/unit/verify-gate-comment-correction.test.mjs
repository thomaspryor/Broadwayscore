import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { evaluateVerifiability } = require('../../scripts/lib/verify-gate.js');

// BRO-2796: the ONLY way to correct a Linear card's broken/wrong VERIFY
// command after dispatch is a comment (linear-brain.js's `update` command
// cannot edit a description), but the gate used to read the description
// alone — every such correction was silently inert. These assert the gate
// now sees comments, and that a correction posted AFTER creation supersedes
// the original without re-filing the card.

test('a broken VERIFY command in the description is corrected by a later comment', () => {
  const description = `## Acceptance criteria
VERIFY: test -f scripts/data-health-check.sh`; // BRO-2370: this path never existed
  const comments = [
    'Investigating.',
    'That path never existed.\nVERIFY: `node --test tests/unit/data-health-check.test.mjs`',
  ];
  const r = evaluateVerifiability(description, comments);
  assert.equal(r.armed, true);
  assert.equal(r.cmd, 'node --test tests/unit/data-health-check.test.mjs');
  assert.equal(r.reason, null);
});

test('a mutating/unsafe command in the description is still refused when no comment corrects it', () => {
  const description = '## Acceptance criteria\nVERIFY: node scripts/rebuild-all-reviews.js';
  const comments = ['Looking into this.'];
  const r = evaluateVerifiability(description, comments);
  assert.equal(r.armed, false);
  assert.equal(r.cmd, null);
});

test('the LAST well-formed VERIFY line wins when multiple comments correct it in sequence', () => {
  const description = '## Acceptance criteria\nVERIFY: not-a-real-command --flag';
  const comments = [
    'VERIFY: `node --test tests/unit/first-attempt.test.mjs`',
    'Actually wrong path, use this one instead.\nVERIFY: `node --test tests/unit/second-attempt.test.mjs`',
  ];
  const r = evaluateVerifiability(description, comments);
  assert.equal(r.armed, true);
  assert.equal(r.cmd, 'node --test tests/unit/second-attempt.test.mjs');
});

test('a later comment that fails safe-form validation does not erase an earlier good correction', () => {
  const description = '## Acceptance criteria\nVERIFY: broken original';
  const comments = [
    'VERIFY: `node --test tests/unit/good-correction.test.mjs`',
    'VERIFY: node scripts/rebuild-all-reviews.js', // a later, worse "correction"
  ];
  const r = evaluateVerifiability(description, comments);
  assert.equal(r.armed, true);
  assert.equal(r.cmd, 'node --test tests/unit/good-correction.test.mjs');
});

test('an owner-judgment marker posted as a comment arms a card whose description names no command', () => {
  const description = '## Problem\nEmail Matt about cross-promo.';
  const comments = ['VERIFY: owner-judgment'];
  const r = evaluateVerifiability(description, comments);
  assert.equal(r.armed, true);
  assert.equal(r.cmd, null);
  assert.equal(r.ownerJudgment, true);
});

test('with no comments, behaves exactly as the single-arg form (backward compatible)', () => {
  const description = '## Acceptance criteria\n- `npx tsc --noEmit`';
  const withComments = evaluateVerifiability(description, []);
  const withoutComments = evaluateVerifiability(description);
  assert.deepEqual(withComments, withoutComments);
  assert.equal(withComments.armed, true);
  assert.equal(withComments.cmd, 'npx tsc --noEmit');
});

test('a working description command survives an unrelated, non-VERIFY comment', () => {
  const description = '## Acceptance criteria\n- `npx tsc --noEmit`';
  const comments = ['LGTM, dispatching now.'];
  const r = evaluateVerifiability(description, comments);
  assert.equal(r.armed, true);
  assert.equal(r.cmd, 'npx tsc --noEmit');
});
