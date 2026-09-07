/**
 * Colocated regression test for the merge this file's DECLARED_ALIAS_OVERLAPS
 * comments defer (BRO-2921): declaring an accidental-duplicate pair here is
 * only a placeholder for a real merge. The mistake a merge can make is
 * deleting the losing outlet from the registry while leaving its id behind in
 * EDITION_PAIRS/DECLARED_ALIAS_OVERLAPS — a dangling declaration that
 * findUndeclaredDomainCollisions can't itself catch, since a pair naming a
 * missing id trivially "covers" nothing and reports no collision either way.
 *
 * tests/unit/outlet-registry-domain-collisions.test.mjs already pins the full
 * literal contents of both arrays and asserts the live registry has zero
 * undeclared collisions; this file adds the one assertion that was missing
 * from that coverage — that every declared id still resolves.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const {
  EDITION_PAIRS,
  DECLARED_ALIAS_OVERLAPS,
  findUndeclaredDomainCollisions,
} = require('./outlet-registry-domain-collisions.js');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REGISTRY_PATH = path.join(HERE, '..', '..', 'data', 'outlet-registry.json');
const outlets = fs.existsSync(REGISTRY_PATH)
  ? JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8')).outlets
  : null;

test(
  'every id in EDITION_PAIRS and DECLARED_ALIAS_OVERLAPS exists in the registry',
  { skip: outlets ? false : 'data/outlet-registry.json not present in this checkout' },
  () => {
    const missing = [];
    for (const pair of [...EDITION_PAIRS, ...DECLARED_ALIAS_OVERLAPS]) {
      for (const id of pair) {
        if (!outlets[id]) missing.push(id);
      }
    }
    assert.deepEqual(
      missing,
      [],
      `declared pair references outlet id(s) no longer in the registry: ${missing.join(', ')} — ` +
        'a merge deleted the outlet without removing its EDITION_PAIRS/DECLARED_ALIAS_OVERLAPS entry'
    );
  }
);

test(
  'findUndeclaredDomainCollisions returns empty for the live registry',
  { skip: outlets ? false : 'data/outlet-registry.json not present in this checkout' },
  () => {
    assert.deepEqual(findUndeclaredDomainCollisions(outlets), []);
  }
);
