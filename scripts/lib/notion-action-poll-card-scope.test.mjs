import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterCardsByCardId } from './notion-action-poll-card-scope.js';

const CARDS = [
  { id: '3af637c5-416f-8199-810c-e68f50c33b8d', name: 'Card A' },
  { id: '9972337a-1271-4270-9d94-000000000001', name: 'Card B' },
  { id: 'aabbccdd-eeff-0011-2233-445566778899', name: 'Card C' },
];

test('no --card flag: all candidates pass through unchanged', () => {
  assert.deepEqual(filterCardsByCardId(CARDS, undefined), CARDS);
  assert.deepEqual(filterCardsByCardId(CARDS, null), CARDS);
  assert.deepEqual(filterCardsByCardId(CARDS, ''), CARDS);
});

test('--card ID matching a candidate (hyphenated form): only that card returned', () => {
  const result = filterCardsByCardId(CARDS, '3af637c5-416f-8199-810c-e68f50c33b8d');
  assert.equal(result.length, 1);
  assert.equal(result[0].name, 'Card A');
});

test('--card ID pasted without dashes still matches the hyphenated page id', () => {
  const result = filterCardsByCardId(CARDS, '3af637c5416f8199810ce68f50c33b8d');
  assert.equal(result.length, 1);
  assert.equal(result[0].name, 'Card A');
});

test('--card ID with no match: returns empty array, not the whole list', () => {
  const result = filterCardsByCardId(CARDS, 'deadbeef-0000-0000-0000-000000000000');
  assert.deepEqual(result, []);
});

test('--card ID matching is case-insensitive (pasted Notion URL uppercase)', () => {
  const result = filterCardsByCardId(CARDS, '3AF637C5-416F-8199-810C-E68F50C33B8D');
  assert.equal(result.length, 1);
  assert.equal(result[0].name, 'Card A');
});
