import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { applyDataEdit, dataEditAllowProblem, EDITABLE_DATA_FIELDS } = require('./data-edit-action.js');

// BRO-5892: execute-approved-fix.js and preflight share this edit, so a plan
// that would fail at execution fails at authoring time instead.
const shows = () => ({ shows: [{ id: 'a-2026', venue: 'Old Theatre', status: 'open' }, { id: 'b-2026', venue: 'X' }] });

test('applies a shows.json edit when oldValue matches, mutating in place', () => {
  const data = shows();
  const r = applyDataEdit(data, { file: 'shows.json', showId: 'a-2026', field: 'venue', oldValue: 'Old Theatre', newValue: 'New Theatre' });
  assert.equal(r.ok, true, r.reason);
  assert.equal(data.shows[0].venue, 'New Theatre');
});

test('refuses a stale oldValue and leaves data unchanged', () => {
  const data = shows();
  const r = applyDataEdit(data, { file: 'shows.json', showId: 'a-2026', field: 'venue', oldValue: 'Wrong', newValue: 'New' });
  assert.equal(r.ok, false);
  assert.match(r.reason, /doesn't match/);
  assert.equal(data.shows[0].venue, 'Old Theatre');
});

test('an absent field compares as oldValue null (BRO-4623)', () => {
  const data = shows();
  const r = applyDataEdit(data, { file: 'shows.json', showId: 'a-2026', field: 'runtime', oldValue: null, newValue: '2h' });
  assert.equal(r.ok, true, r.reason);
});

test('a sourced theaterAddress repair is allowed and refuses a stale value (BRO-5919)', () => {
  const data = shows();
  const action = { file: 'shows.json', showId: 'a-2026', field: 'theaterAddress', oldValue: null, newValue: '383 Troutman Street, Brooklyn, NY 11237' };
  assert.equal(dataEditAllowProblem(action), null);
  assert.equal(applyDataEdit(data, action).ok, true);
  assert.equal(data.shows[0].theaterAddress, action.newValue);
  assert.equal(data.shows[1].theaterAddress, undefined);
  assert.equal(applyDataEdit(data, { ...action, newValue: 'Different address' }).ok, false);
  assert.equal(data.shows[0].theaterAddress, action.newValue);
});

test('unknown show and non-allowlisted field are refused', () => {
  assert.match(applyDataEdit(shows(), { file: 'shows.json', showId: 'zzz', field: 'venue', oldValue: null, newValue: 'v' }).reason, /not found/);
  assert.equal(applyDataEdit(shows(), { file: 'shows.json', showId: 'a-2026', field: 'id', oldValue: 'a-2026', newValue: 'x' }).ok, false);
  assert.ok(dataEditAllowProblem({ file: 'reviews.json', field: 'venue' }));
  assert.equal(dataEditAllowProblem({ file: 'shows.json', field: 'venue' }), null);
});

test('images paths must exist under root/public', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dea-'));
  fs.mkdirSync(path.join(root, 'public/images/shows/a-2026'), { recursive: true });
  fs.writeFileSync(path.join(root, 'public/images/shows/a-2026/poster.webp'), '');
  const ok = applyDataEdit(shows(), { file: 'shows.json', showId: 'a-2026', field: 'images', oldValue: null, newValue: { poster: '/images/shows/a-2026/poster.webp' } }, { root });
  assert.equal(ok.ok, true, ok.reason);
  const missing = applyDataEdit(shows(), { file: 'shows.json', showId: 'a-2026', field: 'images', oldValue: null, newValue: { poster: '/images/shows/a-2026/nope.webp' } }, { root });
  assert.match(missing.reason, /does not exist/);
});

test('openingDate edits are pinned against enrichers (BRO-4911)', () => {
  const data = shows();
  const r = applyDataEdit(data, { file: 'shows.json', showId: 'a-2026', field: 'openingDate', oldValue: null, newValue: '2026-03-01' });
  assert.equal(r.ok, true, r.reason);
  assert.notDeepEqual(Object.keys(data.shows[0]).filter(k => !['id', 'venue', 'status', 'openingDate'].includes(k)), []);
});

test('commercial.json goes through applyCommercialFieldEdit by showSlug', () => {
  const data = { shows: { 'a-slug': { designation: 'TBD' } } };
  const r = applyDataEdit(data, { file: 'commercial.json', showId: 'a-2026', showSlug: 'a-slug', field: 'notes', oldValue: null, newValue: 'n' });
  assert.equal(r.ok, true, r.reason);
  assert.equal(data.shows['a-slug'].notes, 'n');
});

test('audience-buzz.json checks oldValue', () => {
  const field = EDITABLE_DATA_FIELDS['audience-buzz.json'][0];
  const data = { shows: { 'a-2026': { [field]: 1 } } };
  assert.equal(applyDataEdit(data, { file: 'audience-buzz.json', showId: 'a-2026', field, oldValue: 2, newValue: 3 }).ok, false);
  assert.equal(applyDataEdit(data, { file: 'audience-buzz.json', showId: 'a-2026', field, oldValue: 1, newValue: 3 }).ok, true);
  assert.equal(data.shows['a-2026'][field], 3);
});

test('IBDB revival verdict fields: allowed, boolean only, isRevival syncs tags (BRO-5975)', () => {
  const data = { shows: [{ id: 'a-2026', tags: ['new'] }] };
  const checked = { file: 'shows.json', showId: 'a-2026', field: 'ibdbRevivalChecked', oldValue: null, newValue: true };
  assert.equal(dataEditAllowProblem(checked), null);
  assert.equal(applyDataEdit(data, { ...checked, newValue: 'true' }).ok, false);
  assert.equal(data.shows[0].ibdbRevivalChecked, undefined);
  assert.equal(applyDataEdit(data, checked).ok, true);
  assert.equal(data.shows[0].ibdbRevivalChecked, true);
  assert.equal(applyDataEdit(data, { file: 'shows.json', showId: 'a-2026', field: 'isRevival', oldValue: null, newValue: 1 }).ok, false);
  assert.equal(applyDataEdit(data, { file: 'shows.json', showId: 'a-2026', field: 'isRevival', oldValue: null, newValue: true }).ok, true);
  assert.deepEqual(data.shows[0].tags, ['revival']);
});

test('Playbill exemption pair: allowed, shapes checked, and the result exempts the row (BRO-5975)', async () => {
  const { isExemptFromPlaybillCheck } = await import('../validate-show-venue.js');
  const data = { shows: [{ id: 'a-2026' }] };
  const flag = { file: 'shows.json', showId: 'a-2026', field: 'noPlaybillProductionPage', oldValue: null, newValue: true };
  const src = { file: 'shows.json', showId: 'a-2026', field: 'statusBackfillSource', oldValue: null, newValue: 'Venue page and two dated trade listings confirm the run; Playbill has no page.' };
  assert.equal(dataEditAllowProblem(flag), null);
  assert.equal(dataEditAllowProblem(src), null);
  assert.equal(applyDataEdit(data, { ...flag, newValue: 'yes' }).ok, false);
  assert.equal(applyDataEdit(data, { ...src, newValue: 'too short' }).ok, false);
  assert.equal(applyDataEdit(data, flag).ok, true);
  assert.equal(applyDataEdit(data, src).ok, true);
  assert.equal(isExemptFromPlaybillCheck(data.shows[0]), true);
});
