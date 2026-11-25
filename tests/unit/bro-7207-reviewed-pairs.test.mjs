import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { pairs } = require('../../scripts/config/same-critic-pairs-allowlist.json');

test('independently reviewed same-critic pairs remain documented with both sources', () => {
  for (const [showId, critic, outlets] of [
    ['aladdin-west-end-2016', 'Sarah Crompton', ['observer', 'whatsonstage']],
    ['betty-blue-eyes-west-end-2011', 'Michael Coveney', ['independent', 'whatsonstage']],
    ['the-country-girl-west-end-2010', 'Michael Coveney', ['independent', 'whatsonstage']],
  ]) {
    const pair = pairs.find(p => p.showId === showId && p.critic === critic && outlets.every(o => p.outlets.includes(o)));
    assert.ok(pair, `missing reviewed pair ${showId}`);
    assert.equal((pair.reason.match(/https?:\/\/\S+/g) || []).length, 2, `${showId} must cite both articles`);
  }
});
