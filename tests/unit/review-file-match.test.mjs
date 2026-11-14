import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { matchesOutletCriticFile, findMatchingReviewFile } = createRequire(import.meta.url)('../../scripts/lib/review-file-match.js');

test('same outlet + critic matches, with or without suffix', () => {
  assert.equal(matchesOutletCriticFile('nytimes--jesse-green.json', 'nytimes', 'jesse-green'), true);
  assert.equal(matchesOutletCriticFile('nytimes--jesse-green-2.json', 'nytimes', 'jesse-green'), true);
});

test('same critic name at a different outlet does NOT match (BRO-3943)', () => {
  assert.equal(matchesOutletCriticFile('timeout--jesse-green.json', 'nytimes', 'jesse-green'), false);
  assert.equal(matchesOutletCriticFile('timeout--jesse-green-2.json', 'nytimes', 'jesse-green'), false);
});

test('edition variants of the same outlet still match (timeout vs timeout-london)', () => {
  assert.equal(matchesOutletCriticFile('timeout-london--jesse-green.json', 'timeout', 'jesse-green'), true);
  // one direction only: a London roundup never merges into the New York outlet's file
  assert.equal(matchesOutletCriticFile('timeout--jesse-green.json', 'timeout-london', 'jesse-green'), false);
});

test('exact outlet wins over a sibling edition regardless of directory order', () => {
  const a = ['timeout--jesse-green.json', 'timeout-london--jesse-green.json'];
  assert.equal(findMatchingReviewFile(a, 'timeout-london', 'jesse-green'), 'timeout-london--jesse-green.json');
  assert.equal(findMatchingReviewFile(a.slice().reverse(), 'timeout', 'jesse-green'), 'timeout--jesse-green.json');
});

test('legacy outlet spelling matches through the injected normalizer', () => {
  const norm = (s) => (s === 'guardian-uk' ? 'guardian' : s);
  assert.equal(findMatchingReviewFile(['guardian-uk--x-y.json'], 'guardian', 'x-y', norm), 'guardian-uk--x-y.json');
  assert.equal(findMatchingReviewFile(['guardian-uk--x-y.json'], 'times', 'x-y', norm), null);
});

test('outlets that merely share a leading word do not match', () => {
  assert.equal(matchesOutletCriticFile('new-york-post--jesse-green.json', 'new-york-times', 'jesse-green'), false);
  assert.equal(matchesOutletCriticFile('timeoutx--jesse-green.json', 'timeout', 'jesse-green'), false);
});

test('critic slug that is only a prefix of another critic does not match', () => {
  assert.equal(matchesOutletCriticFile('nytimes--jesse-greenberg.json', 'nytimes', 'jesse-green'), false);
});
