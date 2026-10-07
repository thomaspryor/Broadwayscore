import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isCommercialScope, DESIGNATION_CRITERIA, resolveScopeShow } = require('./commercial-scope.js');

test('broadway shows are in scope (explicit and default category)', () => {
  assert.equal(isCommercialScope({ id: 'x', category: 'broadway', market: 'broadway' }), true);
  assert.equal(isCommercialScope({ id: 'x', market: 'broadway' }), true); // category unset = Broadway default
});

test('off-broadway shows are OUT of scope even though market is broadway', () => {
  // The 2026-07-14 leak: OB shows carry market:'broadway' (market = city).
  assert.equal(isCommercialScope({ id: 'x', category: 'off-broadway', market: 'broadway' }), false);
});

test('west-end, off-west-end, regional are out of scope', () => {
  assert.equal(isCommercialScope({ id: 'x', category: 'west-end', market: 'west-end' }), false);
  assert.equal(isCommercialScope({ id: 'x', category: 'off-west-end', market: 'west-end' }), false);
  assert.equal(isCommercialScope({ id: 'x', category: 'regional', market: 'regional' }), false);
});

test('missing/unresolved shows and _devOnly are out of scope', () => {
  assert.equal(isCommercialScope(null), false);
  assert.equal(isCommercialScope(undefined), false);
  assert.equal(isCommercialScope('slug-string'), false);
  assert.equal(isCommercialScope({ id: 'x', _devOnly: true }), false);
});

test('resolveScopeShow: entry.slug, direct key, and year-suffix fallback', () => {
  const ragtime = { id: 'ragtime-2025', slug: 'ragtime', category: 'broadway' };
  const ob = { id: 'fish-off-broadway-2026', slug: 'fish-off-broadway', category: 'off-broadway' };
  const map = { 'ragtime': ragtime, 'ragtime-2025': ragtime, 'fish-off-broadway': ob, 'fish-off-broadway-2026': ob };
  // entry.slug wins
  assert.equal(resolveScopeShow(map, 'anything', { slug: 'ragtime' }), ragtime);
  // direct key
  assert.equal(resolveScopeShow(map, 'ragtime-2025', {}), ragtime);
  // year-suffixed key with no entry.slug, shows map keyed by bare slug only
  const bareMap = { 'ragtime': ragtime };
  assert.equal(resolveScopeShow(bareMap, 'ragtime-2025', {}), ragtime);
  // unresolved → null
  assert.equal(resolveScopeShow(map, 'queen-of-versailles', {}), null);
});

test('designation criteria defines every designation the pipeline emits', () => {
  for (const name of ['Miracle', 'Windfall', 'Easy Winner', 'Trickle', 'Fizzle', 'Flop', 'Nonprofit', 'TBD']) {
    assert.ok(DESIGNATION_CRITERIA.includes(`- ${name}:`), `missing criteria for ${name}`);
  }
  // The specific 2026-04-12 failure: Miracle vs Easy Winner must be distinguished
  // by run length, not recoupment speed.
  assert.match(DESIGNATION_CRITERIA, /limited run can NEVER be a Miracle/i);
});
