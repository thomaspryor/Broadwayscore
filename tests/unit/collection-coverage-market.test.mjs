// BRO-4315: the coverage dashboard takes the market from shows.json, not the id.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { getMarket } = require('../../scripts/collection-coverage-dashboard.js');

test('a West End row whose id contains off-west-end stays West End', () => {
  assert.equal(getMarket('noises-off-west-end-2023', { category: 'west-end' }), 'west-end');
  assert.equal(getMarket('giant-royal-court-off-west-end-2024', { category: 'west-end' }), 'west-end');
});

test('an Off West End row with a -west-end- id is Off West End', () => {
  assert.equal(getMarket('broken-glass-west-end-2026', { category: 'off-west-end' }), 'off-west-end');
});

test('no shows.json row falls back to the id', () => {
  assert.equal(getMarket('foo-off-broadway-2020', undefined), 'off-broadway');
  assert.equal(getMarket('bar-west-end-2020', undefined), 'west-end');
  assert.equal(getMarket('hamilton-2015', null), 'broadway');
});

test('a row in a non-market category (regional, tour) gets no market bucket', () => {
  assert.equal(getMarket('black-swan-regional-2026', { category: 'regional' }), null);
  assert.equal(getMarket('bar-west-end-2020', { category: 'tour' }), null);
});
