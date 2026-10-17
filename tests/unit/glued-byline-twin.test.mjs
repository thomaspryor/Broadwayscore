import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { findGluedBylineTwins, isGluedVariantOf } = require('../../scripts/lib/glued-byline-twin.js');

const T = '';
const full = { file: 'nytimes--helen-shaw.json', outletId: 'nytimes', criticName: 'Helen Shaw', scored: true, fullText: 'Helen Shaw full review prose '.repeat(10), url: 'https://www.nytimes.com/x' };
const glued = { file: 'nytimes--brenner-helen-shaw.json', outletId: 'nytimes', criticName: 'Brenner Helen Shaw', fullText: T };

test('BRO-5104: glued byline without url is linked to the full review (NYT As You Like It)', () => {
  assert.deepEqual([...findGluedBylineTwins([glued, full])], [[glued.file, full.file]]);
  assert.deepEqual([...findGluedBylineTwins([full, glued])], [[glued.file, full.file]]);
});

test('BRO-5104: Slave Play broadwayworld case', () => {
  const a = { file: 'bww--murray-alexander-cohen.json', outletId: 'broadwayworld', criticName: 'Murray Alexander Cohen', fullText: T };
  const b = { file: 'bww--alexander-cohen.json', outletId: 'broadwayworld', criticName: 'Alexander Cohen', scored: true, fullText: T };
  assert.equal(findGluedBylineTwins([a, b]).get(a.file), b.file);
});

test('does not fire when the longer row has a url, outlets differ, or the winner is flagged', () => {
  assert.equal(findGluedBylineTwins([{ ...glued, url: 'https://x.test/a' }, full]).size, 0);
  assert.equal(findGluedBylineTwins([glued, { ...full, outletId: 'variety' }]).size, 0);
  assert.equal(findGluedBylineTwins([glued, { ...full, flagged: true }]).size, 0);
});

test('one-word winner, same name, non-suffix and 3+ extra words are left alone', () => {
  assert.equal(isGluedVariantOf('Helen Shaw', 'Shaw'), false);
  assert.equal(isGluedVariantOf('Helen Shaw', 'Helen Shaw'), false);
  assert.equal(isGluedVariantOf('Helen Shaw Brenner', 'Helen Shaw'), false);
  assert.equal(isGluedVariantOf('A B C Helen Shaw', 'Helen Shaw'), false);
  assert.equal(isGluedVariantOf('Brenner Helen Shaw', 'Helen Shaw'), true);
});

test('an unscored winner is never used (it could be dropped later and erase the outlet)', () => {
  assert.equal(findGluedBylineTwins([glued, { ...full, scored: false }]).size, 0);
});

test('both rows url-less (Why Am I So Single shape) and chained losers resolve to the full row', () => {
  const a = { file: 'a.json', outletId: 'broadwayworld', criticName: 'Kaan Aliya Al-Hassan', fullText: T };
  const b = { file: 'b.json', outletId: 'broadwayworld', criticName: 'Aliya Al-Hassan', scored: true, fullText: T };
  assert.deepEqual([...findGluedBylineTwins([a, b])], [['a.json', 'b.json']]);
  const x = { file: 'x.json', outletId: 'nytimes', criticName: 'X Brenner Helen Shaw', fullText: T };
  assert.equal(findGluedBylineTwins([x, { ...glued, scored: true }, full]).get('x.json'), full.file);
});

test('a loser carrying its own article text is a real critic, never a twin (Mary Ann Smith vs Ann Smith)', () => {
  const a = { file: 'a.json', outletId: 'o', criticName: 'Mary Ann Smith', fullText: 'A completely different review about another thing entirely, with its own sentences and opinions about lighting.' };
  const b = { file: 'b.json', outletId: 'o', criticName: 'Ann Smith', scored: true, fullText: 'x'.repeat(300) };
  assert.equal(findGluedBylineTwins([a, b]).size, 0);
});
