import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { crossCheckCast, isEvidenceReview } = require('./cast-review-crosscheck');

const pad = ' The staging moves briskly through two acts of comic invention and quiet feeling.'.repeat(25);
const review = (names) => `${names} take the stage. ${pad}`;

// Real shapes: King of the Yees, Signature Theatre 2026 (cast scraped from another company's production).
const WRONG = [{ name: 'Sandra Lee' }, { name: 'Rob Narita' }, { name: 'Nick Ong' }, { name: 'Madeleine Tran' }, { name: 'Heath Hyun Houghton' }];
const RIGHT = [{ name: 'Francis Jue' }, { name: 'Kelly Marie Tran' }, { name: 'David Shih' }, { name: 'Maureen Sebastian' }, { name: 'Jon Norman Schneider' }];
const TEXTS = [
  review('Francis Jue and Kelly Marie Tran'),
  review('Maureen Sebastian, David Shih and Jon Norman Schneider'),
  review('Jue is Larry; Tran plays Lauren'),
];

test('contradicted: the cast on file is named in none of the reviews', () => {
  const r = crossCheckCast(WRONG, TEXTS);
  assert.equal(r.verdict, 'contradicted');
  assert.equal(r.named.length, 0);
});

test('ok: the real cast is named', () => {
  const r = crossCheckCast(RIGHT, TEXTS);
  assert.equal(r.verdict, 'ok');
  assert.equal(r.named.length, 5);
});

test('first and last name as separate words count (middle names, "Jue" alone does not)', () => {
  const r = crossCheckCast([{ name: 'Kelly Tran' }, { name: 'Francis Jue' }], TEXTS);
  assert.deepEqual(r.named.sort(), ['Francis Jue', 'Kelly Tran']);
  const only = crossCheckCast([{ name: 'Jue Wong' }, { name: 'Tran Smith' }], TEXTS);
  assert.equal(only.verdict, 'contradicted');
});

test('insufficient: fewer than three full reviews, or fewer than two named people', () => {
  assert.equal(crossCheckCast(WRONG, TEXTS.slice(0, 2)).verdict, 'insufficient');
  assert.equal(crossCheckCast([{ name: 'Madonna' }, { name: 'Sting' }], TEXTS).verdict, 'insufficient');
  assert.equal(crossCheckCast(WRONG, [TEXTS[0], TEXTS[1], 'short stub']).verdict, 'insufficient');
});

test('suspect (advisory): a big cast list with almost nobody named', () => {
  const big = Array.from({ length: 12 }, (_, i) => ({ name: `Actor${String.fromCharCode(97 + i)} Surname${String.fromCharCode(97 + i)}` }));
  big[0] = { name: 'Francis Jue' };
  assert.equal(crossCheckCast(big, TEXTS).verdict, 'suspect');
});

test('accents and case fold', () => {
  const r = crossCheckCast([{ name: 'Adrián González' }, { name: 'Marin Hinkle' }], [review('ADRIAN GONZALEZ and Marin Hinkle'), TEXTS[0], TEXTS[1]]);
  assert.equal(r.verdict, 'ok');
});

test('isEvidenceReview skips stubs, rejected and wrong-production files', () => {
  const base = { fullText: 'x', contentTier: 'complete' };
  assert.equal(isEvidenceReview(base), true);
  assert.equal(isEvidenceReview({ ...base, contentTier: 'stub' }), false);
  assert.equal(isEvidenceReview({ ...base, rejectedAt: '2026-10-20' }), false);
  assert.equal(isEvidenceReview({ ...base, wrongProduction: true }), false);
  assert.equal(isEvidenceReview({ ...base, isRoundupArticle: true }), false);
  assert.equal(isEvidenceReview({ contentTier: 'complete' }), false);
});
