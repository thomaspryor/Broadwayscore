// BRO-5586: "A Masked Ball" (Verdi, Un ballo in maschera) was missing. The eligible
// production is Royal Ballet and Opera's new staging at the Royal Opera House,
// 30 Nov - 18 Dec 2026 (no Met or Broadway run in 2026-27). It is added through the
// approved-fix plan data/pending-fixes/bro-5586.json; this test runs the real
// add-show action and venue classifier against it and, when the core data is
// present, checks the live shows.json row.
// TESTS-VS-DERIVED-DATA-EXEMPT: shows.json is this row's source of truth (a manual add); expectations come from the plan file, not hardcoded pins.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { applyAddShow } = require('../../scripts/lib/add-show-action.js');
const { isOffWestEndVenue, isWestEndVenue, marketForCategory } = require('../../scripts/lib/venue-classification.js');

const ID = 'a-masked-ball-off-west-end-2026';
const plan = JSON.parse(readFileSync(path.join(root, 'data/pending-fixes/bro-5586.json'), 'utf8'));
const action = plan.plan.actions.find(a => a.type === 'add-show' && a.show.id === ID);
const showsPath = path.join(root, 'data/shows.json');
const loadShows = () => {
  const raw = JSON.parse(readFileSync(showsPath, 'utf8'));
  return Array.isArray(raw) ? raw : raw.shows;
};

test('plan carries the Royal Opera House run of A Masked Ball', () => {
  assert.ok(action, 'add-show action for ' + ID);
  const s = action.show;
  assert.equal(s.title, 'A Masked Ball');
  assert.equal(s.venue, 'Royal Opera House');
  assert.equal(s.openingDate, '2026-11-30');
  assert.equal(s.closingDate, '2026-12-18');
  assert.equal(s.type, 'opera');
  assert.equal(s.provisional, true, 'stays in the validate-show-venue --all-provisional re-check');
  assert.ok(s.evidenceUrls.length >= 2);
});

test('category agrees with the real venue classifier (validate-data would flip it otherwise)', () => {
  const s = action.show;
  assert.equal(isOffWestEndVenue(s.venue), true);
  assert.equal(isWestEndVenue(s.venue), false);
  assert.equal(s.category, 'off-west-end');
  assert.equal(s.market, marketForCategory(s.category));
});

test('add-show applies against the real shows.json, or the row is already there', { skip: !existsSync(showsPath) && 'core data not present' }, () => {
  const shows = loadShows();
  const existing = shows.find(s => s.id === ID);
  if (existing) {
    assert.equal(existing.venue, action.show.venue);
    assert.equal(existing.category, action.show.category);
    return;
  }
  const result = applyAddShow(shows, structuredClone(action));
  assert.equal(result.ok, true, result.reason);
  assert.equal(shows.filter(s => s.id === ID).length, 1);
});
