// BRO-5557: add-show (autonomous plan action) must not re-add a retired id, like the promoters.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { applyAddShow } = require('../../scripts/lib/add-show-action.js');

const show = { id: 'x-off-broadway-2026', slug: 'x-off-broadway-2026', title: 'X', venue: 'Soho Playhouse', status: 'announced', category: 'off-broadway', market: 'broadway', type: 'play' };

test('add-show refuses an id the retired registry holds, and adds it when it does not', () => {
  const shows = [];
  const refused = applyAddShow(shows, { type: 'add-show', show }, { isRetired: (id) => id === show.id });
  assert.equal(refused.ok, false);
  assert.match(refused.reason, /retired-show registry/);
  assert.equal(shows.length, 0);
  const added = applyAddShow(shows, { type: 'add-show', show }, { isRetired: () => false });
  assert.equal(added.ok, true, added.reason);
  assert.equal(shows.length, 1);
});
