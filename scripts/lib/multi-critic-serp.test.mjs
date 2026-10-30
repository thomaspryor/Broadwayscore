// BRO-6535: category-backed discovery must receive the configured critic lists.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { outlets } = require('../../data/outlet-registry.json');
const legacyConfig = require('../config/critic-outlets.json');
const { normalizeOutlet } = require('./review-normalization.js');
const {
  shouldQueryPerCritic,
  remainingCritics,
  normalizeCriticForCoverage,
} = require('./multi-critic-serp.js');

const legacyOutlets = [...legacyConfig.tier1, ...legacyConfig.tier2, ...legacyConfig.tier3];

for (const legacyId of ['nytimes', 'vulture', 'nystagereview', 'theatrely']) {
  const id = normalizeOutlet(legacyId);

  test(`${legacyId}: registry supplies multiple named critics for SERP discovery`, () => {
    const entry = outlets[id];
    assert.ok(entry, `${legacyId} must resolve to a registry entry`);
    assert.ok(Array.isArray(entry.defaultCritics), `${id}.defaultCritics must be an array`);
    assert.ok(entry.defaultCritics.length > 1, `${id} must have multiple defaultCritics`);
    for (const critic of entry.defaultCritics) {
      assert.equal(typeof critic, 'string');
      assert.ok(normalizeCriticForCoverage(critic), `${id} must have a named critic`);
    }
    assert.equal(new Set(entry.defaultCritics.map(normalizeCriticForCoverage)).size,
      entry.defaultCritics.length, `${id} must not query a critic twice`);
    assert.deepEqual(entry.defaultCritics, legacyOutlets.find(o => o.id === legacyId).critics,
      `${id} must retain the existing discovery roster`);
    assert.equal(shouldQueryPerCritic(id, entry.defaultCritics), true,
      `${id} must route per critic under its canonical registry ID`);
    assert.equal(shouldQueryPerCritic(legacyId, entry.defaultCritics), true);
  });

  test(`${legacyId}: aggregator coverage leaves the other registry critics to query`, () => {
    const critics = outlets[id].defaultCritics;
    assert.ok(Array.isArray(critics) && critics.length > 1);
    assert.deepEqual(remainingCritics(critics, [{ criticName: critics[0] }]), critics.slice(1));
    assert.deepEqual(remainingCritics(critics, critics.map(criticName => ({ criticName }))), []);
    assert.deepEqual(remainingCritics(critics, [{ criticName: 'Unknown' }]), critics);
  });
}
