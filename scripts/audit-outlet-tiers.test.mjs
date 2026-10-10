/**
 * BRO-4947 acceptance: the merged outlet ids resolve to their canonical outlet and the
 * removed ids are gone from the registry. (The migration tool itself is covered by
 * tests/unit/outlet-id-migrations.test.mjs; the tier audit script by
 * tests/unit/outlet-tier-audit.test.mjs.)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { normalizeOutlet } = require('./lib/review-normalization.js');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const registry = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'outlet-registry.json'), 'utf8'));
const tiers = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'config', 'outlet-tiers.json'), 'utf8'));

test('merged outlet ids resolve to the canonical outlet', () => {
  assert.equal(normalizeOutlet('gotham-playgoer'), 'bobs-theater-blog');
  assert.equal(normalizeOutlet('Gotham Playgoer'), 'bobs-theater-blog');
  assert.equal(normalizeOutlet('dc-metro-theater-arts'), 'dc-theater-arts');
  assert.equal(normalizeOutlet('DC Metro Theater Arts'), 'dc-theater-arts');
});

test('DC Theatre Scene is a separate outlet from DC Theater Arts', () => {
  assert.equal(normalizeOutlet('dctheatrescene'), 'dctheatrescene');
  assert.notEqual(registry.outlets.dctheatrescene.domain, registry.outlets['dc-theater-arts'].domain);
  assert.deepEqual(registry.outlets['dc-theater-arts'].domainAliases, ['dcmetrotheaterarts.com']);
  assert.ok(!(registry.outlets.dctheatrescene.domainAliases || []).includes('dcmetrotheaterarts.com'));
});

test('the removed ids are gone from the registry and the tier config, and no alias points at them', () => {
  for (const id of ['gotham-playgoer', 'dc-metro-theater-arts']) {
    assert.equal(registry.outlets[id], undefined, `${id} still in the registry`);
    assert.equal(tiers[id], undefined, `${id} still in outlet-tiers.json`);
    for (const [alias, target] of Object.entries(registry._aliasIndex)) assert.notEqual(target, id, `alias "${alias}" still points at ${id}`);
  }
});
