/** Shared Plans owner helpers (src/lib/shared-plans/share-url.ts, BRO-4481). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultShareName, planShareUrl, validateShareName } from '../../src/lib/shared-plans/share-url';

test('planShareUrl always points at the live site', () => {
  assert.equal(planShareUrl('a'.repeat(32)), `https://broadwayscorecard.com/plans/${'a'.repeat(32)}`);
});

test('validateShareName', () => {
  assert.equal(validateShareName('Tom'), null);
  assert.equal(validateShareName('  Tom  '), null);
  assert.match(validateShareName('   ')!, /Add the name/);
  assert.match(validateShareName('x'.repeat(31))!, /30 characters/);
  assert.equal(validateShareName('x'.repeat(30)), null);
  for (const n of ['Broadway Scorecard', 'scorecard team', 'BroadwayScore']) {
    assert.match(validateShareName(n)!, /own name/, n);
  }
  assert.equal(validateShareName('Broadway Bob'), null, 'the word Broadway alone is fine');
});

test('defaultShareName is the first word only', () => {
  assert.equal(defaultShareName('Tom Pryor'), 'Tom');
  assert.equal(defaultShareName('  Bea  '), 'Bea');
  assert.equal(defaultShareName(''), '');
  assert.equal(defaultShareName(null), '');
  assert.equal(defaultShareName('X'.repeat(40)).length, 30);
});
