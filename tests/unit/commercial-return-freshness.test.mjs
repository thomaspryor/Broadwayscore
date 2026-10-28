import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { returnSnapshotDate, returnSnapshotLabel } = require('../../scripts/lib/commercial-return-snapshot');
const { findStaleReturns, queueStaleReturns } = require('../../scripts/lib/commercial-return-freshness');
const { isReviewHold } = require('../../scripts/lib/commercial-apply-gate');

const now = new Date('2026-10-27T12:00:00Z');
const show = { id: 'example-2025', slug: 'example', status: 'open', category: 'broadway', type: 'musical', openingDate: '2025-01-01' };
const entry = { designation: 'Trickle', recouped: true, recoupedDate: '2026-05', capitalization: 10_000_000, weeklyRunningCost: 600_000, analystRecoupPct: [100, 110], analystRecoupAsOf: '2026-06-01' };
const history = { weeks: {
  '2026-05-31': { example: { gross: 99_000_000 } },
  '2026-06-07': { example: { gross: 2_000_000 } },
  '2026-06-14': { example: { gross: 0 } },
  '2026-11-01': { example: { gross: 99_000_000 } },
} };
const scan = (e = entry, s = show, h = history) => findStaleReturns({ shows: [s], commercial: { shows: { example: e } }, grossesHistory: h, now });

test('snapshot uses dated return evidence, never a model run or record update', () => {
  assert.equal(returnSnapshotDate({ ...entry, lastUpdated: '2026-10-27', modelLastRun: '2026-10-27' }, now), '2026-06-01');
  assert.equal(returnSnapshotDate({ ...entry, analystRecoupPct: [80, 90] }, now), '2026-05');
  assert.equal(returnSnapshotDate({ ...entry, analystRecoupAsOf: '2027-01-01' }, now), '2026-05');
  assert.equal(returnSnapshotDate({ ...entry, analystRecoupAsOf: '2026-02-30', recoupedDate: 'bogus' }, now), null);
});

test('running Trickle and Windfall labels carry a date; closed and other labels do not', () => {
  assert.equal(returnSnapshotLabel(entry, show, now), 'as of Jun 2026');
  assert.equal(returnSnapshotLabel({ ...entry, designation: 'Windfall', analystRecoupPct: [160, 170] }, show, now), 'as of Jun 2026');
  assert.equal(returnSnapshotLabel({ ...entry, designation: 'Windfall' }, show, now), null, 'recoupment alone cannot date a later Windfall label');
  assert.equal(returnSnapshotDate({ ...entry, analystRecoupPct: [160, 170] }, now), '2026-05', 'a conflicting newer return cannot date the Trickle label');
  for (const s of [{ ...show, status: 'closed' }, { ...show, closingDate: '2026-10-01' }]) assert.equal(returnSnapshotLabel(entry, s, now), null);
  assert.equal(returnSnapshotLabel({ ...entry, designation: 'Miracle' }, show, now), null);
});

test('stale running recouped Trickles are review candidates, including ones below 1.5x', () => {
  const [candidate] = scan();
  assert.equal(candidate.slug, 'example');
  assert.equal(candidate.snapshotAsOf, '2026-06-01');
  assert.equal(candidate.estimate.grossSinceRecoupment, 2_000_000);
  assert.equal(candidate.estimate.weeksObserved, 2);
  assert.equal(candidate.estimate.possibleWindfall, false);
  assert.ok(candidate.estimate.missingWeeks > 0);
});

test('90 days is not stale; 91 days is stale', () => {
  assert.equal(scan({ ...entry, analystRecoupAsOf: '2026-07-29' }).length, 0);
  assert.equal(scan({ ...entry, analystRecoupAsOf: '2026-07-28' }).length, 1);
});

test('closed, other-market, unrecouped, Windfall and future-recoupment records are excluded', () => {
  for (const s of [{ ...show, status: 'closed' }, { ...show, category: 'off-broadway' }, { ...show, closingDate: '2026-10-01' }]) assert.equal(scan(entry, s).length, 0);
  for (const e of [{ ...entry, recouped: false }, { ...entry, designation: 'Windfall' }, { ...entry, recoupedDate: '2027-01' }]) assert.equal(scan(e).length, 0);
});

test('missing costs use the shared category estimate; missing grosses never imply a crossing', () => {
  const [fallback] = scan({ ...entry, weeklyRunningCost: null });
  assert.equal(fallback.estimate.usesEstimatedCost, true);
  const [missing] = scan(entry, show, { weeks: {} });
  assert.equal(missing.estimate.investorMultiple, null);
  assert.equal(missing.estimate.possibleWindfall, null);
  const [undatedRecoupment] = scan({ ...entry, recoupedDate: null });
  assert.equal(undatedRecoupment.snapshotAsOf, '2026-06-01');
  assert.equal(undatedRecoupment.estimate.investorMultiple, null, 'missing recoupment date needs review, not an invented gross window');
});

test('grosses only resolve this production and large profits flag a possible crossing', () => {
  const h = { weeks: { '2026-06-07': { example: { gross: 30_000_000 }, 'example-2010': { gross: 999_000_000 } } } };
  const [candidate] = scan(entry, show, h);
  assert.equal(candidate.estimate.grossSinceRecoupment, 30_000_000);
  assert.equal(candidate.estimate.possibleWindfall, true);
});

test('queue holds cannot auto-apply, preserve other research and deduplicate reruns and reviewed snapshots', () => {
  const candidates = scan().map(c => ({ ...c, estimate: { ...c.estimate, possibleWindfall: true } }));
  const pending = { shows: { example: { notes: 'Existing research', capitalization: 123 } } };
  const first = queueStaleReturns(pending, { shows: {} }, candidates, now);
  assert.equal(first.added, 1);
  assert.deepEqual(pending.shows.example, { notes: 'Existing research', capitalization: 123 });
  const hold = pending.shows['return-snapshot:example'];
  assert.equal(isReviewHold(hold), true);
  assert.equal(hold.designation, undefined);
  assert.equal(queueStaleReturns(pending, { shows: {} }, candidates, now).added, 0);
  const archive = { shows: { example: { ...hold, archivedReason: 'reviewed-rejected', archivedAt: now.toISOString() } } };
  assert.equal(queueStaleReturns({ shows: {} }, archive, candidates, now).added, 0);
  const later = new Date('2027-01-26T12:00:00Z');
  assert.equal(queueStaleReturns({ shows: {} }, archive, candidates, later).added, 1, 'a past review cannot suppress checks forever');
  const reviewedBelow = { shows: { example: { ...hold, estimate: { ...hold.estimate, possibleWindfall: false }, archivedReason: 'reviewed-kept', archivedAt: now.toISOString() } } };
  assert.equal(queueStaleReturns({ shows: {} }, reviewedBelow, candidates, now).added, 1, 'a newly estimated crossing needs another review');
});

test('a stale label whose estimate stays below 1.5x is listed but not queued for review (BRO-6471)', () => {
  const below = scan().map(c => ({ ...c, estimate: { ...c.estimate, investorMultiple: 1.03, possibleWindfall: false } }));
  assert.equal(below.length, 1);
  const pending = { shows: {} };
  assert.equal(queueStaleReturns(pending, { shows: {} }, below, now).added, 0);
  assert.deepEqual(pending.shows, {});
  assert.equal(queueStaleReturns({ shows: {} }, { shows: {} }, [{ ...below[0], estimate: { ...below[0].estimate, investorMultiple: null, possibleWindfall: null } }], now).added, 0, 'no estimate, nothing to review');
});
