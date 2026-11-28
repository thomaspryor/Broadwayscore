// LIVE-DATA-LANE: asserts the committed data/outlet-registry.json keeps resolved domain aliases; a bot registry commit must not turn main red
// BRO-8044 class guard. Pinned census fixture (NOT the live CI-rewritten census,
// which would turn unrelated pushes red): hosts that were flagged as probable
// domain moves and resolved must stay resolved in the committed registry.
// New moves surface via the daily health row "Quality: outlet domain moves".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire(import.meta.url);
const { findProbableDomainMoves } = require('./silent-exclusion-detectors.js');
const reg = JSON.parse(fs.readFileSync(new URL('../../data/outlet-registry.json', import.meta.url)));
assert.ok(reg.outlets, 'registry shape: expected top-level outlets');
const RESOLVED_HOSTS = ['hackneycitizen.ghost.io'];
test('resolved domain-move hosts stay registered as aliases', () => {
  const census = RESOLVED_HOSTS.map((host) => ({ host, occurrences: 1, sampleUrls: [] }));
  assert.deepEqual(findProbableDomainMoves(reg.outlets, census).map((m) => `${m.host}->${m.outletId}`), []);
});
