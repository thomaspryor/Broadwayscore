import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { wetZeroMatchProblem: p } = createRequire(import.meta.url)('./wet-zero-match.js');
test('940 posts 0 matched -> problem', () => assert.match(p({ totalPosts: 940, titleMatched: 0 }), /0 of 940/));
test('some matched -> ok', () => assert.equal(p({ totalPosts: 940, titleMatched: 3 }), null));
test('tiny run or --show filter -> ok', () => {
  assert.equal(p({ totalPosts: 10, titleMatched: 0 }), null);
  assert.equal(p({ totalPosts: 940, titleMatched: 0, showFilter: 'x' }), null);
});
