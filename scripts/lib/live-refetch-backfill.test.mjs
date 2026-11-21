import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const {
  selectBackfillWindow, diffLiveVsArchive, summarizeBackfill,
  emptyCheckpoint, isDone, recordDone, completedResults,
} = require('./live-refetch-backfill.js');

const NOW = Date.parse('2026-07-30T12:00:00.000Z');
const show = (id, openingDate, extra = {}) => ({ id, title: id, openingDate, category: 'broadway', status: 'open', ...extra });

// --- window selection -------------------------------------------------------

test('selectBackfillWindow takes openings inside the window and drops older ones', () => {
  const shows = [
    show('in-window', '2026-07-01'),
    show('edge-of-window', '2026-05-01'),      // exactly 90 days back
    show('too-old', '2026-01-01'),
    show('evergreen', '1996-11-14'),           // status open but ancient
  ];
  const ids = selectBackfillWindow(shows, { days: 90, nowMs: NOW }).map((s) => s.id);
  assert.ok(ids.includes('in-window'));
  assert.ok(ids.includes('edge-of-window'));
  assert.ok(!ids.includes('too-old'));
  assert.ok(!ids.includes('evergreen'), 'a long-running revival must not drag into a 90-day backfill');
});

test('an undated non-closed show IS included — that is the Broad Strokes signature', () => {
  const shows = [show('broad-strokes', null, { status: 'previews' }), show('closed-undated', null, { status: 'closed' })];
  const ids = selectBackfillWindow(shows, { days: 90, nowMs: NOW }).map((s) => s.id);
  assert.deepEqual(ids, ['broad-strokes'],
    'excluding null-date shows would reproduce the exact selector blind spot this backfill tests');
  assert.deepEqual(selectBackfillWindow(shows, { days: 90, nowMs: NOW, includeUndated: false }).map(s => s.id), [],
    '--no-undated opt-out still available');
});

test('selection is deterministic (oldest first) with undated shows last', () => {
  const shows = [show('c', '2026-07-20'), show('undated', null, { status: 'previews' }), show('a', '2026-06-01'), show('b', '2026-07-01')];
  assert.deepEqual(selectBackfillWindow(shows, { days: 90, nowMs: NOW }).map((s) => s.id),
    ['a', 'b', 'c', 'undated'],
    'a resumed run must walk the same order; cheap dated shows before undated ones');
});

test('market filter narrows by category', () => {
  const shows = [show('bway', '2026-07-01'), show('we', '2026-07-01', { category: 'west-end' })];
  assert.deepEqual(selectBackfillWindow(shows, { days: 90, nowMs: NOW, markets: ['west-end'] }).map((s) => s.id), ['we']);
});

// --- the three-way diff -----------------------------------------------------

test('newlyExpected is what the ARCHIVE could not know to want (blind spot #2)', () => {
  // The archived roundup named 2 outlets; the live roundup has since grown to 4.
  const d = diffLiveVsArchive({
    liveOutletIds: ['nytimes', 'vulture', 'timeout', 'nypost'],
    archiveOutletIds: ['nytimes', 'vulture'],
    scoredOutletIds: ['nytimes'],
  });
  assert.deepEqual(d.newlyExpected, ['nypost', 'timeout'], 'the reviews the roundup gained after we archived it');
  assert.deepEqual(d.stillMissing, ['nypost', 'timeout', 'vulture'], 'named live but not scored on the site');
  assert.deepEqual(d.drained, ['nytimes'], 'already healthy');
  assert.equal(d.liveCount, 4);
  assert.equal(d.archiveCount, 2);
});

test('no archive at all (blind spot #1): everything live is newly expected', () => {
  const d = diffLiveVsArchive({
    liveOutletIds: ['nytimes', 'vulture'], archiveOutletIds: [], scoredOutletIds: [],
  });
  assert.deepEqual(d.newlyExpected, ['nytimes', 'vulture']);
  assert.equal(d.archiveCount, 0);
  assert.deepEqual(d.stillMissing, ['nytimes', 'vulture']);
});

test('a fully-drained show reports drained without inventing gaps', () => {
  const d = diffLiveVsArchive({
    liveOutletIds: ['nytimes', 'vulture'], archiveOutletIds: ['nytimes', 'vulture'],
    scoredOutletIds: ['nytimes', 'vulture', 'extra-not-in-roundup'],
  });
  assert.deepEqual(d.stillMissing, []);
  assert.deepEqual(d.newlyExpected, []);
  assert.deepEqual(d.drained, ['nytimes', 'vulture']);
});

test('isTierOutlet filter drops T3/junk from BOTH sides, and duplicates collapse', () => {
  const d = diffLiveVsArchive({
    liveOutletIds: ['nytimes', 'nytimes', 'some-blog', 'buy-tickets-directly-from-the-theatre'],
    archiveOutletIds: ['some-blog'],
    scoredOutletIds: [],
    isTierOutlet: (id) => id === 'nytimes',
  });
  assert.deepEqual(d.newlyExpected, ['nytimes'], 'junk census ids must not become backfill work');
  assert.equal(d.liveCount, 1, 'deduped');
  assert.equal(d.archiveCount, 0, 'the archive side is tier-filtered too');
});

// --- summary ----------------------------------------------------------------

test('summarizeBackfill separates "fetched nothing" from "found nothing"', () => {
  const rows = [
    { showId: 'grown', liveCount: 4, archiveCount: 2, newlyExpected: ['a', 'b'], stillMissing: ['a'], drained: ['x', 'y'] },
    { showId: 'invisible', liveCount: 2, archiveCount: 0, newlyExpected: ['c', 'd'], stillMissing: ['c', 'd'], drained: [] },
    { showId: 'clean', liveCount: 3, archiveCount: 3, newlyExpected: [], stillMissing: [], drained: ['x', 'y', 'z'] },
    { showId: 'fetch-failed', liveCount: 0, archiveCount: 0, newlyExpected: [], stillMissing: [], drained: [] },
  ];
  const s = summarizeBackfill(rows);
  assert.equal(s.showsProcessed, 4);
  assert.equal(s.showsWithLiveCensus, 3);
  assert.equal(s.showsWithNoLiveCensus, 1, 'a failed fetch is NOT evidence of completeness');
  assert.equal(s.drained, 5);
  assert.equal(s.stillMissing, 3);
  assert.equal(s.newlyExpected, 4);
  assert.equal(s.showsInvisibleToArchive, 1);
  assert.equal(s.showsWithGrownRoundup, 1);
  assert.deepEqual(s.shows.map((r) => r.showId), ['grown', 'invisible'], 'only shows with findings are listed');
});

test('summarizeBackfill on an empty run is all zeros, no throw', () => {
  const s = summarizeBackfill([]);
  assert.equal(s.showsProcessed, 0);
  assert.equal(s.stillMissing, 0);
  assert.deepEqual(s.shows, []);
});

// --- checkpointing ----------------------------------------------------------

test('checkpoint records progress, is immutable, and a resume skips completed shows', () => {
  let cp = emptyCheckpoint();
  assert.equal(isDone(cp, 'a'), false);
  const before = JSON.stringify(cp);

  cp = recordDone(cp, 'a', { liveCount: 3, stillMissing: ['x'] }, '2026-07-30T00:00:00.000Z');
  assert.equal(JSON.stringify(emptyCheckpoint()), before, 'recordDone must not mutate its input');
  assert.equal(isDone(cp, 'a'), true);
  assert.equal(isDone(cp, 'b'), false);
  assert.equal(cp.startedAt, '2026-07-30T00:00:00.000Z');

  cp = recordDone(cp, 'b', { liveCount: 0 }, '2026-07-30T01:00:00.000Z');
  assert.equal(cp.startedAt, '2026-07-30T00:00:00.000Z', 'startedAt is stamped once, not per show');
  assert.deepEqual(completedResults(cp).map((r) => r.showId), ['a', 'b']);
  assert.deepEqual(completedResults(cp)[0].stillMissing, ['x'], 'results survive the round-trip for the final summary');
});

test('isDone / completedResults tolerate a missing or corrupt checkpoint file', () => {
  assert.equal(isDone(null, 'a'), false);
  assert.equal(isDone({}, 'a'), false);
  assert.deepEqual(completedResults(null), []);
  assert.deepEqual(completedResults({ done: null }), []);
  // A corrupt read must still produce a usable checkpoint, not throw.
  const cp = recordDone('not-an-object', 'a', {}, 'now');
  assert.equal(isDone(cp, 'a'), true);
});
