// BRO-4398: the retire-show plan action. Requires the real module and the
// real retireId against a scratch registry (CLAUDE.md §15).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { applyRetireShow } = require('./retire-show-action.js');
const { retireId, unretireId, loadRetiredIds, matchesRetired } = require('./retired-show-ids.js');
const { mergeRetiredRecords } = require('./merge-retired-ids.js');

const row = (id, title, extra = {}) => ({ id, title, venue: 'Kiln Theatre', category: 'off-west-end', status: 'announced', provisional: true, ...extra });

function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'retire-show-'));
  const paths = { listPath: path.join(dir, 'retired-show-ids.json'), archivePath: path.join(dir, 'deleted-shows.json') };
  return { paths, retire: (id, opts) => retireId(id, { ...opts, ...paths }) };
}

test('retires a provisional row: registry + archive written, row removed, title+venue blocked on request', () => {
  const { paths, retire } = scratch();
  const shows = [row('sense-and-sensibility-off-west-end-2026', 'Sense And Sensibility'), row('nine-night-off-west-end-2026', 'Nine Night')];
  const r = applyRetireShow(shows, { id: 'sense-and-sensibility-off-west-end-2026', expectTitle: 'Sense And Sensibility', reason: 'Kiln cinema screening, not a production', blockTitleVenue: true }, { retire });
  assert.equal(r.ok, true, r.reason);
  assert.deepEqual(shows.map(s => s.id), ['nine-night-off-west-end-2026']);
  const entries = loadRetiredIds({ listPath: paths.listPath });
  assert.equal(entries.length, 1);
  assert.ok(matchesRetired({ id: 'other-id', title: 'Sense And Sensibility', venue: 'Kiln Theatre' }, entries), 'title+venue block fires under another id');
  assert.equal(JSON.parse(fs.readFileSync(paths.archivePath, 'utf8'))[0].title, 'Sense And Sensibility');
});

test('refuses: wrong title, non-provisional row, missing reason, unknown id, already retired — nothing removed', () => {
  const { retire } = scratch();
  const shows = [row('a-off-west-end-2026', 'A'), row('b-off-west-end-2026', 'B', { provisional: false })];
  const cases = [
    [{ id: 'a-off-west-end-2026', expectTitle: 'Not A', reason: 'x' }, /plan expected/],
    [{ id: 'b-off-west-end-2026', expectTitle: 'B', reason: 'x' }, /only provisional/],
    [{ id: 'a-off-west-end-2026', expectTitle: 'A', reason: ' ' }, /reason is required/],
    [{ id: 'zzz', expectTitle: 'A', reason: 'x' }, /no show with id/],
    [{ id: 'a-off-west-end-2026', reason: 'x' }, /expectTitle is required/],
  ];
  for (const [action, re] of cases) {
    const r = applyRetireShow(shows, action, { retire });
    assert.equal(r.ok, false);
    assert.match(r.reason, re);
  }
  assert.equal(shows.length, 2);
  assert.equal(applyRetireShow(shows, { id: 'a-off-west-end-2026', expectTitle: 'A', reason: 'x' }, { retire }).ok, true);
  shows.push(row('a-off-west-end-2026', 'A'));
  const again = applyRetireShow(shows, { id: 'a-off-west-end-2026', expectTitle: 'A', reason: 'x' }, { retire });
  assert.equal(again.ok, false);
  assert.match(again.reason, /already retired/);
  assert.equal(shows.length, 2, 'the row stays when the registry refuses');
});

test('unretireId reverts a retirement in both files (the save-failure rollback)', () => {
  const { paths, retire } = scratch();
  retire('x-off-west-end-2026', { reason: 'r', archivedRow: row('x-off-west-end-2026', 'X') });
  retire('y-off-west-end-2026', { reason: 'r', archivedRow: row('y-off-west-end-2026', 'Y') });
  assert.equal(unretireId('x-off-west-end-2026', paths), true);
  assert.deepEqual(loadRetiredIds({ listPath: paths.listPath }).map(e => e.id), ['y-off-west-end-2026']);
  assert.deepEqual(JSON.parse(fs.readFileSync(paths.archivePath, 'utf8')).map(e => e.id), ['y-off-west-end-2026']);
  assert.equal(unretireId('x-off-west-end-2026', paths), false);
});

test('mergeRetiredRecords: union by id, ours first, nothing dropped on a push race', () => {
  const { merged, stats } = mergeRetiredRecords([{ id: 'a' }, { id: 'b', reason: 'ours' }], [{ id: 'b', reason: 'remote' }, { id: 'c' }]);
  assert.deepEqual(merged.map(e => e.id), ['a', 'b', 'c']);
  assert.equal(merged[1].reason, 'ours');
  assert.equal(stats.added, 1);
});
