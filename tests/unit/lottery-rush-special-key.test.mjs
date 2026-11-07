// BRO-6862: keep the card's acceptance command runnable in the unit batch.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { mapSpecialToSpecialLottery, isAccessProgram } = require('../../scripts/lib/special-lottery.js');
const { shows } = require('../../data/lottery-rush.json');

const programs = [
  ['awake-and-sing-2026', 'MTC $35', 35],
  ['montauk-2026', 'MTC $35', 35],
  ['mix-and-master-2027', 'HipTix', 30],
  ['the-full-monty-2027', 'HipTix', 30],
  ['the-rocky-horror-show-2026', 'HipTix', 30],
];

for (const [id, name, price] of programs) {
  test(`${id}: legacy mapping preserves the program label and price`, () => {
    const row = mapSpecialToSpecialLottery({ special: { name, price } });
    assert.equal(Object.hasOwn(row, 'special'), false);
    assert.equal(row.specialLottery.name, name);
    assert.equal(row.specialLottery.price, price);
    assert.equal(isAccessProgram(row.specialLottery), true);
    assert.deepEqual(mapSpecialToSpecialLottery(structuredClone(row)), row);
  });
}

test('canonical data has no legacy keys and retains all five reported discounts', () => {
  assert.ok(Object.keys(shows).length > 0);
  for (const [id, row] of Object.entries(shows)) {
    assert.equal(Object.hasOwn(row, 'special'), false, `${id}: legacy special key`);
    assert.deepEqual(mapSpecialToSpecialLottery(structuredClone(row)), row, `${id}: migration still needed`);
  }
  for (const [id, name, price] of programs) {
    assert.equal(shows[id]?.specialLottery?.name, name, `${id}: program label`);
    assert.equal(shows[id]?.specialLottery?.price, price, `${id}: program price`);
  }
});

test('mapping retains canonical options, unrelated fields, and program details', () => {
  const canonical = { name: 'HipTix', price: 30, url: 'https://example.com/hiptix' };
  const rush = { price: 40 };
  const row = { special: { name: 'MTC $35', price: 35 }, specialLottery: canonical, rush };
  assert.equal(mapSpecialToSpecialLottery(row), row);
  assert.equal(row.specialLottery, canonical);
  assert.equal(row.rush, rush);
  assert.equal(Object.hasOwn(row, 'special'), false);

  const special = { name: 'LincTix', price: 32, platform: 'LCT', url: 'https://example.com/linctix', instructions: 'Ages 21-35' };
  assert.deepEqual(mapSpecialToSpecialLottery({ special }).specialLottery, special);
  assert.deepEqual(mapSpecialToSpecialLottery({ rush }), { rush });
});
