import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { otherCriticEvidence } = require('./scored-other-critic.js');

test('the Dreamgirls case: reasoning scored a quoted other critic', () => {
  const r = { criticName: 'Mary Campbell', llmScore: { score: 42, reasoning: "Claude: The review text is primarily an AP wire piece by Mary Campbell, but the target critic Douglas Watt's assessment is quoted directly at the end", keyPhrases: [{ quote: "The production 'is as flashy as a shopgirl's dream and just as empty,' Watt said." }] } };
  assert.ok(otherCriticEvidence(r));
});

test('a keyphrase attributing the verdict to another named critic', () => {
  const r = { criticName: 'Jesse Green', llmScore: { score: 50, reasoning: 'Mixed review.', keyPhrases: [{ quote: 'Frank Rich called it a thrill.' }] } };
  assert.equal(otherCriticEvidence(r).kind, 'keyphrase-attributes-other');
});

test("the row's own critic, or no attribution, is not evidence", () => {
  assert.equal(otherCriticEvidence({ criticName: 'Ben Brantley', llmScore: { score: 80, reasoning: "Ben Brantley's verdict is warm. Brantley calls it a triumph.", keyPhrases: [] } }), null);
  assert.equal(otherCriticEvidence({ criticName: 'Ben Brantley', llmScore: { score: 80, reasoning: 'All 3 models agree: Positive.', keyPhrases: [{ quote: 'a triumph' }] } }), null);
  assert.equal(otherCriticEvidence({ criticName: 'X Y' }), null);
});
