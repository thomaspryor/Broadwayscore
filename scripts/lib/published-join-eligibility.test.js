'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { differentCritic, canJudgePublished } = require('./published-join-eligibility');

test('different critics are detected, typos and truncations are not', () => {
  assert.strictEqual(differentCritic('Sam Marsden', 'Dominic Cavendish'), true);
  assert.strictEqual(differentCritic('Mark Sheton', 'Mark Shenton'), false);
  assert.strictEqual(differentCritic('Melissa Rose Berna', 'Melissa Rose Bernardo'), false);
  assert.strictEqual(differentCritic('Unknown', 'Holly O\'Mahony'), false);
  assert.strictEqual(differentCritic(null, 'Holly O\'Mahony'), false);
});

test('a duplicate or different-byline twin is skipped only when a rated sibling stands in', () => {
  const pub = { score: 89, criticName: 'Dominic Cavendish' };
  const canonRated = { criticName: 'Dominic Cavendish', originalScore: '3/5' };
  const canonUnrated = { criticName: 'Dominic Cavendish', originalScore: null };
  const dup = { criticName: 'Dominic Cavendish', duplicateOf: 'x.json', originalScore: '3/5' };
  const twin = { criticName: 'Sam Marsden', originalScore: '3/5' };
  assert.strictEqual(canJudgePublished(canonRated, pub, [canonRated, dup]), true);
  assert.strictEqual(canJudgePublished(dup, pub, [canonRated, dup]), false);
  assert.strictEqual(canJudgePublished(twin, pub, [canonRated, twin]), false);
  // the only rating lives on the duplicate: it must still be judged, or a real violation hides
  assert.strictEqual(canJudgePublished(dup, pub, [canonUnrated, dup]), true);
  assert.strictEqual(canJudgePublished(twin, pub, [twin]), true);
  assert.strictEqual(canJudgePublished(canonRated, null, []), false);
});
