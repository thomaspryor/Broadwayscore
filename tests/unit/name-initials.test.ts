import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getInitials } from '../../src/lib/name-initials';

test('plain two-word name', () => {
  assert.equal(getInitials('Tyler Nabinger'), 'TN');
});

test('punctuation-led word is skipped to its first letter (Tyler (@tyvid5) bug)', () => {
  assert.equal(getInitials('Tyler (@tyvid5)'), 'TT');
});

test('parenthetical after two words keeps the first two initials', () => {
  assert.equal(getInitials('Matthew Hardy (Bored and Confused?)'), 'MH');
});

test('hyphenated + quoted + extra whitespace', () => {
  assert.equal(getInitials('  Mickey-Jo   Theatre '), 'MT');
  assert.equal(getInitials('"Weird Al" Yankovic'), 'WA');
});

test('non-ASCII letters and empty input', () => {
  assert.equal(getInitials('Élodie Ötzi'), 'ÉÖ');
  assert.equal(getInitials(''), '');
});
