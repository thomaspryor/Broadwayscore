import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { listAvailableDates, diffSnapshots, resolveMoversForWeek, latestMovers } = require('./award-score-movers.js');

function makeHistoryDir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'award-score-history-test-'));
  for (const [name, data] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), JSON.stringify(data));
  }
  return dir;
}

function snapshot(shows) {
  return { snapshotDate: '2026-01-01', market: 'broadway', shows };
}

test('diffSnapshots: ranks by absolute delta, drops unchanged shows', () => {
  const before = snapshot({
    a: { title: 'A', displayScore: 50, badge: 'nominated' },
    b: { title: 'B', displayScore: 30, badge: 'eligible' },
    c: { title: 'C', displayScore: 40, badge: 'honored' },
  });
  const after = snapshot({
    a: { title: 'A', displayScore: 55, badge: 'nominated' },
    b: { title: 'B', displayScore: 30, badge: 'eligible' }, // unchanged
    c: { title: 'C', displayScore: 20, badge: 'nominated' },
  });
  const { movers, movedCount } = diffSnapshots(before, after, 5);
  assert.equal(movedCount, 2);
  assert.deepEqual(movers.map((m) => m.showId), ['c', 'a']); // |{-20}| > |{+5}|
  assert.equal(movers[0].delta, -20);
  assert.equal(movers[0].presentBefore, true);
  assert.equal(movers[0].presentAfter, true);
});

test('diffSnapshots: a show leaving the pool reads as a full drop to 0', () => {
  const before = snapshot({ x: { title: 'X', displayScore: 80, badge: 'sweeper' } });
  const after = snapshot({});
  const { movers } = diffSnapshots(before, after, 5);
  assert.equal(movers.length, 1);
  assert.equal(movers[0].after, 0);
  assert.equal(movers[0].presentAfter, false);
  assert.equal(movers[0].badge, 'sweeper'); // falls back to BEFORE's badge
});

test('diffSnapshots: caps to top N', () => {
  const before = snapshot({ a: { title: 'A', displayScore: 0 }, b: { title: 'B', displayScore: 0 }, c: { title: 'C', displayScore: 0 } });
  const after = snapshot({ a: { title: 'A', displayScore: 10 }, b: { title: 'B', displayScore: 20 }, c: { title: 'C', displayScore: 30 } });
  const { movers } = diffSnapshots(before, after, 2);
  assert.equal(movers.length, 2);
  assert.deepEqual(movers.map((m) => m.showId), ['c', 'b']);
});

test('resolveMoversForWeek: exact week-start match required, errors otherwise', () => {
  const dir = makeHistoryDir({ '2026-05-23.json': snapshot({ a: { title: 'A', displayScore: 50 } }) });
  const result = resolveMoversForWeek({ historyDir: dir, weekStart: '2026-06-01', end: null, market: 'broadway', top: 5 });
  assert.match(result.error, /no snapshot for week-start 2026-06-01/);
});

test('resolveMoversForWeek: only one snapshot returns empty movers + note, not an error', () => {
  const dir = makeHistoryDir({ '2026-05-23.json': snapshot({ a: { title: 'A', displayScore: 50 } }) });
  const result = resolveMoversForWeek({ historyDir: dir, weekStart: '2026-05-23', end: null, market: 'broadway', top: 5 });
  assert.equal(result.error, undefined);
  assert.deepEqual(result.movers, []);
  assert.match(result.note, /only one snapshot/);
});

test('resolveMoversForWeek: picks the latest snapshot on/after week-start when --end omitted', () => {
  const dir = makeHistoryDir({
    '2026-05-23.json': snapshot({ a: { title: 'A', displayScore: 50 } }),
    '2026-06-01.json': snapshot({ a: { title: 'A', displayScore: 60 } }),
  });
  const result = resolveMoversForWeek({ historyDir: dir, weekStart: '2026-05-23', end: null, market: 'broadway', top: 5 });
  assert.equal(result.weekEnd, '2026-06-01');
  assert.equal(result.movers[0].delta, 10);
});

test('latestMovers: null when fewer than 2 snapshots exist (newsletter must skip gracefully)', () => {
  const dir = makeHistoryDir({ '2026-05-23.json': snapshot({ a: { title: 'A', displayScore: 50 } }) });
  assert.equal(latestMovers({ historyDir: dir, market: 'broadway', top: 5 }), null);
  assert.equal(latestMovers({ historyDir: fs.mkdtempSync(path.join(os.tmpdir(), 'award-score-history-empty-')), market: 'broadway', top: 5 }), null);
});

test('latestMovers: diffs the two most recent snapshots regardless of calendar alignment', () => {
  const dir = makeHistoryDir({
    '2026-05-23.json': snapshot({ a: { title: 'A', displayScore: 50, badge: 'nominated' } }),
    '2026-09-16.json': snapshot({ a: { title: 'A', displayScore: 72, badge: 'decorated' } }),
  });
  const result = latestMovers({ historyDir: dir, market: 'broadway', top: 5 });
  assert.equal(result.weekStart, '2026-05-23');
  assert.equal(result.weekEnd, '2026-09-16');
  assert.equal(result.movers[0].delta, 22);
});

test('listAvailableDates: west-end market suffix parsing does not pick up broadway files', () => {
  const dir = makeHistoryDir({
    '2026-05-23.json': snapshot({}),
    '2026-05-23-west-end.json': snapshot({}),
  });
  assert.deepEqual(listAvailableDates(dir, 'broadway'), ['2026-05-23']);
  assert.deepEqual(listAvailableDates(dir, 'west-end'), ['2026-05-23']);
});
