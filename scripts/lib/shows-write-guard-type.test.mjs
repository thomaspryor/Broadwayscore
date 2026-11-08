// BRO-7130: shows-write-guard gives a listed row a type on every save when
// the title says what it is, whichever writer flipped its status. It never
// guesses 'play' (a wrong type would hide the row from validate-market-expansion).
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createShowsWriteGuard, fillListedShowTypes } = require('./shows-write-guard.js');
const { findMissingRequiredFields } = require('./market-expansion-validator.js');

let dir;
let file;
const FILLER = Array.from({ length: 40 }, (_, i) => ({ id: `filler-${i}`, title: `Filler ${i}`, status: 'open', type: 'play' }));
const stub = (id, title, extra = {}) => ({
  id, title, status: 'announced', type: null, category: 'off-west-end', market: 'west-end',
  provisional: true, discoverySource: 'venue-page:the-other-palace', ...extra,
});

function seed(shows) {
  fs.writeFileSync(file, JSON.stringify({ _meta: {}, shows: [...shows, ...FILLER] }, null, 2) + '\n');
}
const onDisk = (id) => JSON.parse(fs.readFileSync(file, 'utf8')).shows.find((s) => s.id === id);

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shows-guard-type-'));
  file = path.join(dir, 'shows.json');
  delete process.env.SHOWS_TYPE_GUARD_DISABLED;
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.SHOWS_TYPE_GUARD_DISABLED;
});

test('an announced -> open flip saved through saveShows() gets a type', () => {
  seed([stub('m', 'Hot Mess: A New Musical')]);
  const g = createShowsWriteGuard(file);
  const data = g.loadShows();
  Object.assign(data.shows.find((s) => s.id === 'm'), { status: 'open', openingDate: '2026-11-05', openingDateSource: 'review-derived-press-night' });
  g.saveShows(data);
  assert.equal(onDisk('m').type, 'musical');
  assert.equal(findMissingRequiredFields([onDisk('m')]).length, 0, 'validator accepts the saved row');
});

test('an announced row and an exempt upcoming venue-page stub are left untyped', () => {
  seed([stub('a', 'Some Musical'), stub('u', 'Unknown Thing', { status: 'upcoming' })]);
  const g = createShowsWriteGuard(file);
  g.saveShows(g.loadShows());
  assert.equal(onDisk('a').type, null);
  assert.equal(onDisk('u').type, null);
});

test('an existing type is never overwritten', () => {
  seed([stub('p', 'Musical Chairs: The Musical', { status: 'open', type: 'play' })]);
  const g = createShowsWriteGuard(file);
  g.saveShows(g.loadShows());
  assert.equal(onDisk('p').type, 'play');
});

test('nothing names the type: no guess, and the row is reported unresolved', () => {
  const rows = [stub('j', 'Jerker', { status: 'closed' }), stub('t', 'Touring Thing', { status: 'upcoming', discoverySource: 'manual-user-request' })];
  const out = fillListedShowTypes(rows);
  assert.deepEqual(out.typed, []);
  assert.deepEqual(out.unresolved.map((r) => r.id), ['j', 't'], 'a non-venue-page upcoming row is not exempt in the validator either');
  assert.equal(rows[0].type, null);
});

test('kill switch SHOWS_TYPE_GUARD_DISABLED=true leaves rows untouched', () => {
  const rows = [stub('m', 'Big The Musical', { status: 'open' })];
  assert.deepEqual(fillListedShowTypes(rows, { SHOWS_TYPE_GUARD_DISABLED: 'true' }), { typed: [], unresolved: [] });
  assert.equal(rows[0].type, null);
});
