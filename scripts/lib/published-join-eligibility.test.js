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

test('duplicates and different-byline twins are not judged against the published score', () => {
  const pub = { score: 89, criticName: 'Dominic Cavendish' };
  assert.strictEqual(canJudgePublished({ criticName: 'Dominic Cavendish' }, pub), true);
  assert.strictEqual(canJudgePublished({ criticName: 'Sam Marsden' }, pub), false);
  assert.strictEqual(canJudgePublished({ criticName: 'Dominic Cavendish', duplicateOf: 'x.json' }, pub), false);
  assert.strictEqual(canJudgePublished({ criticName: 'Dominic Cavendish' }, null), false);
});
