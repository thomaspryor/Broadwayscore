/**
 * BRO-6877: past-week showtime archive (scripts/lib/show-schedule-history.js)
 * and the committed archive file it maintains.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const hist = require('../../scripts/lib/show-schedule-history.js');

const day = (m, e) => ({ m, e });
const week = (sat) => [day(null, null), day(null, '19:00'), day(null, '19:00'), day(null, '19:00'), day(null, '20:00'), sat, day('15:00', null)];
const snap = (currentMonday, weeks) => ({ currentMonday, shows: { 'show-a': { weeks } } });

test('a later snapshot overwrites the weeks it was live for', () => {
  const h = hist.emptyHistory();
  hist.mergeSnapshot(h, snap('20260504', { 20260511: week(day('14:00', '20:00')) }));
  const s = hist.mergeSnapshot(h, snap('20260511', { 20260511: week(day('17:00', '20:30')) }));
  assert.deepEqual(s, { added: 0, updated: 1 });
  assert.equal(h.shows['show-a'].weeks['20260511'][5].m, '17:00');
});

test('a leftover week older than the snapshot only fills gaps, never overwrites', () => {
  const h = hist.emptyHistory();
  hist.mergeSnapshot(h, snap('20260511', { 20260511: week(day('17:00', '20:30')) }));
  hist.mergeSnapshot(h, snap('20260601', { 20260511: week(day('11:00', null)), 20260518: week(day('14:00', null)) }));
  assert.equal(h.shows['show-a'].weeks['20260511'][5].m, '17:00', 'stale leftover ignored');
  assert.equal(h.shows['show-a'].weeks['20260518'][5].m, '14:00', 'missing week filled');
});

test('malformed weeks are skipped', () => {
  const h = hist.emptyHistory();
  hist.mergeSnapshot(h, snap('20260504', { 20260504: [day('14:00', null)], bogus: week(day(null, null)) }));
  assert.deepEqual(h.shows, {}, 'no empty show entry is created');
});

test('pruneFrom keeps past weeks only and never steps back below throughMonday', () => {
  const h = hist.emptyHistory();
  hist.mergeSnapshot(h, snap('20260504', { 20260504: week(day(null, null)), 20260511: week(day(null, null)), 20260518: week(day(null, null)) }));
  hist.pruneFrom(h, '20260518');
  assert.deepEqual(Object.keys(h.shows['show-a'].weeks).sort(), ['20260504', '20260511']);
  assert.equal(h.throughMonday, '20260518');
  assert.equal(h.firstWeek, '20260504');
  hist.mergeSnapshot(h, snap('20260511', { 20260511: week(day('14:00', null)) }));
  hist.pruneFrom(h, '20260511'); // a writer whose "this Monday" lags a week
  assert.ok(h.shows['show-a'].weeks['20260511'], 'archived week survives a lagging cutoff');
  assert.equal(h.throughMonday, '20260518');
});

test('archiveOutgoingSchedule folds the outgoing file into the archive on disk', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-hist-'));
  const file = path.join(dir, 'h.json');
  const outgoing = snap('20261026', { 20261026: week(day('14:00', '20:00')), 20261102: week(day('14:00', '20:00')) });
  const r = hist.archiveOutgoingSchedule(outgoing, '20261102', { file });
  assert.equal(r.added, 1, 'only the ended week is kept');
  const back = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(back.shows['show-a'].weeks), ['20261026']);
  assert.equal(back.throughMonday, '20261102');
  const again = hist.archiveOutgoingSchedule(outgoing, '20261102', { file });
  assert.deepEqual([again.added, again.updated], [0, 0], 'idempotent');
});

test('committed archive covers past weeks back to March 2026 (spot check Oh, Mary!)', () => {
  const h = hist.loadHistory();
  const live = JSON.parse(fs.readFileSync(path.join(path.dirname(hist.HISTORY_PATH), 'show-schedules.json'), 'utf8'));
  assert.ok(h.firstWeek && h.firstWeek <= '20260316', `firstWeek ${h.firstWeek}`);
  for (const s of Object.values(h.shows)) {
    for (const k of Object.keys(s.weeks)) assert.ok(k < h.throughMonday, `${k} is before throughMonday`);
  }
  assert.ok(h.throughMonday <= live.currentMonday, 'archive never runs ahead of the live file');
  const sat = h.shows['oh-mary-2024']?.weeks['20260511']?.[5];
  assert.deepEqual(sat, { m: '17:00', e: '20:30' }, 'Sat 2026-05-16');
});
