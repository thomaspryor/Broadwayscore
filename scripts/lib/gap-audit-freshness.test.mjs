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

// BRO-5133: a show at day 8-21 whose row still alerts must re-audit ahead of the
// back catalogue, or its stale row re-fires the daily digest for a week+.
test('alerting show inside the 21-day alert window sorts ahead of an older back-catalogue retry', () => {
  const alerting = { id: 'del-valle', status: 'open', openingDate: iso(19 * DAY) };
  const backlog = { id: 'old-closed-gap', status: 'closed', openingDate: iso(300 * DAY) };
  const checkpoint = {
    'del-valle': { at: new Date(NOW - 2 * DAY).toISOString(), uncollected: 7 },
    'old-closed-gap': { at: new Date(NOW - 30 * DAY).toISOString(), uncollected: 3 },
  };
  assert.ok(compareAuditPriority(alerting, backlog, checkpoint, NOW) < 0);
});

test('alert-window tier needs a live show with uncollected reviews on its row', () => {
  const { auditTier } = require('./gap-audit-freshness.js');
  const show = { id: 'x', status: 'open', openingDate: iso(15 * DAY) };
  assert.equal(auditTier(show, { uncollected: 1 }, NOW), 1);
  assert.equal(auditTier(show, { uncollected: 0 }, NOW), 2);
  assert.equal(auditTier(show, undefined, NOW), 1, "never audited in the alert window: check it first");
  // BRO-5513: a closed show's stale row still fires the alert, so it refreshes like a live one
  assert.equal(auditTier({ ...show, status: 'closed' }, { uncollected: 1 }, NOW), 1);
  assert.equal(auditTier({ ...show, status: 'closed' }, { uncollected: 16, alertUncollected: 0 }, NOW), 2);
  assert.equal(auditTier({ ...show, status: 'closed' }, { uncollected: 0 }, NOW), 2);
  assert.equal(auditTier({ ...show, openingDate: iso(40 * DAY) }, { uncollected: 1 }, NOW), 2);
  assert.equal(auditTier(openedToday, undefined, NOW), 0);
});

test('BRO-5513: closed in-window show with an alerting row re-audits at 12h, not 14d', () => {
  const closedAlerting = { id: 'mfm', status: 'closed', openingDate: iso(10 * DAY) };
  assert.equal(freshnessMsFor(closedAlerting, { gaps: 20, uncollected: 16 }, { freshnessHours: 12, now: NOW }), 12 * 60 * 60 * 1000);
  // census-only churn (alertUncollected 0) keeps the 14d retry
  assert.equal(freshnessMsFor(closedAlerting, { gaps: 20, uncollected: 16, alertUncollected: 0 }, { now: NOW }), 14 * DAY);
  // past the alert window it is no longer read
  const old = { id: 'o', status: 'closed', openingDate: iso(60 * DAY) };
  assert.equal(freshnessMsFor(old, { gaps: 2, uncollected: 2 }, { now: NOW }), 14 * DAY);
});

// BRO-6687: slow-market reviews trickle in over days 8-21; a clean audit on day 7
// must not drop the show behind the whole back catalogue for a week.
test('slow-market show in days 8-21 that audited clean gets its own 48h tier', () => {
  const { auditTier, SLOW_MARKET_CLEAN_TIER, SLOW_MARKET_CLEAN_FRESHNESS_MS } = require('./gap-audit-freshness.js');
  const we = { id: 'we', status: 'open', category: 'west-end', openingDate: iso(10 * DAY) };
  const clean = { at: new Date(NOW - 3 * DAY).toISOString(), gaps: 0, uncollected: 0 };
  assert.equal(auditTier(we, clean, NOW), SLOW_MARKET_CLEAN_TIER);
  assert.equal(freshnessMsFor(we, clean, { now: NOW }), SLOW_MARKET_CLEAN_FRESHNESS_MS);
  for (const category of ['off-broadway', 'off-west-end']) {
    assert.equal(auditTier({ ...we, category }, clean, NOW), SLOW_MARKET_CLEAN_TIER, category);
  }
});

test('slow-market tier leaves alerting rows, Broadway, closed and out-of-window shows unchanged', () => {
  const { auditTier } = require('./gap-audit-freshness.js');
  const we = { id: 'we', status: 'open', category: 'west-end', openingDate: iso(10 * DAY) };
  const clean = { gaps: 0, uncollected: 0 };
  assert.equal(auditTier(we, { uncollected: 2 }, NOW), 1, 'a row with a gap stays in the alerting tier');
  assert.equal(freshnessMsFor(we, { gaps: 2, uncollected: 2 }, { now: NOW }), 12 * 60 * 60 * 1000);
  assert.equal(auditTier({ ...we, category: 'broadway' }, clean, NOW), 2);
  assert.equal(freshnessMsFor({ ...we, category: 'broadway' }, clean, { now: NOW }), 12 * 60 * 60 * 1000);
  assert.equal(auditTier({ ...we, status: 'closed' }, clean, NOW), 2);
  assert.equal(auditTier({ ...we, openingDate: iso(25 * DAY) }, clean, NOW), 2);
  assert.equal(auditTier({ ...we, openingDate: iso(3 * DAY) }, clean, NOW), 0, 'priority window still wins');
  assert.equal(freshnessMsFor(we, clean, { freshnessHours: 72, now: NOW }), 72 * 60 * 60 * 1000, 'never shortens a longer configured freshness');
});

test('slow-market previews show with no openingDate uses previewsStartDate', () => {
  const { auditTier, SLOW_MARKET_CLEAN_TIER } = require('./gap-audit-freshness.js');
  const show = { id: 'p', status: 'previews', category: 'off-broadway', previewsStartDate: iso(12 * DAY) };
  assert.equal(auditTier(show, { uncollected: 0 }, NOW), SLOW_MARKET_CLEAN_TIER);
});

test('Broadway alerting row sorts ahead of a clean slow-market row, which sorts ahead of the back catalogue', () => {
  const alerting = { id: 'bway', status: 'open', category: 'broadway', openingDate: iso(15 * DAY) };
  const we = { id: 'we', status: 'open', category: 'west-end', openingDate: iso(10 * DAY) };
  const backlog = { id: 'old', status: 'open', category: 'broadway', openingDate: iso(400 * DAY) };
  const checkpoint = {
    bway: { at: new Date(NOW - 1 * DAY).toISOString(), uncollected: 3 },
    we: { at: new Date(NOW - 5 * DAY).toISOString(), uncollected: 0 },
    old: { at: new Date(NOW - 30 * DAY).toISOString(), uncollected: 0 },
  };
  assert.ok(compareAuditPriority(alerting, we, checkpoint, NOW) < 0);
  assert.ok(compareAuditPriority(we, backlog, checkpoint, NOW) < 0);
});

test('a slow-market row the rollup still alerts on (reverify only) keeps the 12h default, not 48h', () => {
  const { auditTier } = require('./gap-audit-freshness.js');
  const we = { id: 'we', status: 'open', category: 'west-end', openingDate: iso(10 * DAY) };
  const reverifyOnly = { gaps: 1, uncollected: 0, slowMarketResidual: 1 };
  assert.equal(auditTier(we, reverifyOnly, NOW), 2);
  assert.equal(freshnessMsFor(we, reverifyOnly, { now: NOW }), 12 * 60 * 60 * 1000);
});
