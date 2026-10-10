import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  isIncrementalSize, classifyLCardOutcome, nightNumberFor, buildResumeNote, buildFirstNightNote, buildCheckpointNote,
} = require('./autonomous-checkpoint.js');

test('only size L is incremental', () => {
  assert.equal(isIncrementalSize('L'), true);
  assert.equal(isIncrementalSize('S'), false);
  assert.equal(isIncrementalSize('M'), false);
  assert.equal(isIncrementalSize(undefined), false);
});

test('classifyLCardOutcome: all checks pass → done', () => {
  assert.equal(classifyLCardOutcome([
    { name: 'colocated-tests', pass: true },
    { name: 'card-check (node --test x.test.mjs)', pass: true },
  ]), 'done');
});

test('classifyLCardOutcome: only the card-check fails → checkpoint (safe, incomplete)', () => {
  assert.equal(classifyLCardOutcome([
    { name: 'colocated-tests', pass: true },
    { name: 'tsc', pass: true },
    { name: 'card-check (node --test x.test.mjs)', pass: false, detail: 'not done yet' },
  ]), 'checkpoint');
});

test('classifyLCardOutcome: a non-card-check failure is a genuine failure, even alongside a card-check failure', () => {
  assert.equal(classifyLCardOutcome([
    { name: 'colocated-tests', pass: false, detail: 'broke an existing test' },
  ]), 'failed');
  assert.equal(classifyLCardOutcome([
    { name: 'colocated-tests', pass: false },
    { name: 'card-check (node --test x.test.mjs)', pass: false },
  ]), 'failed');
});

test('classifyLCardOutcome: no checks at all is treated as broken, not incomplete', () => {
  assert.equal(classifyLCardOutcome([]), 'failed');
  assert.equal(classifyLCardOutcome(null), 'failed');
});

test('classifyLCardOutcome: no checkableDone + all other checks pass → checkpoint, not done (ship-check fix)', () => {
  const checks = [{ name: 'colocated-tests', pass: true }, { name: 'tsc', pass: true }];
  assert.equal(classifyLCardOutcome(checks), 'done'); // default hasCheckableDone:true preserves old behavior
  assert.equal(classifyLCardOutcome(checks, { hasCheckableDone: true }), 'done');
  assert.equal(classifyLCardOutcome(checks, { hasCheckableDone: false }), 'checkpoint');
});

test('classifyLCardOutcome: hasCheckableDone:false has no effect when checks actually failed', () => {
  const checks = [{ name: 'colocated-tests', pass: false, detail: 'broke a test' }];
  assert.equal(classifyLCardOutcome(checks, { hasCheckableDone: false }), 'failed');
});

test('nightNumberFor counts prior checkpoint headers and increments', () => {
  assert.equal(nightNumberFor(''), 1);
  assert.equal(nightNumberFor(null), 1);
  assert.equal(nightNumberFor('## Autonomous checkpoint (night 1)\nsome text'), 2);
  assert.equal(nightNumberFor('## Autonomous checkpoint (night 1)\n...\n## Autonomous checkpoint (night 2)\n...'), 3);
  // Out-of-order / duplicated headers still take the max, not the count.
  assert.equal(nightNumberFor('## Autonomous checkpoint (night 3)\n...\n## Autonomous checkpoint (night 1)\n...'), 4);
});

test('buildResumeNote includes the night number and prior text verbatim', () => {
  const note = buildResumeNote({}, '## Autonomous checkpoint (night 1)\nDid the first half.');
  assert.match(note, /night 2/);
  assert.match(note, /Did the first half\./);
});

test('buildResumeNote falls back gracefully with no prior checkpoint text', () => {
  const note = buildResumeNote({}, '');
  assert.match(note, /night 1/);
  assert.match(note, /no prior checkpoint note found/);
});

test('buildFirstNightNote warns against finishing in one night', () => {
  assert.match(buildFirstNightNote(), /do not try to finish it all tonight/i);
});

test('buildCheckpointNote embeds night, summary, and branch; truncates long summaries', () => {
  const note = buildCheckpointNote({ night: 2, summary: 'Added the parser.', branch: 'auto/big-card--abc123' });
  assert.match(note, /night 2/);
  assert.match(note, /Added the parser\./);
  assert.match(note, /auto\/big-card--abc123/);
  const long = buildCheckpointNote({ night: 1, summary: 'x'.repeat(2000), branch: 'auto/x' });
  assert.ok(long.length < 1200);
});
