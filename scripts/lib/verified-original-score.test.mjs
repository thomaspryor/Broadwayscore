// applyVerifiedOriginalScore: a person's star correction voids verdicts made against the old star.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { applyVerifiedOriginalScore } = require('./verified-original-score.js');

// Exit the King (Guardian, Clapp): adjudicated against a wrong 4/5, "sided with LLM" (BRO-5942).
const record = () => ({
  outletId: 'guardian', originalScore: '4/5 stars', originalScoreSource: 'llm-gemini', assignedScore: 61,
  adjudicatedScore: 80,
  adjudicationNote: 'Auto-adjudicated (high confidence, sided with LLM): The 4/5 star rating is definitive.',
  adjudicationHistory: [{ timestamp: '2026-10-22T14:38:15.581Z', score: 80, sidedWith: 'LLM' }],
});

test('correcting the star drops an adjudication that sided with the models', () => {
  const d = record();
  assert.equal(applyVerifiedOriginalScore(d, '3/5 stars', 'printed 3/5').ok, true);
  assert.equal(d.adjudicatedScore, null);
  assert.equal(d.adjudicatedScoreInvalidated.score, 80);
  assert.equal(d.originalScore, '3/5 stars');
});

test('clearing the star drops it too', () => {
  const d = record();
  applyVerifiedOriginalScore(d, null, 'not this show\'s rating');
  assert.equal(d.adjudicatedScore, null);
});

test('re-verifying the same star keeps a models-side adjudication', () => {
  const d = { ...record(), originalScore: '3/5 stars' };
  applyVerifiedOriginalScore(d, '3/5 stars', 'checked again');
  assert.equal(d.adjudicatedScore, 80);
});

test('the same star written another way keeps it', () => {
  const d = { ...record(), originalScore: '3/5' };
  applyVerifiedOriginalScore(d, '3/5 stars', 'reformatted');
  assert.equal(d.adjudicatedScore, 80);
});

test('a first star on a record that had none keeps it (no verdict was judged against a star)', () => {
  const d = { ...record(), originalScore: null };
  applyVerifiedOriginalScore(d, '3/5 stars', 'found on the page');
  assert.equal(d.adjudicatedScore, 80);
});
