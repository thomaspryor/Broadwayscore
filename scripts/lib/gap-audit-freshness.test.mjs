import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  freshnessMsFor,
  inOpeningPriorityWindow,
  compareAuditPriority,
  checkpointTs,
  OPENING_WINDOW_FRESHNESS_MS,
  OPENING_WARM_FRESHNESS_MS,
} = require('./gap-audit-freshness.js');

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-07-14T20:00:00Z');
const iso = (msAgo) => new Date(NOW - msAgo).toISOString().slice(0, 10);

const openedToday = { id: 'opened-today', status: 'open', openingDate: iso(6 * 60 * 60 * 1000) };
const openedLastMonth = { id: 'opened-last-month', status: 'open', openingDate: iso(30 * DAY) };
const preOpening = { id: 'pre-opening', status: 'previews', openingDate: new Date(NOW + 3 * DAY).toISOString().slice(0, 10) };
const closedClean = { id: 'closed-clean', status: 'closed', openingDate: iso(200 * DAY) };
const closedRecentlyInWindow = { id: 'closed-in-window', status: 'closed', openingDate: iso(3 * DAY) };

test('opened-today show is in the opening priority window', () => {
  assert.equal(inOpeningPriorityWindow(openedToday, NOW), true);
});

test('far-pre-opening and month-old shows are not in the window', () => {
  assert.equal(inOpeningPriorityWindow(preOpening, NOW), false); // opens in 3 days
  assert.equal(inOpeningPriorityWindow(openedLastMonth, NOW), false);
});

test('show opening within 24h is prioritized (Talkin Broadway publishes early)', () => {
  const opensTomorrow = { id: 'opens-tomorrow', status: 'previews', openingDate: new Date(NOW + 20 * 60 * 60 * 1000).toISOString().slice(0, 10) };
  // date-only strings parse to midnight UTC; build one inside the 24h grace
  const opensSoon = { id: 'opens-soon', status: 'previews', openingDate: new Date(NOW + 12 * 60 * 60 * 1000).toISOString() };
  assert.equal(inOpeningPriorityWindow(opensSoon, NOW), true);
  // pre-opening shows get the warm cadence, not the hot one
  assert.equal(freshnessMsFor(opensSoon, { gaps: 0 }, { now: NOW }), OPENING_WARM_FRESHNESS_MS);
});

test('closed show never gets opening-window freshness even if opened recently', () => {
  assert.equal(inOpeningPriorityWindow(closedRecentlyInWindow, NOW), false);
  // closed with prior gaps → 14d retry, not 55min
  assert.equal(freshnessMsFor(closedRecentlyInWindow, { gaps: 3 }, { now: NOW }), 14 * DAY);
});

test('opening-window show re-audits every hourly run (55min freshness)', () => {
  assert.equal(freshnessMsFor(openedToday, { gaps: 0 }, { now: NOW }), OPENING_WINDOW_FRESHNESS_MS);
  assert.ok(OPENING_WINDOW_FRESHNESS_MS < 60 * 60 * 1000, 'must be under the hourly cron interval');
});

test('regular open show keeps the configured freshness hours', () => {
  assert.equal(freshnessMsFor(openedLastMonth, { gaps: 0 }, { freshnessHours: 12, now: NOW }), 12 * 60 * 60 * 1000);
});

test('closed-clean show keeps the 365d skip', () => {
  assert.equal(freshnessMsFor(closedClean, { gaps: 0 }, { now: NOW }), 365 * DAY);
});

test('opening-window show sorts ahead of a never-audited back-catalogue show', () => {
  // The starvation bug: never-audited (checkpoint ts 0) used to always win.
  const checkpoint = { 'opened-today': { at: '2026-07-14T08:00:00.000Z', gaps: 0 } };
  const neverAudited = { id: 'never-audited', status: 'closed', openingDate: iso(400 * DAY) };
  const sorted = [neverAudited, openedToday].sort((a, b) => compareAuditPriority(a, b, checkpoint, NOW));
  assert.equal(sorted[0].id, 'opened-today');
});

test('day 3-7 shows get the warm 3h freshness, not the hot 55min one', () => {
  const openedFourDaysAgo = { id: 'opened-4d', status: 'open', openingDate: iso(4 * DAY) };
  assert.equal(inOpeningPriorityWindow(openedFourDaysAgo, NOW), true);
  assert.equal(freshnessMsFor(openedFourDaysAgo, { gaps: 0 }, { now: NOW }), OPENING_WARM_FRESHNESS_MS);
});

test('malformed checkpoint timestamps read as never-audited, not NaN-skipped', () => {
  assert.equal(checkpointTs({ at: 'not-a-date', gaps: 1 }), 0);
  assert.equal(checkpointTs({ gaps: 1 }), 0);
  assert.equal(checkpointTs(undefined), 0);
  // and a corrupt entry must sort to the FRONT of the backlog, not the back
  const checkpoint = {
    'corrupt': { at: 'garbage', gaps: 1 },
    'recent': { at: '2026-07-14T00:00:00.000Z', gaps: 1 },
  };
  const corrupt = { id: 'corrupt', status: 'open', openingDate: iso(100 * DAY) };
  const recent = { id: 'recent', status: 'open', openingDate: iso(100 * DAY) };
  const sorted = [recent, corrupt].sort((a, b) => compareAuditPriority(a, b, checkpoint, NOW));
  assert.equal(sorted[0].id, 'corrupt');
});

test('invalid openingDate never enters the priority window', () => {
  assert.equal(inOpeningPriorityWindow({ id: 'x', status: 'open', openingDate: 'TBD' }, NOW), false);
  assert.equal(inOpeningPriorityWindow({ id: 'x', status: 'open', openingDate: null }, NOW), false);
  assert.equal(inOpeningPriorityWindow(null, NOW), false);
});

test('outside the window, least-recently-audited order is preserved', () => {
  const checkpoint = {
    'opened-last-month': { at: '2026-07-13T00:00:00.000Z', gaps: 1 },
    'closed-clean': { at: '2026-07-01T00:00:00.000Z', gaps: 2 },
  };
  const sorted = [openedLastMonth, closedClean].sort((a, b) => compareAuditPriority(a, b, checkpoint, NOW));
  assert.equal(sorted[0].id, 'closed-clean');
});

// BRO-4592: Arias with a Twist (open, 11d old, never audited) sat behind ~100
// never-audited back-catalogue shows because ties fell back to shows.json order.
test('never-audited ties: live show ahead of closed, newest opening first (BRO-4592)', () => {
  const arias = { id: 'arias', status: 'open', openingDate: iso(11 * DAY) };
  const purpose = { id: 'purpose', status: 'open', openingDate: iso(18 * DAY) };
  const oldClosed = { id: 'old-closed', status: 'closed', openingDate: iso(400 * DAY) };
  const oldOpen = { id: 'old-open', status: 'open', openingDate: iso(300 * DAY) };
  // Deliberately put the back-catalogue first, as in shows.json file order.
  const queue = [oldClosed, oldOpen, purpose, arias];
  queue.sort((a, b) => compareAuditPriority(a, b, {}, NOW));
  assert.deepEqual(queue.map(s => s.id), ['arias', 'purpose', 'old-open', 'old-closed']);
});

test('audit age still wins over the new tie-break', () => {
  const recentAudited = { id: 'recent', status: 'open', openingDate: iso(11 * DAY) };
  const staleAudited = { id: 'stale', status: 'closed', openingDate: iso(400 * DAY) };
  const checkpoint = {
    stale: { at: new Date(NOW - 20 * DAY).toISOString() },
    recent: { at: new Date(NOW - 1 * DAY).toISOString() },
  };
  assert.ok(compareAuditPriority(staleAudited, recentAudited, checkpoint, NOW) < 0);
});

test('undated shows sort last among ties without throwing', () => {
  const undated = { id: 'undated', status: 'open' };
  const dated = { id: 'dated', status: 'open', openingDate: iso(60 * DAY) };
  assert.ok(compareAuditPriority(dated, undated, {}, NOW) < 0);
});
