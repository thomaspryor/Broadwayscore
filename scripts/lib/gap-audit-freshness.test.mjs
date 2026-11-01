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
  const openedTenDays = { id: 'ten', status: 'open', openingDate: iso(10 * DAY) };
  assert.equal(freshnessMsFor(openedTenDays, { gaps: 0 }, { freshnessHours: 12, now: NOW }), 12 * 60 * 60 * 1000);
});

test('BRO-6751: an open show more than 30 days past opening re-audits weekly', () => {
  const week = 7 * DAY;
  const mature = { id: 'm', status: 'open', openingDate: iso(45 * DAY) };
  assert.equal(freshnessMsFor(mature, { gaps: 0 }, { freshnessHours: 12, now: NOW }), week);
  assert.equal(freshnessMsFor(mature, { gaps: 2, uncollected: 2 }, { now: NOW }), week);
  // a long-runner from years ago too
  assert.equal(freshnessMsFor({ ...mature, openingDate: iso(3000 * DAY) }, { gaps: 0 }, { now: NOW }), week);
  // no opening date: first preview counts; no date at all or a future opening stays at 12h
  assert.equal(freshnessMsFor({ id: 'p', status: 'previews', previewsStartDate: iso(60 * DAY) }, { gaps: 0 }, { now: NOW }), week);
  assert.equal(freshnessMsFor({ id: 'n', status: 'open' }, { gaps: 0 }, { now: NOW }), 12 * 60 * 60 * 1000);
  assert.equal(freshnessMsFor({ id: 'f', status: 'previews', openingDate: new Date(NOW + 40 * DAY).toISOString().slice(0, 10) }, { gaps: 0 }, { now: NOW }), 12 * 60 * 60 * 1000);
});

test('closed-clean show keeps the 365d skip', () => {
  // BRO-6687: shows from the last year cap at 30d; older ones keep the 365d skip.
  const olderClean = { ...closedClean, openingDate: iso(400 * DAY) };
  assert.equal(freshnessMsFor(olderClean, { gaps: 0 }, { now: NOW }), 365 * DAY);
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
  // BRO-6687: recently audited (an undated entry reads as stale -> tier 1.75)
  const fresh = new Date(NOW - DAY).toISOString();
  assert.equal(auditTier(show, { at: fresh, uncollected: 0 }, NOW), 2);
  assert.equal(auditTier(show, undefined, NOW), 1, "never audited in the alert window: check it first");
  // BRO-5513: a closed show's stale row still fires the alert, so it refreshes like a live one
  assert.equal(auditTier({ ...show, status: 'closed' }, { uncollected: 1 }, NOW), 1);
  assert.equal(auditTier({ ...show, status: 'closed' }, { at: fresh, uncollected: 16, alertUncollected: 0 }, NOW), 2);
  assert.equal(auditTier({ ...show, status: 'closed' }, { at: fresh, uncollected: 0 }, NOW), 2);
  assert.equal(auditTier({ ...show, openingDate: iso(40 * DAY) }, { at: fresh, uncollected: 1 }, NOW), 2);
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

// BRO-6687: slow-market reviews trickle in over days 8-21; every in-window show
// (open or closed) re-audits at least daily in its own tier.
test('slow-market show in days 8-21 gets its own tier and a daily re-audit', () => {
  const { auditTier, SLOW_MARKET_TIER, SLOW_MARKET_DAILY_FRESHNESS_MS } = require('./gap-audit-freshness.js');
  const we = { id: 'we', status: 'open', category: 'west-end', openingDate: iso(10 * DAY) };
  const clean = { at: new Date(NOW - 3 * DAY).toISOString(), gaps: 0, uncollected: 0 };
  assert.equal(auditTier(we, clean, NOW), SLOW_MARKET_TIER);
  assert.equal(freshnessMsFor(we, clean, { now: NOW }), SLOW_MARKET_DAILY_FRESHNESS_MS);
  assert.ok(SLOW_MARKET_DAILY_FRESHNESS_MS < DAY, 'daily means under 24h so an hourly cron never skips a day');
  assert.equal(freshnessMsFor(we, clean, { freshnessHours: 72, now: NOW }), SLOW_MARKET_DAILY_FRESHNESS_MS, 'caps a longer configured freshness');
  for (const category of ['off-broadway', 'off-west-end']) {
    assert.equal(auditTier({ ...we, category }, clean, NOW), SLOW_MARKET_TIER, category);
  }
  // a row the rollup still counts (residual, no uncollected) is in the tier too, at the shorter 12h
  assert.equal(auditTier(we, { gaps: 1, uncollected: 0, slowMarketResidual: 1 }, NOW), SLOW_MARKET_TIER);
  assert.equal(freshnessMsFor(we, { gaps: 1, uncollected: 0, slowMarketResidual: 1 }, { now: NOW }), 12 * 60 * 60 * 1000);
});

test('closed slow-market show inside the window still re-audits daily (no 365d/14d skip)', () => {
  const { auditTier, SLOW_MARKET_TIER, SLOW_MARKET_DAILY_FRESHNESS_MS } = require('./gap-audit-freshness.js');
  const closed = { id: 'c', status: 'closed', category: 'off-west-end', openingDate: iso(12 * DAY) };
  assert.equal(auditTier(closed, { gaps: 0, uncollected: 0 }, NOW), SLOW_MARKET_TIER);
  assert.equal(freshnessMsFor(closed, { gaps: 0, uncollected: 0 }, { now: NOW }), SLOW_MARKET_DAILY_FRESHNESS_MS);
  assert.equal(freshnessMsFor(closed, { gaps: 3, uncollected: 0 }, { now: NOW }), SLOW_MARKET_DAILY_FRESHNESS_MS);
  // outside the window the closed skips come back (BRO-6751: a clean closed show
  // past its first month keeps the 365d skip; only one closed in its first month
  // keeps the 30d last-year cap)
  const fresh = new Date(NOW - DAY).toISOString();
  assert.equal(freshnessMsFor({ ...closed, openingDate: iso(40 * DAY) }, { gaps: 0 }, { now: NOW }), 365 * DAY);
  assert.equal(freshnessMsFor({ ...closed, openingDate: iso(25 * DAY) }, { gaps: 0 }, { now: NOW }), 30 * DAY);
  assert.equal(freshnessMsFor({ ...closed, openingDate: iso(400 * DAY) }, { gaps: 0 }, { now: NOW }), 365 * DAY);
  assert.equal(auditTier({ ...closed, openingDate: iso(40 * DAY) }, { at: fresh, gaps: 0 }, NOW), 2);
});

test('slow-market tier leaves alerting rows, Broadway and out-of-window shows unchanged', () => {
  const { auditTier } = require('./gap-audit-freshness.js');
  const we = { id: 'we', status: 'open', category: 'west-end', openingDate: iso(10 * DAY) };
  const clean = { at: new Date(NOW - DAY).toISOString(), gaps: 0, uncollected: 0 };
  assert.equal(auditTier(we, { uncollected: 2 }, NOW), 1, 'a row with a gap stays in the alerting tier');
  assert.equal(freshnessMsFor(we, { gaps: 2, uncollected: 2 }, { now: NOW }), 12 * 60 * 60 * 1000);
  assert.equal(auditTier({ ...we, category: 'broadway' }, clean, NOW), 2);
  assert.equal(freshnessMsFor({ ...we, category: 'broadway' }, clean, { now: NOW }), 12 * 60 * 60 * 1000);
  assert.equal(freshnessMsFor({ ...we, category: 'broadway' }, clean, { freshnessHours: 72, now: NOW }), 72 * 60 * 60 * 1000);
  assert.equal(auditTier({ ...we, openingDate: iso(25 * DAY) }, clean, NOW), 2);
  assert.equal(auditTier({ ...we, openingDate: iso(3 * DAY) }, clean, NOW), 0, 'priority window still wins');
  assert.equal(freshnessMsFor({ ...we, openingDate: iso(1 * DAY) }, clean, { now: NOW }), 55 * 60 * 1000, 'hot window keeps its hourly freshness');
});

test('slow-market previews show with no openingDate uses previewsStartDate', () => {
  const { auditTier, SLOW_MARKET_TIER } = require('./gap-audit-freshness.js');
  const show = { id: 'p', status: 'previews', category: 'off-broadway', previewsStartDate: iso(12 * DAY) };
  assert.equal(auditTier(show, { uncollected: 0 }, NOW), SLOW_MARKET_TIER);
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


// BRO-6687: targeted runs append the head of the due queue (tiers < 2) after their list.
test('pickDueLane picks overdue tier 0-1.5 shows, never requested or back-catalogue ones', () => {
  const { pickDueLane, DUE_LANE_CAP } = require('./gap-audit-freshness.js');
  const ago = (ms) => new Date(NOW - ms).toISOString();
  const shows = [
    { id: 'hot', status: 'open', category: 'broadway', openingDate: iso(1 * DAY) },          // tier 0, 55m freshness
    { id: 'we', status: 'open', category: 'west-end', openingDate: iso(10 * DAY) },          // tier 1.5
    { id: 'weFresh', status: 'open', category: 'west-end', openingDate: iso(11 * DAY) },     // tier 1.5, fresh
    { id: 'closedOwe', status: 'closed', category: 'off-west-end', openingDate: iso(15 * DAY) }, // tier 1.5 closed
    { id: 'old', status: 'open', category: 'broadway', openingDate: iso(400 * DAY) },        // tier 2
    { id: 'req', status: 'open', category: 'west-end', openingDate: iso(9 * DAY) },          // requested
  ];
  const checkpoint = {
    hot: { at: ago(2 * 60 * 60 * 1000), uncollected: 0 },
    we: { at: ago(30 * 60 * 60 * 1000), uncollected: 0, gaps: 0 },
    weFresh: { at: ago(2 * 60 * 60 * 1000), uncollected: 0, gaps: 0 },
    closedOwe: { at: ago(3 * DAY), uncollected: 0, gaps: 0 },
    old: { at: ago(300 * DAY), uncollected: 0 },
    req: { at: ago(5 * DAY), uncollected: 0 },
  };
  const ids = pickDueLane(shows, checkpoint, ['req'], { now: NOW }).map((s) => s.id);
  assert.deepEqual(ids, ['hot', 'closedOwe', 'we'].slice(0, DUE_LANE_CAP));
  assert.ok(!ids.includes('old') && !ids.includes('req') && !ids.includes('weFresh'));
  assert.deepEqual(pickDueLane(shows, checkpoint, [], { now: NOW, cap: 1 }).map((s) => s.id), ['hot']);
  assert.deepEqual(pickDueLane(shows, checkpoint, [], { now: NOW, cap: 0 }), []);
});

// BRO-6687 (owner scope 2026-10-31): every show from the last year, all markets,
// gets audited. Unaudited or 14d-stale last-year shows sort in tier 1.75 (after
// the urgent tiers, ahead of the 3-year back catalogue); freshness caps at 30d.
test('last-year show: tier 1.75 when unaudited or 14d stale, tier 2 when recently audited', () => {
  const { auditTier, LAST_YEAR_TIER } = require('./gap-audit-freshness.js');
  const ago = (ms) => new Date(NOW - ms).toISOString();
  const ob = { id: 'ob', status: 'closed', category: 'off-broadway', openingDate: iso(200 * DAY) };
  assert.equal(LAST_YEAR_TIER, 1.75);
  assert.equal(auditTier(ob, undefined, NOW), LAST_YEAR_TIER);
  assert.equal(auditTier(ob, { at: ago(15 * DAY), uncollected: 0 }, NOW), LAST_YEAR_TIER);
  assert.equal(auditTier(ob, { at: ago(13 * DAY), uncollected: 0 }, NOW), 2);
  // older than a year: unchanged back catalogue
  const older = { ...ob, id: 'older', openingDate: iso(400 * DAY) };
  assert.equal(auditTier(older, undefined, NOW), 2);
  // urgent tiers keep precedence
  assert.equal(auditTier(openedToday, undefined, NOW), 0);
});

test('BRO-6751: last-year closed show keeps the 30d cap only while it has gaps or closed in its first month', () => {
  const { LAST_YEAR_MAX_FRESHNESS_MS } = require('./gap-audit-freshness.js');
  const clean = { gaps: 0, uncollected: 0 };
  assert.equal(freshnessMsFor(closedClean, clean, { now: NOW }), 365 * DAY);
  assert.equal(freshnessMsFor(closedClean, { gaps: 2, uncollected: 0 }, { now: NOW }), 14 * DAY);
  const shortRun = { id: 'short', status: 'closed', category: 'broadway', openingDate: iso(10 * DAY) };
  assert.equal(freshnessMsFor(shortRun, clean, { now: NOW }), LAST_YEAR_MAX_FRESHNESS_MS);
  const older = { id: 'older', status: 'closed', openingDate: iso(400 * DAY) };
  assert.ok(freshnessMsFor(older, clean, { now: NOW }) > LAST_YEAR_MAX_FRESHNESS_MS);
  // a shorter cadence is never lengthened
  assert.equal(freshnessMsFor(openedToday, undefined, { now: NOW }), OPENING_WINDOW_FRESHNESS_MS);
});

test('last-year stale show sorts after urgent tiers and ahead of back catalogue; pickDueLane skips it', () => {
  const { pickDueLane } = require('./gap-audit-freshness.js');
  const lastYear = { id: 'ly', status: 'closed', category: 'off-west-end', openingDate: iso(120 * DAY) };
  const catalogue = { id: 'cat', status: 'closed', category: 'broadway', openingDate: iso(700 * DAY) };
  const checkpoint = {};
  assert.ok(compareAuditPriority(lastYear, catalogue, checkpoint, NOW) < 0);
  assert.ok(compareAuditPriority(openedToday, lastYear, checkpoint, NOW) < 0);
  assert.deepEqual(pickDueLane([lastYear, catalogue], checkpoint, [], { now: NOW }), []);
});

test('schedulingCheckpoint drops entries with no gap row', () => {
  const { schedulingCheckpoint, gapRowShowIds } = require('./gap-audit-freshness.js');
  const gap = { results: [{ showId: 'a' }, { showId: 'q', quarantined: true }, null, {}] };
  const ids = gapRowShowIds(gap);
  assert.ok(ids.has('a') && ids.has('q'));
  const cp = { a: { at: 'x' }, q: { at: 'y' }, rowless: { at: 'z' } };
  assert.deepEqual(Object.keys(schedulingCheckpoint(cp, ids)).sort(), ['a', 'q']);
  // absent/empty gap file: no-op copy (never treat everything as unaudited)
  assert.deepEqual(schedulingCheckpoint(cp, new Set()), cp);
  assert.deepEqual(schedulingCheckpoint(cp, null), cp);
  assert.deepEqual(schedulingCheckpoint(undefined, ids), {});
  // a recent rowless stamp (cancelled run, partial gap file) is kept; only old ones drop
  const now = Date.parse('2026-10-31T12:00:00Z');
  const cp2 = { a: { at: '2026-06-01T00:00:00Z' }, recent: { at: '2026-10-25T00:00:00Z' }, old: { at: '2026-07-01T00:00:00Z' } };
  assert.deepEqual(Object.keys(schedulingCheckpoint(cp2, ids, now)).sort(), ['a', 'recent']);
});
