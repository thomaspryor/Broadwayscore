import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { findGluedBylineTwins, isGluedVariantOf } = require('../../scripts/lib/glued-byline-twin.js');

const full = { file: 'nytimes--helen-shaw.json', outletId: 'nytimes', criticName: 'Helen Shaw', url: 'https://www.nytimes.com/x' };
const glued = { file: 'nytimes--brenner-helen-shaw.json', outletId: 'nytimes', criticName: 'Brenner Helen Shaw' };

test('BRO-5104: glued byline without url is linked to the full review (NYT As You Like It)', () => {
  assert.deepEqual([...findGluedBylineTwins([glued, full])], [[glued.file, full.file]]);
  assert.deepEqual([...findGluedBylineTwins([full, glued])], [[glued.file, full.file]]);
});

test('BRO-5104: Slave Play broadwayworld case', () => {
  const a = { file: 'bww--murray-alexander-cohen.json', outletId: 'broadwayworld', criticName: 'Murray Alexander Cohen' };
  const b = { file: 'bww--alexander-cohen.json', outletId: 'broadwayworld', criticName: 'Alexander Cohen' };
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
