// what-else finding (BRO-2893 session): discover-playbill-urls.js filtered on
// `!s.category`, which matches nothing now that Broadway entries carry
// category 'broadway', so the workflow's per-show call always exited "Show not found".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const { isDiscoverTarget } = require('../../scripts/discover-playbill-urls.js');

test('open and in-previews Broadway shows are targets, categorised or legacy', () => {
  assert.equal(isDiscoverTarget({ status: 'open', category: 'broadway' }), true);
  assert.equal(isDiscoverTarget({ status: 'previews', category: 'broadway' }), true);
  assert.equal(isDiscoverTarget({ status: 'open' }), true);
});

test('other markets and closed shows are not', () => {
  for (const category of ['off-broadway', 'west-end', 'off-west-end', 'regional', 'tour']) {
    assert.equal(isDiscoverTarget({ status: 'open', category }), false, category);
  }
  assert.equal(isDiscoverTarget({ status: 'closed', category: 'broadway' }), false);
});

test('the live corpus has at least one target', { skip: !fs.existsSync('data/shows.json') }, () => {
  const { shows } = JSON.parse(fs.readFileSync('data/shows.json', 'utf8'));
  assert.ok(shows.filter(isDiscoverTarget).length > 0);
});
