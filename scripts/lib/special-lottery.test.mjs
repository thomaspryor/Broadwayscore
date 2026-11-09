// LIVE-DATA-LANE: reads data/lottery-rush.json (read by the test); data/shows.json (untracked core data). Runs in check-corpus-drift.yml, not test.yml's blocking batch (BRO-7101).
// BRO-6862 / BRO-6878: bwayrush access programs (MTC $35, HipTix, LincTix, Ponyboy Seat)
// must map to specialLottery and survive the scraper's own cleanup. Colocated here so the
// scripts/lib/*.test.mjs glob runs it in CI (the old scripts/test-special-lottery.js did not run in CI).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const { mapSpecialToSpecialLottery, isAccessProgram } = require('./special-lottery.js');

test('maps a raw special onto specialLottery; an existing specialLottery wins', () => {
  const r = mapSpecialToSpecialLottery({ special: { name: 'MTC $35', price: 35 } });
  assert.equal(r.special, undefined);
  assert.equal(r.specialLottery.name, 'MTC $35');
  assert.equal(r.specialLottery.price, 35);
  const r2 = mapSpecialToSpecialLottery({ special: { name: 'HipTix', price: 30 }, specialLottery: { name: 'X', price: 10 } });
  assert.equal(r2.specialLottery.name, 'X');
  assert.deepEqual(mapSpecialToSpecialLottery({ rush: { price: 40 } }), { rush: { price: 40 } });
});

test('isAccessProgram recognises the named programs only', () => {
  assert.ok(isAccessProgram({ name: 'MTC $35' }));
  assert.ok(!isAccessProgram({ name: 'Special Lottery' }));
  assert.ok(!isAccessProgram(null));
});

const dataPath = path.join(here, '../../data/lottery-rush.json');
test('committed data has no raw special key, and sanitizeData keeps every access program and real lottery', { skip: !fs.existsSync(dataPath) && 'no data/lottery-rush.json' }, () => {
  const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
  const raw = Object.entries(data.shows).filter(([, v]) => v.special).map(([k]) => k);
  assert.deepEqual(raw, []);
  const { sanitizeData } = require('../scrape-lottery-rush.js');
  const copy = JSON.parse(JSON.stringify(data));
  sanitizeData(copy);
  const programs = Object.entries(data.shows).filter(([, v]) => isAccessProgram(v.specialLottery)).map(([k]) => k);
  assert.ok(programs.length >= 5, `expected the committed access programs, got ${programs.length}`);
  for (const id of programs) {
    assert.equal(copy.shows[id].specialLottery?.name, data.shows[id].specialLottery.name, `${id}: access program lost`);
    if (data.shows[id].lottery) assert.ok(copy.shows[id].lottery, `${id}: real lottery deleted`);
  }
});
