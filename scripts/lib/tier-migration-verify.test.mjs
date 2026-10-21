// BRO-5801 acceptance: verify the fixed cohort, registry, and effective weights.
// Uses the real platform detector and tier lookup, without copying their logic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const migrated = require('../../tests/unit/blog-platform-tiers-adopted-2026-10.json');
const { outlets } = require('../../data/outlet-registry.json');
const { isBlogPlatformDomain } = require('./regular-poster.js');
const { getTier, getTierWeight } = require('./outlet-tiers.js');

test('all 45 BRO-5801 blog-platform outlets are registered at T4', () => {
  assert.equal(Object.keys(migrated).length, 45);
  for (const [id, domain] of Object.entries(migrated)) {
    assert.ok(outlets[id], `${id} must remain registered`);
    assert.equal(outlets[id].domain, domain, `${id} domain`);
    assert.equal(isBlogPlatformDomain(domain), true, `${id} platform`);
    assert.equal(outlets[id].tier, 4, `${id} registry tier`);
    for (const showCategory of ['broadway', 'off-broadway', 'west-end', 'off-west-end']) {
      assert.equal(getTier(id, { showCategory }), 4, `${id} ${showCategory} tier`);
      assert.equal(getTierWeight(id, { showCategory }), 0.20, `${id} ${showCategory} base weight`);
    }
  }
});

test('no registered T3 outlet remains on a hosted blog platform', () => {
  const remaining = Object.entries(outlets)
    .filter(([, outlet]) => outlet.tier === 3 && isBlogPlatformDomain(outlet.domain))
    .map(([id]) => id);
  assert.deepEqual(remaining, []);
});
