// BRO-8044 class guard: the committed registry must leave NO probable domain
// move against the committed unknown-outlet census (the daily health row).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire(import.meta.url);
const { findProbableDomainMoves } = require('./silent-exclusion-detectors.js');
const reg = JSON.parse(fs.readFileSync(new URL('../../data/outlet-registry.json', import.meta.url)));
const census = JSON.parse(fs.readFileSync(new URL('../../data/audit/unknown-aggregator-outlets.json', import.meta.url)));
test('no unresolved probable outlet domain moves in committed data', () => {
  const moves = findProbableDomainMoves(reg.outlets || reg, census.outlets || []);
  assert.deepEqual(moves.map((m) => `${m.host}->${m.outletId}`), [],
    'add host to outlet.domainAliases (real move) or outlet.notDomainMoves (not a move)');
});
