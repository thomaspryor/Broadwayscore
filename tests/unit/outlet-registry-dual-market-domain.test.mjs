/**
 * BRO-6640: an outlet that shares its site with a dual-market outlet must be
 * dual-market too. 'sunday-telegraph' (telegraph.co.uk, the same NYC critics as
 * 'telegraph') was London-only, so the reverse cross-market guard excluded a
 * Telegraph review of an Off-Broadway show (Here We Are 2023, The Shed).
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { outlets } = require('../../data/outlet-registry.json');

test('outlets on a dual-market outlet\'s domain are dual-market', () => {
  const dualByDomain = {};
  for (const [id, o] of Object.entries(outlets)) if (o.isDualMarket && o.domain) dualByDomain[o.domain] = id;
  const bad = Object.entries(outlets)
    .filter(([, o]) => !o.isDualMarket && o.domain && dualByDomain[o.domain])
    .map(([id, o]) => `${id} (${o.domain}, shared with ${dualByDomain[o.domain]})`);
  assert.deepStrictEqual(bad, []);
});
