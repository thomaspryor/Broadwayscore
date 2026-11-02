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

test('BRO-5927: a shadowed twin flagged as another article is never judged; a shadowed twin is judged on its rating only', () => {
  const { publishedJoinMode } = require('./published-join-eligibility');
  const pub = { score: 94, criticName: 'David Cote' };
  const wrongShowTwin = { criticName: 'Adam Feldman', originalScore: 60, wrongShow: true };
  assert.strictEqual(publishedJoinMode(wrongShowTwin, pub, [wrongShowTwin]), null);
  const wrongProdDup = { criticName: 'David Cote', duplicateOf: 'x.json', starRating: '2/5', wrongProduction: true };
  assert.strictEqual(publishedJoinMode(wrongProdDup, pub, [wrongProdDup]), null);
  const unflaggedDup = { criticName: 'David Cote', duplicateOf: 'x.json', starRating: '2/5' };
  assert.strictEqual(publishedJoinMode(unflaggedDup, pub, [unflaggedDup]), 'shadowed');
  const own = { criticName: 'David Cote', wrongShow: true };
  assert.strictEqual(publishedJoinMode(own, pub, [own]), 'own');
});

test('BRO-5927: another byline is not judged when a rated duplicate carries the published critic\'s byline', () => {
  const { publishedJoinMode } = require('./published-join-eligibility');
  const pub = { score: 38, criticName: 'Alice Saville' };
  const other = { criticName: 'Louis Chilton', duplicateOf: 'a.json', originalScore: '4/5 stars' };
  const sameCriticDup = { criticName: 'Alice Saville', duplicateOf: 'a.json', originalScore: '2/5 stars' };
  const unrated = { criticName: 'Alice Saville' };
  assert.strictEqual(publishedJoinMode(other, pub, [unrated, other, sameCriticDup]), null);
  assert.strictEqual(publishedJoinMode(other, pub, [unrated, other]), 'shadowed');
  // a same-byline duplicate still needs a non-duplicate stand-in (BRO-5927 first pass)
  const dup = { criticName: 'Alice Saville', duplicateOf: 'a.json', originalScore: '4/5 stars' };
  assert.strictEqual(publishedJoinMode(dup, pub, [unrated, dup, sameCriticDup]), 'shadowed');
});
