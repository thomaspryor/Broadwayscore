import { test } from 'node:test';
import assert from 'node:assert/strict';
import pkg from './synopsis-validation.js';
const {
  isValidSynopsis,
  isPlaceholderSynopsis,
  isStaleSynopsis,
  classifyBadSynopsis,
  detectRefusalPattern,
} = pkg;

const PLACEHOLDER_1536 =
  "1536 is a stage play written by Ava Pickett. It had its world premiere at London's Almeida Theatre in 2025. It's scheduled to transfer to the West End in 2026.";
const REAL_1536 =
  "Set in a field in rural Essex in the summer of 1536, three young women meet to trade gossip as word arrives of Anne Boleyn's execution, and the distant violence seeps into their own lives.";

// --- placeholder detection ---
test('isPlaceholderSynopsis flags the 1536-style production-history placeholder', () => {
  assert.equal(isPlaceholderSynopsis(PLACEHOLDER_1536), true);
});

test('isPlaceholderSynopsis flags "is a musical written by"', () => {
  assert.equal(isPlaceholderSynopsis('Hamilton is a musical written by Lin-Manuel Miranda.'), true);
});

test('isPlaceholderSynopsis does not flag plot text mentioning a play-within', () => {
  assert.equal(
    isPlaceholderSynopsis('A failed actor stages a play written by his late wife to win back his daughter.'),
    false
  );
});

test('isValidSynopsis rejects placeholders', () => {
  assert.equal(isValidSynopsis(PLACEHOLDER_1536), false);
});

test('isValidSynopsis accepts a real plot synopsis', () => {
  assert.equal(isValidSynopsis(REAL_1536), true);
});

// --- stale future-tense detection (status-aware) ---
test('isStaleSynopsis flags future-tense transfer copy on an open show', () => {
  assert.equal(
    isStaleSynopsis({ status: 'open', synopsis: 'A new drama that is scheduled to transfer to the West End this year.' }),
    true
  );
});

test('isStaleSynopsis does NOT flag the same copy on an upcoming show', () => {
  assert.equal(
    isStaleSynopsis({ status: 'upcoming', synopsis: 'A new drama that is scheduled to transfer to the West End this year.' }),
    false
  );
});

// --- classifyBadSynopsis (single source of truth) ---
test('classifyBadSynopsis labels missing / placeholder / stale / refusal / ok', () => {
  assert.deepEqual(classifyBadSynopsis({ synopsis: '' }), { bad: true, reason: 'missing' });
  assert.deepEqual(classifyBadSynopsis({ synopsis: 'Too short.' }), { bad: true, reason: 'missing' });
  assert.equal(classifyBadSynopsis({ status: 'open', synopsis: PLACEHOLDER_1536 }).reason, 'placeholder');
  assert.equal(
    classifyBadSynopsis({ status: 'open', synopsis: 'A drama that will transfer to Broadway next season after a hit regional run.' }).reason,
    'stale'
  );
  assert.equal(
    classifyBadSynopsis({ synopsis: 'I do not have enough information about the specific plot of this show to provide a factual synopsis.' }).reason,
    'refusal'
  );
  assert.deepEqual(classifyBadSynopsis({ status: 'open', synopsis: REAL_1536 }), { bad: false, reason: null });
});

// --- existing refusal detection still works ---
test('detectRefusalPattern still catches LLM refusals', () => {
  assert.notEqual(detectRefusalPattern('I do not have enough information about this show.'), null);
  assert.equal(detectRefusalPattern(REAL_1536), null);
});
