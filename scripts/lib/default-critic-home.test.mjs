// BRO-7391: pure unit test for the homeless-defaultCritic finder.
import { test } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
const { findHomelessDefaultCritics } = createRequire(import.meta.url)('./default-critic-home.js');

const reg = {
  _aliasIndex: { 'a-alias': 'a' },
  outlets: {
    a: { defaultCritic: 'Ann' },
    b: { defaultCritic: 'Bob' },
    c: { defaultCritic: 'Cy' },
    d: {},
  },
};

test('flags a default with no reviews at its own outlet but reviews elsewhere (the BRO-7038 shape)', () => {
  const reviews = [
    { outletId: 'x', criticName: 'Bob' }, { outletId: 'x', criticName: 'Bob' },
    { outletId: 'a', criticName: 'Ann' },
  ];
  assert.deepStrictEqual(findHomelessDefaultCritics(reg, reviews),
    [{ outletId: 'b', critic: 'Bob', elsewhere: [{ outletId: 'x', n: 2 }] }]);
});

test('alias outletIds count as home; unseen critics are not flagged', () => {
  const reviews = [{ outletId: 'a-alias', criticName: 'Ann' }];
  assert.deepStrictEqual(findHomelessDefaultCritics(reg, reviews), []);
});

test('fixed registry (default removed) is clean', () => {
  const fixed = { outlets: { b: {} } };
  assert.deepStrictEqual(findHomelessDefaultCritics(fixed, [{ outletId: 'x', criticName: 'Bob' }]), []);
});
