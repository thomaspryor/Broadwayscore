import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { evaluateVerifiability } = require('./verify-gate.js');
const { sortedCommentBodies } = require('./linear-dispatch.js');
const { evaluateDoneTransition } = require('./done-semantics-gate.js');

test('dispatch and Done both refuse a retraction sorted from Linear comment order', () => {
  const issue = { description: 'VERIFY: npx tsc --noEmit', comments: { nodes: [
    { body: 'VERIFY: retracted', createdAt: '2026-10-11T19:34:00Z' },
    { body: 'VERIFY: node --test scripts/lib/verify-gate.test.mjs', createdAt: '2026-10-10T19:34:00Z' },
  ] } };
  const comments = sortedCommentBodies(issue);
  assert.equal(evaluateVerifiability(issue.description, comments).kind, 'retracted');
  const done = evaluateDoneTransition({ notes: issue.description, comments });
  assert.equal(done.allowed, false);
  assert.equal(done.cmd, null);
  assert.match(done.reason, /retracted/);
});

test('an explicit retraction refuses an older command and identifies its source', () => {
  const r = evaluateVerifiability('VERIFY: npx tsc --noEmit', [
    'VERIFY: node --test scripts/lib/verify-gate.test.mjs',
    'VERIFY: retracted',
    'Investigating a replacement.',
    'VERIFY: node scripts/rebuild-all-reviews.js',
  ]);
  assert.deepEqual(r, {
    armed: false, cmd: null, reason: 'VERIFY command explicitly retracted',
    ownerJudgment: false, kind: 'retracted', source: 'comment:1',
  });
});

test('a newer safe command or owner judgment can supersede a retraction', () => {
  for (const replacement of ['VERIFY: npx tsc --noEmit', 'VERIFY: owner-judgment']) {
    const r = evaluateVerifiability('VERIFY: retracted', ['VERIFY: retracted', replacement]);
    assert.equal(r.armed, true);
    assert.equal(r.source, 'comment:1');
  }
});

test('retraction wins over commands and owner judgment in the same document', () => {
  const r = evaluateVerifiability('VERIFY: owner-judgment\nVERIFY: npx tsc --noEmit\nVERIFY: retracted');
  assert.equal(r.armed, false);
  assert.equal(r.cmd, null);
  assert.equal(r.ownerJudgment, false);
  assert.equal(r.kind, 'retracted');
  assert.equal(r.source, 'description');
});

test('retraction is a standalone case-insensitive marker with optional horizontal whitespace', () => {
  for (const marker of ['VERIFY: retracted', '\tverify:  RETRACTED\t', 'Reason for stopping.\r\nVERIFY: retracted\r\n']) {
    const r = evaluateVerifiability('VERIFY: npx tsc --noEmit', [marker]);
    assert.equal(r.armed, false, marker);
    assert.equal(r.kind, 'retracted');
  }
});

test('discussing a retraction marker or splitting it across lines does not revoke', () => {
  for (const text of [
    'Use VERIFY: retracted to revoke a command.',
    '`VERIFY: retracted`',
    'VERIFY: retracted-command',
    'VERIFY: retracted later',
    'VERIFY:\nretracted',
  ]) {
    const r = evaluateVerifiability('VERIFY: npx tsc --noEmit', [text]);
    assert.equal(r.armed, true, text);
    assert.equal(r.source, 'description');
  }
});

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

// BRO-2585: the card-writing convention is `VERIFY: <cmd>` with no
// backticks — the dispatch seed template documents exactly this shape — and
// the gate used to refuse it outright.
test('a VERIFY: <cmd> line with no backticks arms the gate', () => {
  const r = evaluateVerifiability('## Problem\nSomething is broken.\n\nVERIFY: node --test scripts/lib/verify-gate.test.mjs');
  assert.equal(r.armed, true);
  assert.equal(r.cmd, 'node --test scripts/lib/verify-gate.test.mjs');
  assert.equal(r.reason, null);
});

// BRO-2585 repro: an incidental backticked non-command word earlier in the
// acceptance prose must not become "the candidate" and mask a real,
// un-backticked VERIFY: command later in the section.
test('an incidental backticked non-command earlier in the section does not prevent a real command later in it from being found', () => {
  const notes = `## Acceptance criteria
A regression test proving a workspace that is still running is never classified \`dead\` by that path, plus a count of how many historical \`dead\` rows are contradicted by a later session report.

VERIFY: node --test scripts/lib/dispatch-guards.test.mjs`;
  const r = evaluateVerifiability(notes);
  assert.equal(r.armed, true);
  assert.equal(r.cmd, 'node --test scripts/lib/dispatch-guards.test.mjs');
  assert.equal(r.reason, null);
});

test('empty/null notes are unarmed, not a crash', () => {
  assert.equal(evaluateVerifiability(null).armed, false);
  assert.equal(evaluateVerifiability(undefined).armed, false);
  assert.equal(evaluateVerifiability('').armed, false);
});
