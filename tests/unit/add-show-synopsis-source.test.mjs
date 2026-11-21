import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { applyAddShow } = require('../../scripts/lib/add-show-action.js');

const show = () => ({
  id: 'example-off-broadway-2026', slug: 'example-off-broadway-2026',
  title: 'Example', venue: 'SoHo Playhouse', status: 'open', type: 'play',
  category: 'off-broadway', market: 'broadway',
});
const options = { isRetired: () => false };

test('approved add-show stamps its synopsis as manual without changing the plan', () => {
  const input = { ...show(), synopsis: 'Two sisters reunite to save their family home.' };
  const before = structuredClone(input);
  const shows = [];
  const result = applyAddShow(shows, { show: input }, options);
  assert.equal(result.ok, true, result.reason);
  assert.equal(shows[0].synopsisSource, 'manual');
  assert.equal(shows[0].synopsis, input.synopsis);
  assert.deepEqual(input, before);
});

test('approved add-show leaves absent, null and empty synopses unstamped', () => {
  for (const fields of [{}, { synopsis: null }, { synopsis: '' }]) {
    const shows = [];
    const input = { ...show(), ...fields };
    const result = applyAddShow(shows, { show: input }, options);
    assert.equal(result.ok, true, result.reason);
    assert.equal(Object.hasOwn(shows[0], 'synopsisSource'), false);
    assert.equal(Object.hasOwn(shows[0], 'synopsis'), Object.hasOwn(input, 'synopsis'));
    assert.equal(shows[0].synopsis, input.synopsis);
  }
});

test('approved add-show owns the stamp instead of accepting a plan-supplied source', () => {
  const shows = [];
  const result = applyAddShow(shows, {
    show: { ...show(), synopsis: 'A family reunites.', synopsisSource: 'wikipedia' },
  }, options);
  assert.equal(result.ok, false);
  assert.match(result.reason, /fields not allowed: synopsisSource/);
  assert.deepEqual(shows, []);
});
