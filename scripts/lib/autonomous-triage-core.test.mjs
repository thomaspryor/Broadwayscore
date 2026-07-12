import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const {
  SCHEMA_PATH,
  buildTriagePrompt,
  parseTriageResponse,
  validateTriageResult,
  triageCard,
  decide,
  orderQueue,
} = require('./autonomous-triage-core.js');

const GOOD = {
  size: 'S',
  eligible: true,
  reason: 'Single test-file change with a clear runnable check.',
  checkableDone: 'node --test tests/unit/date-utils.test.mjs',
};

const CARD = { name: 'Fix flaky date test', priority: 'P1 Next', category: 'Product', tags: ['ci'], notes: '## Problem\nA test flakes.' };

// ── validator ↔ schema congruence ───────────────────────────────────────────

test('validator agrees with triage-schema.json on enums and required keys', () => {
  const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));
  assert.deepEqual(schema.properties.size.enum, ['S', 'M', 'L']);
  assert.deepEqual(schema.required, ['size', 'eligible', 'reason', 'checkableDone']);
  // Every required key missing must be reported.
  const r = validateTriageResult({});
  for (const k of schema.required) assert.ok(r.errors.some(e => e.includes(`"${k}"`)), `missing-${k} unreported`);
});

test('valid results pass; violations are each named', () => {
  assert.deepEqual(validateTriageResult(GOOD), { ok: true, errors: [] });
  assert.equal(validateTriageResult({ ...GOOD, size: 'XL' }).ok, false);
  assert.equal(validateTriageResult({ ...GOOD, eligible: 'yes' }).ok, false);
  assert.equal(validateTriageResult({ ...GOOD, reason: 'short' }).ok, false);
  assert.equal(validateTriageResult({ ...GOOD, extra: 1 }).ok, false);
  // Eligible L without a split proposal is invalid; with a conformant one it
  // passes; ineligible L needs no proposal (the loop won't touch it).
  assert.equal(validateTriageResult({ ...GOOD, size: 'L' }).ok, false);
  assert.equal(validateTriageResult({ ...GOOD, size: 'L', eligible: false }).ok, true);
  const child = { title: 'Child card one', notes: '## Problem\n' + 'x'.repeat(280) + '\n## Suggested approach\ny\n## Acceptance criteria\nz' };
  assert.equal(validateTriageResult({ ...GOOD, size: 'L', splitProposal: [child] }).ok, true);
  assert.equal(validateTriageResult({ ...GOOD, splitProposal: [{ title: 'ok title here', notes: 'too short' }] }).ok, false);
});

test('parseTriageResponse tolerates fences and prefix prose, rejects garbage', () => {
  assert.deepEqual(parseTriageResponse('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseTriageResponse('Here you go: {"a":{"b":2}} thanks'), { a: { b: 2 } });
  assert.throws(() => parseTriageResponse('no json here'), /no JSON object/);
  assert.throws(() => parseTriageResponse('{"unbalanced":'), /unbalanced/);
});

// ── triageCard flow ─────────────────────────────────────────────────────────

test('pre-filter refusal short-circuits: no LLM call for deny-tag cards', async () => {
  let calls = 0;
  const r = await triageCard({ ...CARD, tags: ['scoring'] }, async () => { calls++; return JSON.stringify(GOOD); });
  assert.equal(calls, 0);
  assert.equal(r.preFilter.eligible, false);
  assert.equal(decide(r), 'skip');
});

test('happy path: one call, validated verdict', async () => {
  const prompts = [];
  const r = await triageCard(CARD, async p => { prompts.push(p); return JSON.stringify(GOOD); });
  assert.equal(prompts.length, 1);
  assert.deepEqual(r.triage, GOOD);
  assert.equal(decide(r), 'attempt');
  // Prompt safety: card text is declared untrusted, contract minimums inlined.
  assert.match(prompts[0], /UNTRUSTED/);
  assert.match(prompts[0], /Fix flaky date test/);
});

test('garbled response → exactly one retry echoing errors → failed("triage")', async () => {
  const prompts = [];
  const r = await triageCard(CARD, async p => { prompts.push(p); return 'sorry, I cannot produce JSON'; });
  assert.equal(prompts.length, 2, 'exactly one retry');
  assert.match(prompts[1], /failed validation/);
  assert.equal(r.failed, 'triage');
  assert.equal(r.attempts, 2);
  assert.ok(r.error.length > 0);
  assert.equal(decide(r), 'failed');
});

test('invalid-then-corrected: retry echoes the specific validation error and succeeds', async () => {
  const prompts = [];
  let n = 0;
  const r = await triageCard(CARD, async p => {
    prompts.push(p);
    n++;
    return n === 1 ? JSON.stringify({ ...GOOD, size: 'XL' }) : JSON.stringify(GOOD);
  });
  assert.match(prompts[1], /size must be one of S\/M\/L/);
  assert.deepEqual(r.triage, GOOD);
});

test('LLM transport errors count as attempts and never throw', async () => {
  const r = await triageCard(CARD, async () => { throw new Error('HTTP 529'); });
  assert.equal(r.failed, 'triage');
  assert.match(r.error, /529/);
});

// ── decisions + ordering ────────────────────────────────────────────────────

test('decide: LLM can narrow but never widen eligibility', () => {
  assert.equal(decide({ preFilter: { eligible: true }, triage: { ...GOOD, eligible: false } }), 'skip');
  assert.equal(decide({ preFilter: { eligible: false, reason: 'x' } }), 'skip');
  assert.equal(decide({ preFilter: { eligible: true }, triage: { ...GOOD, size: 'L', eligible: true } }), 'split');
});

test('orderQueue: P0 before P1, S before M, stable by name', () => {
  const mk = (name, priority, size) => ({ card: { name, priority }, triage: { ...GOOD, size }, decision: 'attempt' });
  const q = orderQueue([
    mk('b-card', 'P1 Next', 'S'),
    mk('a-card', 'P1 Next', 'S'),
    mk('m-card', 'P0 Now', 'M'),
    mk('s-card', 'P0 Now', 'S'),
    { card: { name: 'skipped', priority: 'P0 Now' }, decision: 'skip' },
  ]);
  assert.deepEqual(q.map(e => e.card.name), ['s-card', 'm-card', 'a-card', 'b-card']);
});
