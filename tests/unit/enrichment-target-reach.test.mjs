/**
 * BRO-7437 class guard: a daily `--limit=N` enricher must actually REACH the
 * open shows the freshness report is flagging.
 *
 * The recurring card "Data freshness: shows missing poster/synopsis/tickets"
 * (BRO-5455, BRO-7368, BRO-7412) was refiled every ~10 days for a year because
 * the gap count never fell. The reason was not that the gaps were unfillable:
 * it was that the producer never looked at them.
 * scripts/lib/wikipedia-synopsis-match.js took `ordered.slice(0, 20)` of a
 * 3209-row, file-ordered candidate list whose first rows were all closed
 * shows, so update-show-status.yml's three daily synopsis passes reached 40
 * shows a day and ZERO of the 38 flagged open ones, every day, forever.
 *
 * Nothing in the repo could see that: the enricher printed "Attempting 20" and
 * the health row printed "38 open show(s) missing critical data", and no check
 * joined the two. This file is that join. It is the check that should have
 * caught the class in February and did not exist.
 *
 * This file holds the synthetic, always-blocking half. The half that joins the
 * enrichers to the LIVE freshness report is enrichment-target-reach-live.test.mjs
 * (live-data lane: it reads untracked core data, so it cannot block main).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// Rule 15: require the real functions, never a copy of their logic.
const {
  LIVE_STATUSES,
  SOON_STATUSES,
  ACTIVE_STATUSES,
  isLiveShow,
  isActiveShow,
  statusTier,
  orderActiveFirst,
  rotateDaily,
  shareBudget,
  selectDailyTargets,
} = require(path.join(ROOT, 'scripts/lib/enrichment-targets.js'));

const DAYS = Array.from({ length: 31 }, (_, i) => new Date(Date.UTC(2026, 0, i + 1)));


// ---------------------------------------------------------------- unit level

test('status tiers rank live shows over upcoming over the historical tail', () => {
  for (const status of LIVE_STATUSES) assert.equal(statusTier({ status }), 0);
  for (const status of SOON_STATUSES) assert.equal(statusTier({ status }), 1);
  assert.equal(statusTier({ status: 'closed' }), 2);
  assert.equal(statusTier({ status: 'who-knows' }), 2);
  assert.equal(statusTier(null), 2);
  // ACTIVE = live + soon, and `upcoming` must NOT count as live: the health
  // row counts open shows only, and 215 upcoming rows would swamp them.
  assert.deepEqual([...ACTIVE_STATUSES], [...LIVE_STATUSES, ...SOON_STATUSES]);
  assert.equal(isLiveShow({ status: 'upcoming' }), false);
  assert.equal(isActiveShow({ status: 'upcoming' }), true);
  assert.equal(isActiveShow({ status: 'closed' }), false);
  assert.equal(isActiveShow(null), false);
});

test('orderActiveFirst is stable and total on junk input', () => {
  const shows = [
    { id: 'c1', status: 'closed' },
    { id: 'o1', status: 'open' },
    { id: 'u1', status: 'upcoming' },
    { id: 'c2', status: 'closed' },
    { id: 'p1', status: 'previews' },
  ];
  assert.deepEqual(orderActiveFirst(shows).map(s => s.id), ['o1', 'p1', 'u1', 'c1', 'c2']);
  assert.deepEqual(orderActiveFirst(null), []);
  assert.deepEqual(orderActiveFirst([]), []);
});

test('rotateDaily reaches every candidate across a month instead of the same head daily', () => {
  const list = Array.from({ length: 30 }, (_, i) => i);
  const seen = new Set();
  for (const now of DAYS.slice(0, 28)) {
    const picked = rotateDaily(list, 5, now);
    assert.equal(picked.length, 5);
    for (const n of picked) seen.add(n);
  }
  assert.equal(seen.size, list.length, 'every candidate must be attempted at least once in a month');
});

test('rotateDaily is a no-op when nothing is being starved', () => {
  const list = [1, 2, 3];
  assert.deepEqual(rotateDaily(list, 0), list);
  assert.deepEqual(rotateDaily(list, 10), list);
  assert.deepEqual(rotateDaily(list, 3), list);
  assert.deepEqual(rotateDaily(null, 5), []);
});

test('shareBudget gives every non-empty tier progress and cascades the remainder upward', () => {
  // Three fat tiers, budget 20: floor 6 each = 18, the spare 2 go to tier 0.
  assert.deepEqual(shareBudget([new Array(40), new Array(40), new Array(40)], 20), [8, 6, 6]);
  // A tier smaller than its floor hands its unused slots to the earlier tiers.
  assert.deepEqual(shareBudget([new Array(40), new Array(2), new Array(40)], 20), [12, 2, 6]);
  // Empty tiers take nothing at all.
  assert.deepEqual(shareBudget([new Array(40), [], []], 20), [20, 0, 0]);
  assert.deepEqual(shareBudget([[], [], []], 20), [0, 0, 0]);
  assert.deepEqual(shareBudget([new Array(40), new Array(40), new Array(40)], 0), [0, 0, 0]);
  // The budget is never exceeded.
  for (const limit of [1, 3, 7, 20, 100]) {
    const b = shareBudget([new Array(40), new Array(40), new Array(40)], limit);
    assert.ok(b.reduce((a, n) => a + n, 0) <= limit, `budget ${limit} overspent: ${b}`);
  }
});

test('selectDailyTargets starves no tier: upcoming and closed still make progress', () => {
  const shows = [
    ...Array.from({ length: 50 }, (_, i) => ({ id: `o${i}`, status: 'open' })),
    ...Array.from({ length: 50 }, (_, i) => ({ id: `u${i}`, status: 'upcoming' })),
    ...Array.from({ length: 50 }, (_, i) => ({ id: `c${i}`, status: 'closed' })),
  ];
  const seen = { open: new Set(), upcoming: new Set(), closed: new Set() };
  for (const now of DAYS) {
    for (const s of selectDailyTargets(shows, 20, { now })) seen[s.status].add(s.id);
  }
  // The whole point: prioritising live shows must not recreate the bug with
  // a different victim.
  for (const status of ['open', 'upcoming', 'closed']) {
    assert.ok(seen[status].size > 0, `${status} shows were starved entirely over a month`);
  }
  assert.ok(seen.open.size >= seen.upcoming.size, 'live shows must get at least as much reach as upcoming');
});

test('selectDailyTargets keeps pinned rows at the head on every day of the month', () => {
  const pinnedRow = { id: 'pinned-closed-parent', status: 'closed' };
  const shows = [
    pinnedRow,
    ...Array.from({ length: 200 }, (_, i) => ({ id: `o${i}`, status: 'open' })),
  ];
  for (const now of DAYS) {
    const picked = selectDailyTargets(shows, 20, { now, pinned: [pinnedRow] });
    assert.equal(picked[0], pinnedRow, `pinned row left the head on ${now.toISOString().slice(0, 10)}`);
    assert.equal(picked.length, 20);
  }
});

test('selectDailyTargets does not mutate or drop rows when nothing is capped', () => {
  const shows = [{ id: 'a', status: 'closed' }, { id: 'b', status: 'open' }];
  const before = JSON.parse(JSON.stringify(shows));
  assert.equal(selectDailyTargets(shows, 0).length, 2);
  assert.equal(selectDailyTargets(shows, 10).length, 2);
  assert.deepEqual(shows, before);
  assert.deepEqual(selectDailyTargets(null, 5), []);
});
