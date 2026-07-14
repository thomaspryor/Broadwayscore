import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { explicitModelHint, triageSizeFor, modelForSize, resolveModel } = require('./bsc-next-model.js');

function writeQueue(entries) {
  const file = path.join(os.tmpdir(), `bsc-next-model-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(file, JSON.stringify({ entries }));
  return file;
}

test('modelForSize: S -> sonnet (loop attempt 1), M/L -> opus (loop attempt-2-content)', () => {
  assert.equal(modelForSize('S'), 'sonnet');
  assert.equal(modelForSize('M'), 'opus');
  assert.equal(modelForSize('L'), 'opus');
  assert.equal(modelForSize(null), 'sonnet'); // no triage data -> floor
});

test('explicitModelHint: reads a line-start "Model: X" from card notes or task description, fable never matches', () => {
  assert.equal(explicitModelHint({ description: 'no hint here' }, null), null);
  assert.equal(explicitModelHint({ description: 'x' }, { notes: 'Model: Opus for this one' }), 'opus');
  assert.equal(explicitModelHint({ description: 'Model: sonnet is enough' }, null), 'sonnet');
  assert.equal(explicitModelHint({ description: 'Model: fable please' }, null), null); // fable never a valid hint
  // multi-line notes: hint on its own line, anywhere in the text
  assert.equal(explicitModelHint({ description: 'x' }, { notes: 'Architecture rewrite, multi-file.\nModel: Opus\nGood luck.' }), 'opus');
});

// Reviewer finding (ship-check, task #151): an unanchored \b regex would
// false-positive on ordinary prose mentioning "model" mid-sentence —
// including this feature's OWN card, whose notes describe the mechanism
// using the literal phrase "Model: Opus" as an example, not a directive.
test('explicitModelHint: does NOT match "model:" mid-sentence (only a dedicated line)', () => {
  assert.equal(explicitModelHint({ description: 'x' }, { notes: 'Architecture rewrite. Model: Opus — this needs real judgment.' }), null);
  assert.equal(explicitModelHint({ description: 'the data model: Opus schema tier needs a redesign' }, null), null);
  assert.equal(explicitModelHint({ description: 'x' }, { notes: 'card hint... a model hint stored on the card, e.g. "Model: Opus"' }), null);
});

test('triageSizeFor: looks up the queue entry by Notion card id', () => {
  const q = writeQueue([
    { card: { id: 'abc' }, triage: { size: 'S' } },
    { card: { id: 'def' }, triage: { size: 'M' } },
    { card: { id: 'ghi' } }, // no triage (ineligible pre-filter)
  ]);
  assert.equal(triageSizeFor('abc', q), 'S');
  assert.equal(triageSizeFor('def', q), 'M');
  assert.equal(triageSizeFor('ghi', q), null);
  assert.equal(triageSizeFor('missing', q), null);
  assert.equal(triageSizeFor(null, q), null);
  fs.unlinkSync(q);
});

test('triageSizeFor: missing queue file falls through to null, not a throw', () => {
  assert.equal(triageSizeFor('abc', '/nonexistent/path/queue.json'), null);
});

test('triageSizeFor: corrupt (unparseable) queue file also falls through to null, not a throw', () => {
  const file = path.join(os.tmpdir(), `bsc-next-model-corrupt-${Date.now()}.json`);
  fs.writeFileSync(file, '{not valid json');
  assert.equal(triageSizeFor('abc', file), null);
  fs.unlinkSync(file);
});

// ── resolveModel acceptance criteria (task #151) ────────────────────────────

test('resolveModel: S tooling card -> sonnet', () => {
  const q = writeQueue([{ card: { id: 'card-s' }, triage: { size: 'S' } }]);
  const task = { id: '1', description: '[notion:card-s] P2 · Not started · Product' };
  assert.equal(resolveModel({ explicitFlag: null, task, card: null, notionId: 'card-s', queuePath: q }), 'sonnet');
  fs.unlinkSync(q);
});

test('resolveModel: card with triage size M/L -> opus', () => {
  const q = writeQueue([{ card: { id: 'card-m' }, triage: { size: 'M' } }]);
  const task = { id: '2', description: '[notion:card-m] P1 Next · Not started · Product' };
  assert.equal(resolveModel({ explicitFlag: null, task, card: null, notionId: 'card-m', queuePath: q }), 'opus');
  fs.unlinkSync(q);
});

test('resolveModel: explicit "Model: Opus" hint on the card -> opus, even with no/other triage', () => {
  const q = writeQueue([{ card: { id: 'card-hint' }, triage: { size: 'S' } }]);
  const task = { id: '3', description: '[notion:card-hint] P1 Next · Not started · Product' };
  const card = { notes: 'Architecture rewrite, real judgment needed.\nModel: Opus' };
  assert.equal(resolveModel({ explicitFlag: null, task, card, notionId: 'card-hint', queuePath: q }), 'opus');
  fs.unlinkSync(q);
});

test('resolveModel: --model flag overrides everything, including a card hinting opus', () => {
  const q = writeQueue([{ card: { id: 'card-x' }, triage: { size: 'M' } }]);
  const task = { id: '4', description: '[notion:card-x] P1 Next · Not started · Product' };
  const card = { notes: 'Model: Opus' };
  assert.equal(resolveModel({ explicitFlag: 'haiku', task, card, notionId: 'card-x', queuePath: q }), 'haiku');
  fs.unlinkSync(q);
});

test('resolveModel: fable is never auto-selected (no triage, no hint, or hint text says fable)', () => {
  const task1 = { id: '5', description: 'no notion marker at all' };
  assert.equal(resolveModel({ explicitFlag: null, task: task1, card: null, notionId: null, queuePath: '/nonexistent/queue.json' }), 'sonnet');
  const task2 = { id: '6', description: 'Model: fable would be nice' };
  assert.equal(resolveModel({ explicitFlag: null, task: task2, card: null, notionId: null, queuePath: '/nonexistent/queue.json' }), 'sonnet');
  // fable only reachable via the explicit flag layer
  assert.equal(resolveModel({ explicitFlag: 'fable', task: task2, card: null, notionId: null, queuePath: '/nonexistent/queue.json' }), 'fable');
});
