// BRO-8323: a gated (no-ScrapingBee) chain's SERP answers must not be served to a full chain.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
process.env.BD_SERP_CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'serpc-'));
const require = createRequire(import.meta.url);
const neg = require('./serp-negative-cache.js');
const cache = require('./serp-cache.js');

for (const [name, c] of [['serp-cache', cache], ['serp-negative-cache', neg]]) {
  test(`${name}: nosb partition`, () => {
    const q = `bro-8323 ${name} query`;
    const full = { geo: 'us', dateMin: '', dateMax: '' };
    c.set(q, { ...full, nosb: '1' }, { results: [], provider: 'brightdata' });
    assert.equal(c.get(q, full), null, 'a full chain must not read the gated empty');
    assert.ok(c.get(q, { ...full, nosb: '1' }), 'the gated chain still hits its own entry');
    c.set(q + ' b', full, { results: [{ url: 'u' }], provider: 'x' });
    assert.ok(c.get(q + ' b', full), 'existing keys (no nosb) unchanged');
  });
}
