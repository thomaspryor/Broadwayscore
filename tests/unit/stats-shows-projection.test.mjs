/**
 * public/data/stats-shows.json — the slim web Stats catalog projected from the
 * app feed (mobile-shows.json). Runs the REAL scripts/lib/stats-shows.js
 * (CLAUDE.md §15). The client decoder is covered in stats-ui.test.mjs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { projectStatsShows, omittedFromShowLookup, SCHEMA_VERSION } = require('../../scripts/lib/stats-shows.js');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MOBILE = join(ROOT, 'public/data/mobile-shows.json');

const ROWS = [
  // open, scored, graded
  { id: 'open-show', t: 'Open', s: 'open', v: 'Booth Theatre', st: 'open', ty: 'musical', cs: 88.4, cr: { s: 88.4, rc: 31 }, ag: { g: 'A' } },
  // closed with a closing date: numbers only (title comes from show-lookup)
  { id: 'closed-dated', t: 'Closed', s: 'closed', v: 'X', st: 'closed', cd: '2024-01-01', cs: 61, cr: { rc: 12 } },
  // closed, no closing date: show-lookup omits it, so meta rides along
  { id: 'closed-undated', t: 'Old', s: 'old', v: 'Y', st: 'closed', cat: 'off-broadway', ty: 'play', img: { th: '/t.jpg' }, cs: 70 },
  // in previews, nothing scored yet: status alone earns a row
  { id: 'previews-show', t: 'P', s: 'p', v: 'Z', st: 'previews', cd: null, od: '2027-01-01' },
  // closed + dated + no numbers: nothing the client lacks, so no row
  { id: 'nothing', t: 'N', s: 'n', v: 'W', st: 'closed', cd: '2020-01-01' },
  // junk rows never crash the projection
  null,
  { t: 'no id' },
];

test('projects numbers, trims trailing nulls, omits the closed status', () => {
  const out = projectStatsShows(ROWS);
  assert.equal(out._v, SCHEMA_VERSION);
  assert.deepEqual(out.shows['open-show'], [88.4, 31, 'A', 'open']);
  assert.deepEqual(out.shows['closed-dated'], [61, 12]);
  assert.deepEqual(out.shows['closed-undated'], [70]);
  assert.deepEqual(out.shows['previews-show'], [null, null, null, 'previews']);
  assert.equal(out.shows.nothing, undefined);
  assert.deepEqual(Object.keys(out.shows).sort(), ['closed-dated', 'closed-undated', 'open-show', 'previews-show']);
});

test('meta only for shows the My Shows lookup leaves out (closed, no closing date)', () => {
  const out = projectStatsShows(ROWS);
  assert.deepEqual(out.meta, { 'closed-undated': ['Old', 'old', 'Y', 'off-broadway', 0, '/t.jpg'] });
  assert.equal(omittedFromShowLookup({ st: 'closed' }), true);
  assert.equal(omittedFromShowLookup({ st: 'closed', cd: '2024-01-01' }), false);
  assert.equal(omittedFromShowLookup({ st: 'open' }), false);
  assert.equal(omittedFromShowLookup({}), true, 'missing status reads as closed, like the client');
});

test('empty / missing input yields an empty, well-formed catalog', () => {
  assert.deepEqual(projectStatsShows([]), { _v: SCHEMA_VERSION, shows: {}, meta: {} });
  assert.deepEqual(projectStatsShows(undefined), { _v: SCHEMA_VERSION, shows: {}, meta: {} });
});

test('real app feed: every score, count and grade survives the projection', { skip: !existsSync(MOBILE) && 'SKIPPED: public/data/mobile-shows.json absent' }, () => {
  const rows = JSON.parse(readFileSync(MOBILE, 'utf8')).shows;
  const out = projectStatsShows(rows);
  let scored = 0;
  for (const r of rows) {
    if (typeof r.cs === 'number') {
      scored++;
      assert.equal(out.shows[r.id]?.[0], r.cs, `${r.id} score`);
      if (typeof r.cr?.rc === 'number') assert.equal(out.shows[r.id][1], r.cr.rc, `${r.id} review count`);
    }
    if (r.ag?.g) assert.equal(out.shows[r.id]?.[2], r.ag.g, `${r.id} grade`);
    if (r.st && r.st !== 'closed') assert.equal(out.shows[r.id]?.[3], r.st, `${r.id} status`);
  }
  assert.ok(scored > 1000, `expected >1000 scored shows, got ${scored}`);
  // The point of the file: an order of magnitude smaller than the app feed.
  const size = JSON.stringify(out).length;
  assert.ok(size < 250 * 1024, `stats-shows.json grew to ${(size / 1024).toFixed(0)} KB`);
});
