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

test('whole-word title match: "Proof" is not "waterproof"; "Oh, Mary!" head is not "oh"', () => {
  const t1 = 'This waterproof staging is lovely. (★★★★★) ' + 'Proof (★★☆☆☆) is dull. ' + 'x '.repeat(60);
  assert.equal(extractScore('', t1, 'times-uk', 'Proof').normalizedScore, 40);
  const t2 = 'Although John liked it, Oh, Mary! (★★★★☆) is a hoot. Cats (★★☆☆☆) is not. ' + 'x '.repeat(60);
  assert.equal(extractScore('', t2, 'times-uk', 'Oh, Mary!').normalizedScore, 80);
});

test('non-Times UK outlets keep the first-group rule (related-review chrome)', () => {
  const t = '★★★★☆ A fine Hamilton night. Hamilton Hamilton Hamilton. More reviews: Cats ★★☆☆☆ ' + 'x '.repeat(60);
  assert.equal(extractScore('', t, 'standard', 'Hamilton').normalizedScore, 80);
  assert.equal(extractScore('', t, 'whatsonstage', 'Hamilton').normalizedScore, 80);
});

test('glued scraped header ("TimesHamiltonVictoria Palace") still finds the show', () => {
  const t = 'The TimesHamiltonVictoria Palace, London★★★★☆ ' + 'Hamilton dazzles. '.repeat(4) + 'Related reviews Cats Palladium ★★☆☆☆ ' + 'x '.repeat(40);
  assert.equal(extractScore('', t, 'times-uk', 'Hamilton').normalizedScore, 80);
});
