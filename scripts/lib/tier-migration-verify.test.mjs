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

// Hosted domains alone do not overrule the adopted audit or editorial staff.
const KEPT_T3 = {
  medium: 'outlet-tier-audit-2026-10.md:185',
  'yonkers-tribune': 'outlet-tier-audit-2026-10.blog-platforms.md#editorial-staff-exceptions',
  totaltheater1: 'outlet-tier-audit-2026-10.blog-platforms.md#editorial-staff-exceptions',
  number9reviews: 'outlet-tier-audit-2026-10.blog-platforms.md#editorial-staff-exceptions',
  theartsdispatch: 'outlet-tier-audit-2026-10.blog-platforms.md#editorial-staff-exceptions',
};

test('all 40 reviewed BRO-5801 small blog-platform outlets are registered at T4', () => {
  assert.equal(Object.keys(migrated).length, 40);
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

test('reviewed exceptions remain T3 in the registry and all markets', () => {
  for (const [id, evidence] of Object.entries(KEPT_T3)) {
    assert.ok(!Object.hasOwn(migrated, id), `${id} must not also be migrated`);
    assert.equal(outlets[id].tier, 3, `${id} registry: ${evidence}`);
    assert.equal(isBlogPlatformDomain(outlets[id].domain), true, `${id} platform`);
    for (const showCategory of ['broadway', 'off-broadway', 'west-end', 'off-west-end']) {
      assert.equal(getTier(id, { showCategory }), 3, `${id} ${showCategory}: ${evidence}`);
      assert.equal(getTierWeight(id, { showCategory }), 0.40, `${id} ${showCategory} base weight`);
    }
  }
});

test('no unreviewed registered T3 outlet remains on a hosted blog platform', () => {
  const remaining = Object.entries(outlets)
    .filter(([id, outlet]) => outlet.tier === 3 && isBlogPlatformDomain(outlet.domain)
      && !Object.hasOwn(KEPT_T3, id))
    .map(([id]) => id);
  assert.deepEqual(remaining, []);
});
