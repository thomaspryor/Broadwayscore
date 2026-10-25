// Real functions only (CLAUDE.md rule 15): diagnoseShow + classifyRows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { diagnoseShow, loadSilentGaps } = require('../../scripts/lib/digest-diagnosis.js');
const { classifyRows } = require('../../scripts/send-opening-digest.js');

const now = new Date('2026-10-11T12:00:00Z');
const hoursAgo = (h) => new Date(now.getTime() - h * 36e5).toISOString();
const row = { id: 's1', qualifies: false, qualifyGap: 'T1 1/3', broadcastOverdue: false };

test('found-but-unscored review is stuck and names the outlet', () => {
  const d = diagnoseShow({ row, now, backoffAvailable: true, backoff: { lastRunAt: hoursAgo(2) },
    silentGaps: [{ showId: 's1', type: 'unscored', outletId: 'nydailynews' }] });
  assert.equal(d.state, 'stuck');
  assert.match(d.reason, /1 found review not scored yet \(nydailynews\)/);
});

test('empty-body gap is stuck', () => {
  const d = diagnoseShow({ row, now, backoffAvailable: true, backoff: { lastRunAt: hoursAgo(2) },
    silentGaps: [{ showId: 's1', type: 'empty-body', outletId: 'a' }, { showId: 's1', type: 'empty-body', outletId: 'b' }] });
  assert.equal(d.state, 'stuck');
  assert.match(d.reason, /2 found reviews with no text loaded \(a, b\)/);
});

test('overdue but qualifying is stuck', () => {
  const d = diagnoseShow({ row: { ...row, broadcastOverdue: true, qualifies: true }, now,
    backoffAvailable: true, backoff: { lastRunAt: hoursAgo(2) }, silentGaps: [] });
  assert.equal(d.state, 'stuck');
});

test('recent poller run and no gaps is waiting, with the shortfall', () => {
  const d = diagnoseShow({ row, now, backoffAvailable: true, backoff: { lastRunAt: hoursAgo(5) }, silentGaps: [] });
  assert.deepEqual(d, { state: 'waiting', reason: 'waiting on critics, checked 5h ago (short: T1 1/3)' });
});

test('poller silent for 4 days, or never recorded, is stuck', () => {
  const stale = diagnoseShow({ row, now, backoffAvailable: true, backoff: { lastRunAt: hoursAgo(96) }, silentGaps: [] });
  assert.equal(stale.state, 'stuck');
  assert.match(stale.reason, /4d ago/);
  const none = diagnoseShow({ row, now, backoffAvailable: true, backoff: null, silentGaps: [] });
  assert.equal(none.state, 'stuck');
});

test('no backoff data at all fails open (null, row keeps old treatment)', () => {
  assert.equal(diagnoseShow({ row, now, backoffAvailable: false, backoff: null, silentGaps: null }), null);
});

test('stale silent-gaps file is ignored', () => {
  assert.equal(loadSilentGaps({ generatedAt: hoursAgo(80), gaps: [{ showId: 's1' }] }, now), null);
  assert.deepEqual(loadSilentGaps({ generatedAt: hoursAgo(3), gaps: [{ showId: 's1' }] }, now), [{ showId: 's1' }]);
  assert.equal(loadSilentGaps(null, now), null);
});

test('classifyRows: waiting rows leave Needs help, stuck rows stay with the real reason', () => {
  const base = { daysFromToday: -4, excluded: false, important: true, broadcastEligible: true,
    qualifies: false, broadcastSent: false, broadcastDiscarded: false, reviewCount: 2, expected: 20, t1Count: 0 };
  const rows = [{ ...base, id: 'wait' }, { ...base, id: 'stuck' }];
  const out = classifyRows(rows, (r) => r.id === 'wait'
    ? { state: 'waiting', reason: 'waiting on critics, checked 3h ago' }
    : { state: 'stuck', reason: '1 found review not scored yet (x)' });
  assert.deepEqual(out.needsHelp.map(r => r.id), ['stuck']);
  assert.deepEqual(out.needsHelp[0].helpReasons, ['1 found review not scored yet (x)']);
  assert.deepEqual(out.otherRecent.map(r => r.id), ['wait']);
  assert.equal(out.otherRecent[0].waitingNote, 'waiting on critics, checked 3h ago');
  // no diagnosis function => old behaviour unchanged
  assert.deepEqual(classifyRows(rows).needsHelp.map(r => r.id), ['wait', 'stuck']);
});
