import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const { applyOutletRegistryAlias } = require('./outlet-registry-alias-action.js');
const { findProbableDomainMoves } = require('./silent-exclusion-detectors.js');

const reg = () => ({
  _meta: {},
  outlets: {
    theatreboard: { domain: 'theatreboard.com' },
    aol: { domain: 'aol.com' },
    other: { domain: 'other.com', domainAliases: ['taken.org'] },
  },
});
const act = (o = {}) => ({ type: 'outlet-registry-alias', outletId: 'theatreboard', host: 'theatreboard.co.uk', kind: 'domainAlias', reason: 'outlet moved domains', ...o });
const census = (host) => [{ host, occurrences: 3, sampleUrls: [] }];

test('domainAlias clears the detector row it was written for', () => {
  const r = reg();
  assert.equal(findProbableDomainMoves(r.outlets, census('theatreboard.co.uk')).length, 1);
  const res = applyOutletRegistryAlias(r, act());
  assert.equal(res.ok && res.changed, true);
  assert.deepEqual(r.outlets.theatreboard.domainAliases, ['theatreboard.co.uk']);
  assert.equal(findProbableDomainMoves(r.outlets, census('theatreboard.co.uk')).length, 0);
});

test('notDomainMove clears the row without registering the host', () => {
  const r = reg();
  const res = applyOutletRegistryAlias(r, act({ outletId: 'aol', host: 'aol.co.uk', kind: 'notDomainMove' }));
  assert.equal(res.ok, true);
  assert.deepEqual(r.outlets.aol.notDomainMoves, ['aol.co.uk']);
  assert.equal(r.outlets.aol.domainAliases, undefined);
  assert.equal(findProbableDomainMoves(r.outlets, census('aol.co.uk')).length, 0);
});

test('already present is an ok no-op', () => {
  const r = reg();
  applyOutletRegistryAlias(r, act());
  const res = applyOutletRegistryAlias(r, act());
  assert.deepEqual([res.ok, res.changed], [true, false]);
  assert.equal(r.outlets.theatreboard.domainAliases.length, 1);
});

test('refusals: slug mismatch, other outlet owns host, contradiction, bad input', () => {
  const r = reg();
  assert.match(applyOutletRegistryAlias(r, act({ host: 'unrelated.com' })).reason, /slug-match/);
  assert.match(applyOutletRegistryAlias(r, act({ outletId: 'nope' })).reason, /not in outlet-registry/);
  assert.match(applyOutletRegistryAlias(r, act({ host: 'https://x.com/a' })).reason, /bare hostname/);
  assert.match(applyOutletRegistryAlias(r, act({ reason: 'short' })).reason, /reason/);
  assert.match(applyOutletRegistryAlias(r, act({ kind: 'steal' })).reason, /kind/);
  r.outlets.other.domainAliases.push('theatreboard.co.uk');
  assert.match(applyOutletRegistryAlias(r, act()).reason, /already registered under other/);
  const r2 = reg();
  applyOutletRegistryAlias(r2, act({ kind: 'notDomainMove' }));
  assert.match(applyOutletRegistryAlias(r2, act()).reason, /contradiction/);
  assert.deepEqual(r2.outlets.theatreboard.domainAliases, undefined);
});

test('wired into the executor, plan docs and the codex allowlist', () => {
  const src = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');
  assert.match(src('../execute-approved-fix.js'), /case 'outlet-registry-alias':/);
  assert.match(src('../execute-approved-fix.js'), /a\.type === 'outlet-registry-alias'/);
  assert.match(src('../pending-fix-actions.md'), /outlet-registry-alias/);
  assert.match(src('./codex-data-fixes.js'), /'outlet-registry-alias'/);
});
