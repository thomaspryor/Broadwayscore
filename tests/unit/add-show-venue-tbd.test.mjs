// BRO-5776: an announced Broadway show with no theater yet can be added; nothing else may skip the venue.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { applyAddShow } = require('../../scripts/lib/add-show-action.js');

const base = { id: 'x-tbd-2027', slug: 'x-tbd', title: 'X', venue: null, status: 'announced', category: 'broadway', market: 'broadway', type: 'play' };
const opts = { isRetired: () => false };

test('announced Broadway show may have a null venue', () => {
  const shows = [];
  const r = applyAddShow(shows, { type: 'add-show', show: base }, opts);
  assert.equal(r.ok, true, r.reason);
  assert.equal(shows[0].venue, null);
});

test('null venue is refused once the show is no longer announced or is not Broadway', () => {
  for (const patch of [{ status: 'upcoming' }, { status: 'open' }, { category: 'off-broadway' }]) {
    const r = applyAddShow([], { type: 'add-show', show: { ...base, ...patch } }, opts);
    assert.equal(r.ok, false, JSON.stringify(patch));
    assert.match(r.reason, /venue/);
  }
});

test('a placeholder venue string is still refused for an announced Broadway show', () => {
  const r = applyAddShow([], { type: 'add-show', show: { ...base, venue: 'TBD' } }, opts);
  assert.equal(r.ok, false);
});
