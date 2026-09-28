/**
 * Tests for scripts/lib/add-show-action.js
 * Run: node --test scripts/lib/add-show-action.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { applyAddShow } = require('./add-show-action.js');

const base = () => ({ id: 'x-off-broadway-2023', title: 'X', slug: 'x-off-broadway-2023', venue: 'V', status: 'closed',
  type: 'play', category: 'off-broadway', market: 'broadway', openingDate: '2023-01-02', closingDate: '2023-02-03' });

test('adds a show and stamps discoverySource', () => {
  const shows = [];
  const r = applyAddShow(shows, { show: base() });
  assert.equal(r.ok, true);
  assert.equal(shows[0].discoverySource, 'manual-user-request');
});
test('refuses duplicate id and slug', () => {
  assert.equal(applyAddShow([{ id: 'a', slug: 'x-off-broadway-2023' }], { show: base() }).ok, false);
  assert.equal(applyAddShow([{ id: 'x-off-broadway-2023', slug: 'q' }], { show: base() }).ok, false);
});
test('refuses missing required, unknown field, bad status', () => {
  assert.equal(applyAddShow([], { show: { ...base(), venue: '' } }).ok, false);
  assert.equal(applyAddShow([], { show: { ...base(), recouped: true } }).ok, false);
  assert.equal(applyAddShow([], { show: { ...base(), status: 'weird' } }).ok, false);
});
test('crossLinkFrom appends priorRuns once and requires the target', () => {
  const cur = { id: 'cur', slug: 'cur' };
  const r = applyAddShow([cur], { show: base(), crossLinkFrom: 'cur' });
  assert.equal(r.ok, true);
  assert.deepEqual(cur.priorRuns, [{ id: 'x-off-broadway-2023', openingDate: '2023-01-02', closingDate: '2023-02-03', venue: 'V' }]);
  assert.equal(applyAddShow([], { show: base(), crossLinkFrom: 'nope' }).ok, false);
});
