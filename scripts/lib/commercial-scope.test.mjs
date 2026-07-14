import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isCommercialScope, DESIGNATION_CRITERIA } = require('./commercial-scope.js');

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

test('designation criteria defines every designation the pipeline emits', () => {
  for (const name of ['Miracle', 'Windfall', 'Easy Winner', 'Trickle', 'Fizzle', 'Flop', 'Nonprofit', 'TBD']) {
    assert.ok(DESIGNATION_CRITERIA.includes(`- ${name}:`), `missing criteria for ${name}`);
  }
  // The specific 2026-04-12 failure: Miracle vs Easy Winner must be distinguished
  // by run length, not recoupment speed.
  assert.match(DESIGNATION_CRITERIA, /limited run can NEVER be a Miracle/i);
});
