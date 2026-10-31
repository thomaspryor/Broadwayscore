import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { titleMatchWords, textHasWord, wordPattern } = require('./title-word-match.js');

test('a hyphenated word stays one word, never short fragments (BRO-3399)', () => {
  assert.deepEqual(titleMatchWords('Pre-Existing Condition'), ['pre-existing', 'condition']);
  assert.deepEqual(titleMatchWords('Spider-Man: Turn Off the Dark'), ['spider-man', 'turn', 'off', 'dark']);
});

test('titles without joins give the old glued-strip word list', () => {
  assert.deepEqual(titleMatchWords("Hadestown"), ['hadestown']);
  assert.deepEqual(titleMatchWords("Oh, Mary!"), ['mary']);
  assert.deepEqual(titleMatchWords("The Book of Mormon", { minLength: 3, stopwords: ['book'] }), ['mormon']);
});

test('textHasWord matches hyphen, space, glued and slug forms, not substrings of other words', () => {
  for (const t of ['Spider-Man review', 'spider man', 'spiderman', '/spider-man-turn-off/', 'Spider–Man']) {
    assert.equal(textHasWord(t, 'spider-man'), true, t);
  }
  assert.equal(textHasWord('Woman in Mind', 'spider-man'), false);
  assert.equal(textHasWord('Hamilton review', 'hamilton'), true);
  assert.equal(new RegExp(`\\b${wordPattern('c++')}\\b`).source.includes('\\+\\+'), true, 'regex chars escaped');
});
