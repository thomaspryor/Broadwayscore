const assert = require('assert');
const { mapSpecialToSpecialLottery } = require('./lib/special-lottery');
const fs = require('fs'), path = require('path');

let r = mapSpecialToSpecialLottery({ special: { name: 'MTC $35', price: 35 } });
assert.strictEqual(r.special, undefined);
assert.strictEqual(r.specialLottery.name, 'MTC $35');
assert.strictEqual(r.specialLottery.price, 35);

r = mapSpecialToSpecialLottery({ special: { name: 'HipTix', price: 30 }, specialLottery: { name: 'X', price: 10 } });
assert.strictEqual(r.specialLottery.name, 'X', 'existing specialLottery wins');
assert.strictEqual(r.special, undefined);

assert.deepStrictEqual(mapSpecialToSpecialLottery({ rush: { price: 40 } }), { rush: { price: 40 } });

// Data guard: no committed row may carry a raw `special` key.
const data = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/lottery-rush.json'), 'utf8'));
const bad = Object.entries(data.shows).filter(([, v]) => v.special).map(([k]) => k);
assert.deepStrictEqual(bad, [], 'raw special key in lottery-rush.json: ' + bad.join(','));
assert.strictEqual(data.shows['awake-and-sing-2026'].specialLottery.name, 'MTC $35');
console.log('special-lottery tests passed');
