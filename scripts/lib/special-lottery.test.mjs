// BRO-6862: bwayrush `special` -> `specialLottery`, and it must survive the scraper's own sanitize pass.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { mapSpecialToSpecialLottery, isNamedSpecialProgram } = require('./special-lottery.js');
const { sanitizeData } = require('../scrape-lottery-rush.js');
const data = () => JSON.parse(readFileSync(new URL('../../data/lottery-rush.json', import.meta.url), 'utf8'));

test('maps special to specialLottery and removes the raw key', () => {
  const r = mapSpecialToSpecialLottery({ special: { name: 'MTC $35', price: 35 } });
  assert.equal(r.special, undefined);
  assert.deepEqual(r.specialLottery, { name: 'MTC $35', platform: '', url: '', price: 35, instructions: '' });
});

test('a richer specialLottery wins; a derived one follows the newer scrape', () => {
  let r = mapSpecialToSpecialLottery({ special: { name: 'HipTix', price: 35 }, specialLottery: { name: 'HipTix', platform: 'TodayTix', url: 'https://x', price: 30, instructions: 'a' } });
  assert.equal(r.specialLottery.price, 30);
  r = mapSpecialToSpecialLottery({ special: { name: 'HipTix', price: 35 }, specialLottery: { name: 'HipTix', platform: '', url: '', price: 30, instructions: '' } });
  assert.equal(r.specialLottery.price, 35);
  assert.equal(r.special, undefined);
});

test('an unusable special (no price) stays visible instead of vanishing', () => {
  const r = mapSpecialToSpecialLottery({ special: { name: 'HipTix' } });
  assert.deepEqual(r.special, { name: 'HipTix' });
  assert.equal(r.specialLottery, undefined);
});

test('named programs are recognised; plain ones are not', () => {
  for (const n of ['MTC $35', 'HipTix', 'LincTix', 'Ponyboy Seat']) assert.ok(isNamedSpecialProgram({ name: n }), n);
  for (const n of ['Special Lottery', 'Club 2064', '', undefined]) assert.ok(!isNamedSpecialProgram({ name: n }), String(n));
});

test('real data: no raw special key is committed', () => {
  const bad = Object.entries(data().shows).filter(([, v]) => v.special).map(([k]) => k);
  assert.deepEqual(bad, []);
});

test('real data: the scraper sanitize pass keeps every named special program named, and does not delete a real lottery', () => {
  const before = data();
  const named = Object.entries(before.shows).filter(([, v]) => isNamedSpecialProgram(v.specialLottery));
  assert.ok(named.length >= 8, `expected the migrated rows, found ${named.length}`);
  const after = structuredClone(before);
  const log = console.log; console.log = () => {}; const warn = console.warn; console.warn = () => {};
  try { sanitizeData(after); } finally { console.log = log; console.warn = warn; }
  for (const [id, row] of named) {
    const now = after.shows[id];
    assert.ok(now, `${id} was removed`);
    assert.equal(now.specialLottery?.name, row.specialLottery.name, `${id} lost its program name`);
    assert.equal(now.specialLottery?.price, row.specialLottery.price, `${id} price changed`);
    if (!row.lottery) assert.equal(now.lottery, undefined, `${id} got an unnamed lottery promoted`);
    if (row.lottery) assert.ok(now.lottery, `${id} real lottery was deleted as a "duplicate" of the named program`);
  }
});
