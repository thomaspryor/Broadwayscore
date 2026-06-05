import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  buildComparativeBandPrompt,
  parseComparativeResponse,
  combineComparative,
  orderingAgreement,
} = require('./comparative-band.js');

const BAND = { floor: 91, ceiling: 100 };
const REVIEWS = [
  { id: 'a.json', outlet: 'FT', text: 'A stunning, immensely moving response to war.' },
  { id: 'b.json', outlet: 'Arts Desk', text: 'A tour de force; the critics gave a standing ovation.' },
];

test('buildComparativeBandPrompt embeds band bounds, ids, and the soft-distinctness guardrail', () => {
  const p = buildComparativeBandPrompt(REVIEWS, BAND, { starsRaw: '5/5', marketLabel: 'West End' });
  assert.match(p, /\[91, 100\]/);
  assert.match(p, /id: a\.json/);
  assert.match(p, /id: b\.json/);
  assert.match(p, /5\/5/);
  // Guardrail language: distinctness soft, do not invent differences.
  assert.match(p, /DO NOT invent differences/i);
  assert.match(p, /EQUAL or near-equal/i);
});

test('buildComparativeBandPrompt rejects groups smaller than 2', () => {
  assert.throws(() => buildComparativeBandPrompt([REVIEWS[0]], BAND));
});

test('parseComparativeResponse parses a clean array keyed by id', () => {
  const text = JSON.stringify([
    { id: 'a.json', score: 98, warmthRank: 1, reasoning: 'warmest' },
    { id: 'b.json', score: 94, warmthRank: 2, reasoning: 'measured' },
  ]);
  const out = parseComparativeResponse(text, ['a.json', 'b.json']);
  assert.equal(out['a.json'].score, 98);
  assert.equal(out['b.json'].score, 94);
  assert.equal(out['a.json'].warmthRank, 1);
});

test('parseComparativeResponse strips code fences and rounds string scores', () => {
  const text = '```json\n[{"id":"a.json","score":"96.6"},{"id":"b.json","score":92}]\n```';
  const out = parseComparativeResponse(text, ['a.json', 'b.json']);
  assert.equal(out['a.json'].score, 97);
  assert.equal(out['b.json'].score, 92);
});

test('parseComparativeResponse unwraps an object that nests the array', () => {
  const text = '{"reviews":[{"id":"a.json","score":99},{"id":"b.json","score":95}]}';
  const out = parseComparativeResponse(text, ['a.json', 'b.json']);
  assert.equal(out['a.json'].score, 99);
  assert.equal(out['b.json'].score, 95);
});

test('parseComparativeResponse drops hallucinated ids and skips non-numeric scores', () => {
  const text = JSON.stringify([
    { id: 'a.json', score: 98 },
    { id: 'ghost.json', score: 100 },
    { id: 'b.json', score: 'n/a' },
  ]);
  const out = parseComparativeResponse(text, ['a.json', 'b.json']);
  assert.equal(out['a.json'].score, 98);
  assert.ok(!('ghost.json' in out));
  assert.ok(!('b.json' in out)); // non-numeric dropped → caller keeps isolated
});

test('parseComparativeResponse returns {} on unrecoverable garbage', () => {
  assert.deepEqual(parseComparativeResponse('the page no longer exists', ['a.json']), {});
  assert.deepEqual(parseComparativeResponse('', ['a.json']), {});
});

test('combineComparative averages model scores and clamps to band', () => {
  const isolated = { 'a.json': 97, 'b.json': 97 };
  const m1 = { 'a.json': 99, 'b.json': 95 };
  const m2 = { 'a.json': 98, 'b.json': 92 };
  const out = combineComparative([m1, m2], isolated, BAND);
  assert.equal(out['a.json'].score, 99); // round((99+98)/2)=99 (note 98.5→99)
  assert.equal(out['b.json'].score, 94); // round((95+92)/2)=94 (93.5→94)
  assert.equal(out['a.json'].applied, true);
});

test('combineComparative clamps an out-of-band model score before averaging', () => {
  const isolated = { 'a.json': 95, 'b.json': 95 };
  const m1 = { 'a.json': 105, 'b.json': 80 }; // both out of [91,100]
  const m2 = { 'a.json': 99, 'b.json': 93 };
  const out = combineComparative([m1, m2], isolated, BAND);
  // a: clamp(105)=100, 99 → mean 99.5 → 100 ; b: clamp(80)=91, 93 → 92
  assert.equal(out['a.json'].score, 100);
  assert.equal(out['b.json'].score, 92);
});

test('combineComparative keeps isolated score when fewer than 2 models scored an id', () => {
  const isolated = { 'a.json': 97, 'b.json': 97 };
  const m1 = { 'a.json': 99 }; // only one model scored b would be 0; here b absent everywhere except isolated
  const out = combineComparative([m1], isolated, BAND, { minModels: 2 });
  assert.equal(out['a.json'].applied, false);
  assert.equal(out['a.json'].score, 97);
});

test('GUARDRAIL: two models that disagree on ordering fall back to isolated (no invented spread)', () => {
  const isolated = { 'a.json': 97, 'b.json': 97, 'c.json': 97 };
  // m1 ranks a>b>c ; m2 ranks c>b>a — opposite orderings → no real warmth signal
  const m1 = { 'a.json': 99, 'b.json': 96, 'c.json': 93 };
  const m2 = { 'a.json': 93, 'b.json': 96, 'c.json': 99 };
  const out = combineComparative([m1, m2], isolated, BAND);
  for (const id of ['a.json', 'b.json', 'c.json']) {
    assert.equal(out[id].applied, false, `${id} should keep isolated`);
    assert.equal(out[id].score, 97);
  }
});

test('GUARDRAIL: two models that agree on ordering DO spread', () => {
  const isolated = { 'a.json': 97, 'b.json': 97, 'c.json': 97 };
  const m1 = { 'a.json': 99, 'b.json': 96, 'c.json': 92 };
  const m2 = { 'a.json': 98, 'b.json': 95, 'c.json': 93 };
  const out = combineComparative([m1, m2], isolated, BAND);
  assert.ok(out['a.json'].applied);
  assert.ok(out['a.json'].score > out['c.json'].score, 'warmest > coolest');
});

test('orderingAgreement: identical ordering → 1, reversed → -1', () => {
  const ids = ['a', 'b', 'c'];
  assert.equal(orderingAgreement({ a: 3, b: 2, c: 1 }, { a: 9, b: 5, c: 1 }, ids), 1);
  assert.equal(orderingAgreement({ a: 3, b: 2, c: 1 }, { a: 1, b: 2, c: 3 }, ids), -1);
});
