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
const { CORE_DATA_MERGE_REGISTRY: MERGE_REGISTRY } = require('../../scripts/lib/core-data-merge-registry.js');

const day = (m, e) => ({ m, e });
const week = (sat) => [day(null, null), day(null, '19:00'), day(null, '19:00'), day(null, '19:00'), day(null, '20:00'), sat, day('15:00', null)];
const snap = (currentMonday, weeks, id = 'show-a') => ({ currentMonday, shows: { [id]: { weeks } } });
const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sched-hist-')), 'h.json');

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

test('a mid-week rebuild never blanks days that already played (TodayTix, review P1)', () => {
  const h = hist.emptyHistory();
  const full = [day(null, null), day(null, null), day(null, null), day(null, null), day(null, '19:45'), day('15:00', '19:45'), day('13:00', '18:00')];
  hist.mergeSnapshot(h, { lastUpdated: '2026-08-03T06:00:00Z', currentMonday: '20260803', shows: { abba: { weeks: { 20260803: full } } } });
  // Sunday-morning run: TodayTix only lists today, so Fri/Sat come through empty.
  const sunOnly = full.map((d, i) => (i === 6 ? d : day(null, null)));
  hist.mergeSnapshot(h, { lastUpdated: '2026-08-09T06:00:00Z', currentMonday: '20260803', shows: { abba: { weeks: { 20260803: sunOnly } } } });
  assert.deepEqual(h.shows.abba.weeks['20260803'], full, 'Fri/Sat kept');
  // A later run can still mark an upcoming day dark.
  hist.mergeSnapshot(h, { lastUpdated: '2026-08-08T06:00:00Z', currentMonday: '20260803', shows: { abba: { weeks: { 20260803: full.map((d, i) => (i === 6 ? day(null, null) : d)) } } } });
  assert.deepEqual(h.shows.abba.weeks['20260803'][6], day(null, null), 'upcoming Sunday cancelled');
});

test('malformed weeks are skipped and create no show entry', () => {
  const h = hist.emptyHistory();
  hist.mergeSnapshot(h, snap('20260504', { 20260504: [day('14:00', null)], bogus: week(day(null, null)) }));
  assert.deepEqual(h.shows, {});
});

test('pruneAfter keeps started weeks only and never steps back below lastWeek', () => {
  const h = hist.emptyHistory();
  hist.mergeSnapshot(h, snap('20260504', { 20260504: week(day(null, null)), 20260511: week(day(null, null)), 20260518: week(day(null, null)) }));
  hist.pruneAfter(h, '20260511');
  assert.deepEqual(Object.keys(h.shows['show-a'].weeks).sort(), ['20260504', '20260511']);
  assert.equal(h.lastWeek, '20260511');
  assert.equal(h.firstWeek, '20260504');
  hist.pruneAfter(h, '20260504'); // a writer whose "this Monday" lags a week
  assert.ok(h.shows['show-a'].weeks['20260511'], 'archived week survives a lagging cutoff');
  assert.equal(h.lastWeek, '20260511');
});

test('archiveOutgoingSchedule keeps ended weeks and the current week, not future ones', () => {
  const file = tmpFile();
  const outgoing = snap('20261026', { 20261026: week(day('14:00', '20:00')), 20261102: week(day('14:00', '20:00')), 20261109: week(day('14:00', '20:00')) });
  const r = hist.archiveOutgoingSchedule(outgoing, '20261102', { file });
  assert.equal(r.added, 2);
  const back = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(back.shows['show-a'].weeks), ['20261026', '20261102']);
  assert.equal(back.lastWeek, '20261102');
  const again = hist.archiveOutgoingSchedule(outgoing, '20261102', { file });
  assert.deepEqual([again.added, again.updated], [0, 0], 'idempotent');
});

test('a show removed mid-week (closing) keeps its final week', () => {
  const file = tmpFile();
  // Monday rollover archived last week; on Thursday the show closes and the
  // next refresh drops it from the live file. Same currentMonday both times.
  hist.archiveOutgoingSchedule(snap('20261026', { 20261102: week(day('14:00', null)) }, 'closing-show'), '20261102', { file });
  const live = snap('20261102', { 20261102: week(day('14:00', '20:00')) }, 'closing-show');
  hist.archiveOutgoingSchedule(live, '20261102', { file });
  const back = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(back.shows['closing-show'].weeks['20261102'][5].e, '20:00', 'latest view of the closing week kept');
});

test('mergeShowScheduleHistory unions both writers, ours wins a shared week', () => {
  const a = hist.emptyHistory();
  hist.mergeSnapshot(a, snap('20261026', { 20261026: week(day('14:00', null)) }));
  hist.pruneAfter(a, '20261026');
  const b = hist.emptyHistory();
  hist.mergeSnapshot(b, snap('20261026', { 20261026: week(day('11:00', null)) }));
  hist.mergeSnapshot(b, snap('20261102', { 20261102: week(day('11:00', null)) }, 'show-b'));
  hist.pruneAfter(b, '20261102');
  const { merged: m } = hist.mergeShowScheduleHistory(a, b);
  assert.equal(m.shows['show-a'].weeks['20261026'][5].m, '14:00', 'ours wins');
  assert.ok(m.shows['show-b'].weeks['20261102'], 'remote-only show kept');
  assert.equal(m.lastWeek, '20261102');
  const entry = MERGE_REGISTRY.find((e) => e.file === 'show-schedule-history.json');
  assert.equal(entry && entry.merge, hist.mergeShowScheduleHistory, 'registered for push conflicts');
});

test('committed archive covers March 2026 onward (spot check Oh, Mary!)', () => {
  const h = hist.loadHistory();
  const live = JSON.parse(fs.readFileSync(path.join(path.dirname(hist.HISTORY_PATH), 'show-schedules.json'), 'utf8'));
  assert.ok(h.firstWeek && h.firstWeek <= '20260316', `firstWeek ${h.firstWeek}`);
  for (const s of Object.values(h.shows)) {
    for (const k of Object.keys(s.weeks)) assert.ok(k <= h.lastWeek, `${k} has started`);
  }
  assert.ok(h.lastWeek <= live.currentMonday, 'archive never holds weeks that have not started');
  assert.deepEqual(h.shows['oh-mary-2024']?.weeks['20260511']?.[5], { m: '17:00', e: '20:30' }, 'Sat 2026-05-16');
});

test('archiveLagWeeks: how far the archive trails the live file (validate-data warns > 1)', async () => {
  const { archiveLagWeeks } = require('../../scripts/lib/merge-show-schedule-history.js');
  assert.equal(archiveLagWeeks({ lastWeek: '20261102' }, '20261102'), 0);
  assert.equal(archiveLagWeeks({ lastWeek: '20261019' }, '20261102'), 2);
  assert.equal(archiveLagWeeks({ lastWeek: '20261228' }, '20270104'), 1, 'across a year end');
  assert.equal(archiveLagWeeks({ lastWeek: null }, '20261102'), null);
  assert.equal(archiveLagWeeks({ lastWeek: '20261102' }, undefined), null);
});

// Live check (BRO-6877 recheck): the refresh workflows must keep folding ended
// weeks into the committed archive. A writer that rolls show-schedules.json
// forward without archiving leaves the archive trailing; > 1 week means a
// whole rollover was missed (same threshold validate-data warns on).
test('committed archive keeps up with the live schedule (lag <= 1 week)', () => {
  const { archiveLagWeeks } = require('../../scripts/lib/merge-show-schedule-history.js');
  const h = hist.loadHistory();
  const live = JSON.parse(fs.readFileSync(path.join(path.dirname(hist.HISTORY_PATH), 'show-schedules.json'), 'utf8'));
  const lag = archiveLagWeeks(h, live.currentMonday);
  assert.notEqual(lag, null, 'both files carry a week key');
  assert.ok(lag <= 1, `archive lastWeek ${h.lastWeek} trails live currentMonday ${live.currentMonday} by ${lag} weeks`);
});
