// BRO-5200: a low-confidence llmScore must still corroborate dropping a junk
// generic star when the ensemble was unanimous.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { isUncorroboratedGenericStar } = require('../../scripts/lib/star-reliability.js');

const base = () => ({
  scoreSource: 'numeric-stars',
  llmScore: { score: 87, confidence: 'low' },
  ensembleData: { ensembleSource: 'ensemble-unanimous', claudeScore: 85, openaiScore: 85, geminiScore: 90 },
});

test('BRO-5200 (found in BRO-305): 2/5 junk star, unanimous Rave, low confidence -> uncorroborated', () => {
  assert.equal(isUncorroboratedGenericStar(base(), 40), true);
});
test('low confidence without a unanimous ensemble still keeps the star', () => {
  const d = base(); d.ensembleData.ensembleSource = 'ensemble-majority';
  assert.equal(isUncorroboratedGenericStar(d, 40), false);
  delete d.ensembleData;
  assert.equal(isUncorroboratedGenericStar(d, 40), false);
});
test('unanimous but star within 25 points or same bucket is kept', () => {
  assert.equal(isUncorroboratedGenericStar(base(), 80), false);
});
test('medium confidence behaviour unchanged', () => {
  const d = base(); d.llmScore.confidence = 'medium'; d.ensembleData = undefined;
  assert.equal(isUncorroboratedGenericStar(d, 40), true);
});
