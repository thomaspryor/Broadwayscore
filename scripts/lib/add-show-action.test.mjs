/**
 * Tests for scripts/lib/add-show-action.js
 * Run: node --test scripts/lib/add-show-action.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { applyAddShow } = require('./add-show-action.js');

const base = () => ({ id: 'x-off-broadway-2023', title: 'X', slug: 'x-off-broadway-2023', venue: 'Playwrights Horizons', status: 'closed',
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
  assert.deepEqual(cur.priorRuns, [{ id: 'x-off-broadway-2023', openingDate: '2023-01-02', closingDate: '2023-02-03', venue: 'Playwrights Horizons' }]);
  assert.equal(applyAddShow([], { show: base(), crossLinkFrom: 'nope' }).ok, false);
});
test('refuses a placeholder venue', () => {
  assert.equal(applyAddShow([], { show: { ...base(), venue: 'TBA' } }).ok, false);
});
test('stores the trimmed venue, same as the priorRuns link', () => {
  const cur = { id: 'cur', slug: 'cur' };
  const shows = [cur];
  applyAddShow(shows, { show: { ...base(), venue: '  Playwrights Horizons ' }, crossLinkFrom: 'cur' });
  assert.equal(shows[1].venue, 'Playwrights Horizons');
  assert.equal(cur.priorRuns[0].venue, 'Playwrights Horizons');
});

test('priorRunOf puts a priorRuns link to the earlier run on the NEW entry', () => {
  const old = { id: 'old', slug: 'old', venue: 'SoHo Playhouse', openingDate: '2026-04-09', closingDate: '2026-05-03' };
  const shows = [old];
  const r = applyAddShow(shows, { show: base(), priorRunOf: 'old' });
  assert.equal(r.ok, true);
  assert.deepEqual(shows[1].priorRuns, [{ id: 'old', venue: 'SoHo Playhouse', openingDate: '2026-04-09', closingDate: '2026-05-03' }]);
  assert.equal(old.priorRuns, undefined);
  assert.equal(applyAddShow([], { show: base(), priorRunOf: 'nope' }).ok, false);
});

test('priorRunOf refuses an earlier run with no openingDate', () => {
  const old = { id: 'old', slug: 'old', venue: 'SoHo Playhouse', openingDate: null };
  const shows = [old];
  assert.equal(applyAddShow(shows, { show: base(), priorRunOf: 'old' }).ok, false);
  assert.equal(shows.length, 1);
});

const regional = () => ({ id: 'x-regional-2026', title: 'X', slug: 'x-regional-2026', venue: 'Old Globe Theatre, San Diego, CA',
  status: 'open', type: 'musical', category: 'regional', market: 'regional', openingDate: '2026-09-18', tags: ['regional'], provisional: true });
const parent = { id: 'p-2024', slug: 'p-2024', category: 'broadway', market: 'broadway' };
const tour = () => ({ id: 'p-tour-2026', title: 'P', slug: 'p-tour-2026', venue: 'North American Tour', status: 'open', type: 'play',
  category: 'tour', market: 'tour', tourOf: 'p-2024', tourScheduleSlug: 'p', tourLaunchEvidence: 'NYT + Tours To You', provisional: true });

test('adds a well-formed regional entry', () => {
  const shows = [];
  assert.equal(applyAddShow(shows, { show: regional() }).ok, true);
  assert.equal(shows[0].provisional, true);
  const uk = { ...regional(), id: 'y-regional-2026', slug: 'y-regional-2026', venue: 'Royal Shakespeare Theatre, Stratford-upon-Avon' };
  assert.equal(applyAddShow(shows, { show: uk }).ok, true);
});
test('refuses malformed regional entries', () => {
  assert.equal(applyAddShow([], { show: { ...regional(), market: 'broadway' } }).ok, false);
  assert.equal(applyAddShow([], { show: { ...regional(), id: 'x-2026', slug: 'x-2026' } }).ok, false);
  assert.equal(applyAddShow([], { show: { ...regional(), venue: 'Old Globe Theatre' } }).ok, false);
  assert.equal(applyAddShow([], { show: { ...regional(), tourOf: 'p-2024' } }).ok, false);
  assert.equal(applyAddShow([], { show: { ...base(), market: 'regional' } }).ok, false);
});
test('adds a tour linked to an existing broadway parent', () => {
  const shows = [{ ...parent }];
  assert.equal(applyAddShow(shows, { show: tour() }).ok, true);
  assert.equal(shows[1].tourOf, 'p-2024');
});
test('refuses malformed tour entries', () => {
  assert.equal(applyAddShow([], { show: tour() }).ok, false); // parent missing
  assert.equal(applyAddShow([{ ...parent, category: 'regional' }], { show: tour() }).ok, false);
  assert.equal(applyAddShow([{ ...parent }], { show: { ...tour(), venue: 'Shubert Theatre' } }).ok, false);
  assert.equal(applyAddShow([{ ...parent }], { show: { ...tour(), market: 'broadway' } }).ok, false);
  assert.equal(applyAddShow([{ ...parent }], { show: { ...tour(), id: 'p-2026', slug: 'p-2026' } }).ok, false);
});
