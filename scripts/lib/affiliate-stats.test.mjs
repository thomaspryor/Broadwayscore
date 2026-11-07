import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildWindow, pacificMidnight, clampDays } = require('./affiliate-stats.js');

test('pacificMidnight: PDT and PST offsets', () => {
  assert.equal(pacificMidnight(new Date('2026-10-26T17:30:00Z')).toISOString(), '2026-10-26T07:00:00.000Z');
  assert.equal(pacificMidnight(new Date('2026-12-07T13:00:00Z')).toISOString(), '2026-12-07T08:00:00.000Z');
  // 03:00 UTC Monday is still Sunday evening in Pacific time
  assert.equal(pacificMidnight(new Date('2026-10-27T03:00:00Z')).toISOString(), '2026-10-26T07:00:00.000Z');
});

test('pacificMidnight: DST-change days use the offset in force at midnight', () => {
  // 2026-11-01: PDT -> PST at 02:00; midnight is still PDT (07:00Z)
  assert.equal(pacificMidnight(new Date('2026-11-01T20:00:00Z')).toISOString(), '2026-11-01T07:00:00.000Z');
  // 2026-03-08: PST -> PDT at 02:00; midnight is still PST (08:00Z)
  assert.equal(pacificMidnight(new Date('2026-03-08T20:00:00Z')).toISOString(), '2026-03-08T08:00:00.000Z');
});

test('buildWindow completeDays: last 7 whole Pacific days, send time irrelevant', () => {
  // The 2026-10-26 email: a rolling window started 10-19 mid-morning and
  // dropped two 10-19 orders that the baseline line counted.
  for (const sentAt of ['2026-10-26T13:00:00Z', '2026-10-26T17:30:00Z', '2026-10-27T06:59:00Z']) {
    const w = buildWindow(7, { completeDays: true, now: new Date(sentAt) });
    assert.equal(w.start.toISOString(), '2026-10-19T07:00:00.000Z', sentAt);
    assert.equal(w.end.toISOString(), '2026-10-26T07:00:00.000Z', sentAt);
    assert.equal(w.endBuffered.getTime(), w.end.getTime(), 'no buffer past the last whole day');
    assert.equal(w.startDate, '2026-10-19');
    assert.equal(w.endDate, '2026-10-25');
  }
});

test('buildWindow completeDays: spans a DST change without losing a day', () => {
  const w = buildWindow(7, { completeDays: true, now: new Date('2026-11-02T15:00:00Z') });
  assert.equal(w.start.toISOString(), '2026-10-26T07:00:00.000Z');
  assert.equal(w.end.toISOString(), '2026-11-02T08:00:00.000Z');
  assert.equal(w.startDate, '2026-10-26');
  assert.equal(w.endDate, '2026-11-01');
});

test('buildWindow completeDays: prior week chains onto the current one', () => {
  const cur = buildWindow(7, { completeDays: true, now: new Date('2026-10-26T13:00:00Z') });
  const prior = buildWindow(7, { completeDays: true, now: cur.start });
  assert.equal(prior.end.getTime(), cur.start.getTime());
  assert.equal(prior.startDate, '2026-10-12');
  assert.equal(prior.endDate, '2026-10-18');
});

test('buildWindow rolling (dashboard default) is unchanged', () => {
  const now = new Date('2026-10-26T17:30:00Z');
  const w = buildWindow(7, { now });
  assert.equal(w.end.getTime(), now.getTime());
  assert.equal(w.start.toISOString(), '2026-10-19T17:30:00.000Z');
  assert.equal(w.endBuffered.toISOString(), '2026-10-27T17:30:00.000Z');
});

test('clampDays keeps the buffered Impact range within its 45-day cap', () => {
  assert.equal(clampDays(45), 44);
  assert.equal(clampDays(30), 30);
  assert.equal(clampDays(0), 7);
  const w = buildWindow(clampDays(45), { now: new Date('2026-10-26T00:00:00Z') });
  assert.ok((w.endBuffered - w.start) / 86400000 <= 45);
});

test('every PostHog query applies the shared Real Users filter', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('./affiliate-stats.js', import.meta.url), 'utf8');
  const queries = (src.match(/FROM events/g) || []).length;
  assert.ok(queries >= 3);
  assert.equal((src.match(/\$\{REAL_USERS_WHERE\}/g) || []).length, queries,
    'a query on events is missing ${REAL_USERS_WHERE}, so bots/owner leak into the funnel');
});
