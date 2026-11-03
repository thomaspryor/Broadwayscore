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

// The scraper's own cleanup must not turn a named access program back into an
// unnamed lottery, or delete a real lottery that happens to share its price
// (BRO-6878 review: the next scrape undid BRO-6862).
const { isAccessProgram } = require('./lib/special-lottery');
assert.ok(isAccessProgram({ name: 'MTC $35' }) && !isAccessProgram({ name: 'Special Lottery' }) && !isAccessProgram(null));
const { sanitizeData } = require('./scrape-lottery-rush.js');
const copy = JSON.parse(JSON.stringify(data));
sanitizeData(copy);
const before = Object.entries(data.shows).filter(([, v]) => isAccessProgram(v.specialLottery)).map(([k]) => k);
assert.ok(before.length >= 5, 'expected the committed access programs, got ' + before.length);
for (const id of before) {
  assert.strictEqual(copy.shows[id].specialLottery && copy.shows[id].specialLottery.name, data.shows[id].specialLottery.name, id + ': access program lost in sanitizeData');
  if (data.shows[id].lottery) assert.ok(copy.shows[id].lottery, id + ': real lottery deleted as a duplicate of the access program');
}
console.log('special-lottery tests passed');
