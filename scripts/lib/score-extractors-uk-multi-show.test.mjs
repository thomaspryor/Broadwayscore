// BRO-7221: The Times "State of Broadway" column rates many shows; each must get its own ★ group.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { extractScore } = require('./score-extractors.js');

const COLUMN = 'The video screens still burn brightly but the streets have seen better days. '.repeat(6) +
  'The in-jokes crammed into the opening quarter of Schmigadoon! (★★★★★) leaves you wondering if the laughter can keep flowing. ' +
  'Could Bette Midler have saved Beaches (★★☆☆☆)? Probably not. Four decades ago the Divine Miss M brought sass. ' +
  'Elsewhere, The Lost Boys (★★★☆☆) beat us into submission. Proof (★★★☆☆) at the Booth is underpowered. ' + 'More filler text here. '.repeat(10);

test('times-uk multi-show column: each show gets its own stars', () => {
  assert.equal(extractScore('', COLUMN, 'times-uk', 'Beaches, A New Musical').normalizedScore, 40);
  assert.equal(extractScore('', COLUMN, 'times-uk', 'Schmigadoon!').normalizedScore, 100);
  assert.equal(extractScore('', COLUMN, 'times-uk', 'Proof').normalizedScore, 60);
});

test('times-uk multi-show column: unnamed show abstains instead of taking the first group', () => {
  assert.equal(extractScore('', COLUMN, 'times-uk', 'Hamilton'), null);
});

test('times-uk single review is unchanged', () => {
  const r = extractScore('', 'A fine night out. ★★★★☆ Runs to March. ' + 'x '.repeat(80), 'times-uk', 'Hamilton');
  assert.equal(r.normalizedScore, 80);
});

test('times-uk end-of-section verdicts: the section that discusses the show wins (Giant / My Master Builder)', () => {
  const col = 'Dahl is a giant of the stage. Giant explores Giant ideas, and Giant works. '.repeat(4) + ' Absolutely not. ★★★★★ Harold Pinter Theatre, London, to Aug 2 ' +
    'By contrast, My Master Builder stumbles through its glamour notwithstanding. ★☆☆☆☆ Wyndham’s Theatre, London, to Jul 12 ' + 'x '.repeat(50);
  assert.equal(extractScore('', col, 'times-uk', 'Giant').normalizedScore, 100);
  assert.equal(extractScore('', col, 'times-uk', 'My Master Builder').normalizedScore, 20);
});
