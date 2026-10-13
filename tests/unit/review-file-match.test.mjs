import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { matchesOutletCriticFile } = createRequire(import.meta.url)('../../scripts/lib/review-file-match.js');

test('same outlet + critic matches, with or without suffix', () => {
  assert.equal(matchesOutletCriticFile('nytimes--jesse-green.json', 'nytimes', 'jesse-green'), true);
  assert.equal(matchesOutletCriticFile('nytimes--jesse-green-2.json', 'nytimes', 'jesse-green'), true);
});

test('same critic name at a different outlet does NOT match (BRO-3943)', () => {
  assert.equal(matchesOutletCriticFile('timeout--jesse-green.json', 'nytimes', 'jesse-green'), false);
  assert.equal(matchesOutletCriticFile('timeout--jesse-green-2.json', 'nytimes', 'jesse-green'), false);
});

test('critic slug that is only a prefix of another critic does not match', () => {
  assert.equal(matchesOutletCriticFile('nytimes--jesse-greenberg.json', 'nytimes', 'jesse-green'), false);
});
