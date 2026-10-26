// BRO-5088: the Stats house list (data/theater-metadata.json keys) is the
// denominator for the diary completion ring, so it must hold Broadway houses
// only. The Steinberg Center (Laura Pels + Black Box) was off-Broadway but sat
// in the site tables after broadway-theaters.js dropped it (BRO-5080).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const { isOfficialBroadwayTheater, findTheater } = require('../../scripts/lib/broadway-theaters.js');
const meta = JSON.parse(fs.readFileSync(new URL('../../data/theater-metadata.json', import.meta.url), 'utf8'));
const aliases = JSON.parse(fs.readFileSync(new URL('../../src/lib/stats/venue-aliases.json', import.meta.url), 'utf8'));
const houses = Object.keys(meta).filter((k) => !k.startsWith('_'));

test('every theater-metadata house is an official Broadway theater', () => {
  const notBroadway = houses.filter((h) => !isOfficialBroadwayTheater(h));
  assert.deepEqual(notBroadway, [], 'non-Broadway keys in theater-metadata.json');
});

test('every venue alias targets a theater-metadata house', () => {
  const dangling = Object.entries(aliases).filter(([from, target]) => !from.startsWith('_') && !meta[target]).map(([from, to]) => `${from} -> ${to}`);
  assert.deepEqual(dangling, []);
});

test('Steinberg Center is not a Broadway house anywhere in the site tables', () => {
  assert.equal(findTheater('Harold and Miriam Steinberg Center for Theatre'), null);
  assert.equal(meta['Harold and Miriam Steinberg Center for Theatre'], undefined);
});
