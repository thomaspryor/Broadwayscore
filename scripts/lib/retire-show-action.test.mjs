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

test('duplicateOf: a non-provisional duplicate with no reviews at the same house retires id-only; anything else refuses', () => {
  const { retire, paths } = scratch();
  const kept = { id: 'death-note-the-musical-west-end-2026', title: 'Death Note: The Musical', venue: 'Barbican Centre', market: 'west-end', previewsStartDate: '2026-07-30', openingDate: '2026-08-11', closingDate: '2027-05-15' };
  const dup = { id: 'death-note-the-musical-west-end-2027', title: 'Death Note The Musical', venue: 'Barbican Theatre', market: 'west-end', previewsStartDate: '2027-03-23', closingDate: '2027-05-15' };
  const base = { id: dup.id, expectTitle: dup.title, reason: 'duplicate of the 2026 row', duplicateOf: kept.id };
  const none = () => 0;
  const cases = [
    [{ ...base, blockTitleVenue: true }, none, /id-only/],
    [{ ...base, duplicateOf: 'nope' }, none, /not in shows.json/],
    [{ ...base, duplicateOf: dup.id }, none, /another show id/],
    [base, () => 3, /3 review/],
    [base, undefined, /review count unavailable/],
  ];
  for (const [action, reviewCount, re] of cases) {
    const shows = [{ ...kept }, { ...dup }];
    const r = applyRetireShow(shows, action, { retire, reviewCount });
    assert.equal(r.ok, false, String(re));
    assert.match(r.reason, re);
    assert.equal(shows.length, 2);
  }
  const otherHouse = [{ ...kept, venue: 'Almeida Theatre' }, { ...dup }];
  assert.match(applyRetireShow(otherHouse, base, { retire, reviewCount: none }).reason, /same house/);
  const prefixHouse = [{ ...kept, venue: 'Lyric Theatre' }, { ...dup, venue: 'Lyric Hammersmith' }];
  assert.match(applyRetireShow(prefixHouse, base, { retire, reviewCount: none }).reason, /same house/, 'Lyric Theatre is not Lyric Hammersmith');
  const revival = [{ ...kept, closingDate: '2026-12-01' }, { ...dup }];
  assert.match(applyRetireShow(revival, base, { retire, reviewCount: none }).reason, /revival or return run/);
  const otherMarket = [{ ...kept, market: 'broadway' }, { ...dup }];
  assert.match(applyRetireShow(otherMarket, base, { retire, reviewCount: none }).reason, /market/);
  const shows = [{ ...kept }, { ...dup }];
  const ok = applyRetireShow(shows, base, { retire, reviewCount: none });
  assert.equal(ok.ok, true, ok.reason);
  assert.deepEqual(shows.map(s => s.id), [kept.id]);
  const entry = loadRetiredIds({ listPath: paths.listPath }).find(e => e.id === dup.id);
  assert.deepEqual([entry.title, entry.venue], [null, null]);
  // Without duplicateOf, a non-provisional row still refuses.
  assert.match(applyRetireShow([{ ...dup }], { id: dup.id, expectTitle: dup.title, reason: 'x' }, { retire, reviewCount: none }).reason, /only provisional/);
});
