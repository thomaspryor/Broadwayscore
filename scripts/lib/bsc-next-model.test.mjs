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

// BRO-4523: Linear cards had no layer-3 path (notionId:null), so every one ran on Sonnet.
const { linearEscalationModel, countRecentLinearOpusLaunches, countPriorLaunches, pickLinearModel, stampModelHint } = require('./bsc-next-model.js');

test('linearEscalationModel: P0 or a prior "Dispatched" comment escalates to opus; a first-run P1 stays on sonnet', () => {
  const dispatched = { body: 'Dispatched 46f3f8b6 to linear:BRO-1-x at 2026-09-29T19:37:37.296Z (headless)' };
  assert.equal(linearEscalationModel({ issue: { priority: 2, comments: { nodes: [] } } }).model, 'sonnet');
  assert.equal(linearEscalationModel({ issue: { priority: 1, comments: { nodes: [] } } }).model, 'opus');
  assert.equal(linearEscalationModel({ issue: { priority: 2, comments: { nodes: [dispatched] } } }).model, 'opus');
  // a comment that merely mentions dispatching mid-sentence is not a prior attempt
  assert.equal(linearEscalationModel({ issue: { priority: 2, comments: { nodes: [{ body: 'Not yet Dispatched anywhere' }] } } }).model, 'sonnet');
  // missing comments / missing issue never throw and never escalate
  assert.equal(linearEscalationModel({ issue: { priority: 3 } }).model, 'sonnet');
  assert.equal(linearEscalationModel({ issue: null }).model, 'sonnet');
});

test('linearEscalationModel: P0 and retries get Opus with no cap (BRO-6502)', () => {
  const p0 = { priority: 1, comments: { nodes: [] } };
  const retry = { priority: 2, comments: { nodes: [{ body: 'Dispatched to worker' }] } };
  assert.equal(linearEscalationModel({ issue: retry }).model, 'opus');
  assert.doesNotMatch(linearEscalationModel({ issue: retry }).reason, /cap/);
  // a string priority still counts as P0; 0 ("no priority") does not
  assert.equal(linearEscalationModel({ issue: { ...p0, priority: '1' } }).model, 'opus');
  assert.equal(linearEscalationModel({ issue: { ...p0, priority: 0 } }).model, 'sonnet');
  assert.deepEqual(linearEscalationModel({ issue: p0 }), { model: 'opus', reason: 'P0' });
  const p0retry = linearEscalationModel({ issue: { priority: 1, comments: { nodes: [{ body: 'Dispatched' }] } } });
  assert.equal(p0retry.model, 'opus');
});

test('countRecentLinearOpusLaunches: counts only linear opus launch rows inside the 24h window', () => {
  const now = Date.parse('2026-10-02T12:00:00Z');
  const rows = [
    { event: 'launch', taskId: 'linear:BRO-1', model: 'opus', ts: '2026-10-02T11:00:00Z' },
    { event: 'launch', taskId: 'linear:BRO-2', model: 'opus', ts: '2026-10-01T12:30:00Z' },
    { event: 'launch', taskId: 'linear:BRO-3', model: 'opus', ts: '2026-10-01T11:00:00Z' }, // >24h old
    { event: 'launch', taskId: 'linear:BRO-4', model: 'sonnet', ts: '2026-10-02T11:00:00Z' },
    { event: 'launch', taskId: '1234', model: 'opus', ts: '2026-10-02T11:00:00Z' }, // task-list dispatch
    { event: 'job-done', taskId: 'linear:BRO-5', model: 'opus', ts: '2026-10-02T11:00:00Z' },
    { event: 'launch', taskId: 'linear:BRO-6', model: 'opus', ts: 'garbage' },
    { event: 'launch', taskId: 'linear:BRO-7', model: 'opus', ts: '2026-10-02T11:00:00Z', unverified: true }, // never ran
    { event: 'launch', taskId: 'linear:BRO-8', model: 'opus', ts: '2026-10-02T11:00:00Z', remapped: true }, // same session renumbered
    null,
  ];
  assert.equal(countRecentLinearOpusLaunches(rows, now), 2);
  assert.equal(countRecentLinearOpusLaunches(undefined, now), 0);
});

// A worker that crashed never posts "Dispatched"; the ledger launch row is the
// only trace of that attempt, and it must still count as a retry.
test('countPriorLaunches: real launches of this card only', () => {
  const rows = [
    { event: 'launch', taskId: 'linear:BRO-9', model: 'sonnet' },
    { event: 'launch', taskId: 'linear:BRO-9', model: 'sonnet', unverified: true },
    { event: 'launch', taskId: 'linear:BRO-9', model: 'sonnet', remapped: true },
    { event: 'launch', taskId: 'linear:BRO-99', model: 'sonnet' },
    { event: 'job-done', taskId: 'linear:BRO-9' },
    null,
  ];
  assert.equal(countPriorLaunches(rows, 'linear:BRO-9'), 1);
  assert.equal(countPriorLaunches(undefined, 'linear:BRO-9'), 0);
});

test('pickLinearModel: flag, then hint, then escalation; a crashed earlier run escalates', () => {
  const now = Date.parse('2026-10-02T12:00:00Z');
  const p1 = { priority: 2, description: 'fix it', comments: { nodes: [] } };
  const crashed = [{ event: 'launch', taskId: 'linear:BRO-9', model: 'sonnet', ts: '2026-10-01T09:00:00Z' }];
  const base = { taskId: 'linear:BRO-9', nowMs: now, env: {} };
  assert.deepEqual(pickLinearModel({ ...base, explicitFlag: 'haiku', issue: p1, readEntries: () => crashed }), { model: 'haiku', reason: '--model flag' });
  // a card's Model: hint does not survive a failed run: the retry escalates
  const hintRetry = pickLinearModel({ ...base, explicitFlag: null, issue: { ...p1, description: 'Model: Sonnet\nx' }, readEntries: () => crashed });
  assert.equal(hintRetry.model, 'opus');
  assert.match(hintRetry.reason, /overrides Model: sonnet/);
  assert.equal(pickLinearModel({ ...base, explicitFlag: null, issue: p1, readEntries: () => [] }).model, 'sonnet');
  const retry = pickLinearModel({ ...base, explicitFlag: null, issue: p1, readEntries: () => crashed });
  assert.equal(retry.model, 'opus');
  assert.match(retry.reason, /retry after 1 prior/);
  // ledger unreadable: no retry signal, and no cap to count as reached (BRO-6502)
  const broken = pickLinearModel({ ...base, explicitFlag: null, issue: { ...p1, description: 'Model: Opus' }, readEntries: () => { throw new Error('EIO'); } });
  assert.equal(broken.model, 'opus');
  // a recorded Opus-heavy day changes nothing: there is no cap
  const busy = Array.from({ length: 50 }, (_, i) => ({ event: 'launch', taskId: `linear:BRO-${100 + i}`, model: 'opus', ts: '2026-10-02T10:00:00Z' }));
  assert.equal(pickLinearModel({ ...base, explicitFlag: null, issue: { ...p1, description: 'Model: Opus' }, readEntries: () => busy }).model, 'opus');
  assert.equal(pickLinearModel({ ...base, explicitFlag: null, issue: { ...p1, priority: 1 }, readEntries: () => { throw new Error('EIO'); } }).model, 'opus');
});

test('pickLinearModel: a Model: hint picked at filing', () => {
  const now = Date.parse('2026-10-02T12:00:00Z');
  const base = { taskId: 'linear:BRO-9', nowMs: now, env: {}, explicitFlag: null };
  const card = (priority, description, comments = []) => ({ priority, description, comments: { nodes: comments } });
  // opus hint on a first attempt, under the cap
  const o = pickLinearModel({ ...base, issue: card(2, 'x\n\nModel: Opus'), readEntries: () => [] });
  assert.deepEqual(o, { model: 'opus', reason: 'Model: opus on the card' });
  // unreadable ledger or a full day of Opus launches: still Opus (BRO-6502)
  assert.equal(pickLinearModel({ ...base, issue: card(2, 'Model: Opus'), readEntries: () => { throw new Error('EIO'); } }).model, 'opus');
  const manyLaunches = Array.from({ length: 20 }, (_, i) => ({ event: 'launch', taskId: `linear:BRO-${100 + i}`, model: 'opus', ts: '2026-10-02T10:00:00Z' }));
  assert.deepEqual(pickLinearModel({ ...base, issue: card(2, 'Model: Opus'), readEntries: () => manyLaunches }), { model: 'opus', reason: 'Model: opus on the card' });
  // a P0 sonnet line stays on Sonnet; a P0 retry escalates past it
  assert.equal(pickLinearModel({ ...base, issue: card(1, 'Model: Sonnet'), readEntries: () => { throw new Error('EIO'); } }).model, 'sonnet');
  assert.equal(pickLinearModel({ ...base, issue: card(1, 'Model: Sonnet', [{ body: 'Dispatched to worker' }]), readEntries: () => [] }).model, 'opus');
  // a P0 the filer judged easy runs on Sonnet the first time
  assert.deepEqual(pickLinearModel({ ...base, issue: card(1, 'Model: Sonnet'), readEntries: () => [] }), { model: 'sonnet', reason: 'Model: sonnet on the card' });
  // haiku hint maps to sonnet (no haiku workers)
  assert.equal(pickLinearModel({ ...base, issue: card(2, 'Model: haiku'), readEntries: () => [] }).model, 'sonnet');
  // a prior Dispatched comment counts as a retry, same as a ledger launch
  const viaComment = pickLinearModel({ ...base, issue: card(2, 'Model: Sonnet', [{ body: 'Dispatched to worker' }]), readEntries: () => [] });
  assert.equal(viaComment.model, 'opus');
  assert.match(viaComment.reason, /overrides Model: sonnet/);
});

test('stampModelHint: appends one Model: line, refuses conflicts and bad values', () => {
  assert.equal(stampModelHint('notes here', 'Opus'), 'notes here\n\nModel: Opus');
  assert.equal(stampModelHint('', 'sonnet'), 'Model: Sonnet');
  assert.equal(stampModelHint(null, 'sonnet'), 'Model: Sonnet');
  assert.equal(stampModelHint('a\nModel: opus\n', 'opus'), 'a\nModel: opus\n');
  assert.throws(() => stampModelHint('Model: Sonnet', 'opus'), /conflicts with --model opus/);
  assert.throws(() => stampModelHint('x', 'gpt'), /model must be one of opus\|sonnet/);
  assert.throws(() => stampModelHint('x', true), /model must be one of/);
  assert.throws(() => stampModelHint('x', 'haiku'), /model must be one of/);
  // A haiku line already runs on sonnet, so --model sonnet agrees with it.
  assert.equal(stampModelHint('Model: Haiku', 'sonnet'), 'Model: Haiku');
  assert.throws(() => stampModelHint('Model: Haiku', 'opus'), /conflicts with --model opus/);
  // the stamped line is read back by the dispatcher
  assert.equal(explicitModelHint({ description: stampModelHint('x', 'opus') }, null), 'opus');
});
