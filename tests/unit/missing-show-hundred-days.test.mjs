// BRO-6348: "Hundred Days" (The Bengsons, New York Theatre Workshop, Dec 2017) was missing.
// Added through the approved-fix plan data/pending-fixes/bro-6348.json. This test checks the
// plan, the real venue classifier, and (when core data is present) the live shows.json row.
// Review coverage is not pinned: reviews.json is derived and moves with every rebuild.
// TESTS-VS-DERIVED-DATA-EXEMPT: shows.json is this row's source of truth (a manual add); expectations come from the plan file, not hardcoded pins.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { isWestEndVenue, marketForCategory } = require('../../scripts/lib/venue-classification.js');

const ID = 'hundred-days-off-broadway-2017';
const plan = JSON.parse(readFileSync(path.join(root, 'data/pending-fixes/bro-6348.json'), 'utf8'));
const action = plan.plan.actions.find(a => a.type === 'add-show' && a.show.id === ID);
const showsPath = path.join(root, 'data/shows.json');

test('plan carries the NYTW run of Hundred Days', () => {
  assert.ok(action, 'add-show action for ' + ID);
  assert.equal(action.show.title, 'Hundred Days');
  assert.equal(action.show.venue, 'New York Theatre Workshop');
  assert.equal(action.show.openingDate, '2017-12-04');
});

test('venue classifier agrees with the plan category', () => {
  const s = action.show;
  assert.equal(isWestEndVenue(s.venue), false);
  assert.equal(s.market, marketForCategory(s.category));
  assert.equal(s.category, 'off-broadway');
});

test('live shows.json has the row, matching the plan', { skip: !existsSync(showsPath) && 'core data not present' }, () => {
  const raw = JSON.parse(readFileSync(showsPath, 'utf8'));
  const rows = (Array.isArray(raw) ? raw : raw.shows).filter(s => s.id === ID);
  assert.equal(rows.length, 1, 'exactly one row');
  assert.equal(rows[0].title, action.show.title);
  assert.equal(rows[0].venue, action.show.venue);
  assert.equal(rows[0].openingDate, action.show.openingDate);
  assert.equal(rows[0].category, action.show.category);
});
