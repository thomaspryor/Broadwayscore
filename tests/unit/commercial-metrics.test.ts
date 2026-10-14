/**
 * BRO-4623: pure commercial-scorecard calculations, tested against the real
 * functions (CLAUDE.md §15). Runs in the tsx batch
 * (tests/unit-test-manifest-tsx.txt).
 *
 *  - P0-5  weeks to recoup: year-only is null; YYYY-MM is mid-month; a
 *          recoupment after closing or after today is null.
 *  - P0-6  capital totals never count an unknown capitalization as $0.
 *  - P0-7 / P1-3  at-risk needs a model estimate and compares the 4-week
 *          average gross with break-even.
 *  - P1-2  trend is 4-week mean vs prior 4-week mean; "approaching" needs the
 *          low case at 50%+.
 *  - P0-2  /browse/biggest-broadway-flops lists closed shows only.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateWeeksToRecoup,
  trailingAverageGross,
  computeGrossTrend,
  summarizeCapital,
  isRunningStatus,
  isAtRisk,
  isApproachingRecoupment,
  AT_RISK_MAX_RECOUPED_PCT,
  APPROACHING_MIN_LOW_PCT,
  DISPLAY_TREND_THRESHOLD_PCT,
  type AtRiskInput,
} from '../../src/lib/commercial-metrics';
import { BROWSE_PAGES, type BrowseFilterContext } from '../../src/config/browse-pages';
import type { ComputedShow } from '../../src/lib/engine';
import type { ShowCommercial } from '../../src/lib/data-types';

const NOW = new Date(2026, 9, 4); // 2026-10-04 local

// ── P0-5: calculateWeeksToRecoup ────────────────────────────────────────────

test('weeks to recoup: YYYY-MM resolves to mid-month', () => {
  // Mar 10 -> Sep 15 = 189 days = 27 weeks
  assert.equal(calculateWeeksToRecoup('2024-03-10', '2024-09', null, NOW), 27);
});

test('weeks to recoup: year-only is null (Dec 31 used to inflate Lion King / Ragtime)', () => {
  assert.equal(calculateWeeksToRecoup('1997-11-13', '1999', null, NOW), null);
  assert.equal(calculateWeeksToRecoup('2025-10-16', '2026', null, NOW), null);
});

test('weeks to recoup: recoupment month after closing is null', () => {
  assert.equal(calculateWeeksToRecoup('2024-03-10', '2024-09', '2024-08-20', NOW), null);
});

test('weeks to recoup: closing inside the recoupment month clamps to closing', () => {
  // Mar 10 -> Sep 8 = 182 days = 26 weeks
  assert.equal(calculateWeeksToRecoup('2024-03-10', '2024-09', '2024-09-08', NOW), 26);
});

test('weeks to recoup: a future month is null; the current month clamps to today', () => {
  assert.equal(calculateWeeksToRecoup('2026-01-04', '2026-11', null, NOW), null);
  // Jan 4 -> Oct 4 = 273 days = 39 weeks
  assert.equal(calculateWeeksToRecoup('2026-01-04', '2026-10', null, NOW), 39);
});

test('weeks to recoup: before opening, malformed or missing input is null', () => {
  assert.equal(calculateWeeksToRecoup('2024-03-10', '2023-12', null, NOW), null);
  assert.equal(calculateWeeksToRecoup('2024-03-10', '2024-13', null, NOW), null);
  assert.equal(calculateWeeksToRecoup('2024-03-10', 'Sep 2024', null, NOW), null);
  assert.equal(calculateWeeksToRecoup(null, '2024-09', null, NOW), null);
  assert.equal(calculateWeeksToRecoup('2024-03-10', null, null, NOW), null);
});

// ── P1-2: trailing average + 4-week trend ───────────────────────────────────

test('trailing average: mean of the newest 4 reported weeks', () => {
  assert.equal(trailingAverageGross([100, 200, 300, 400, 999]), 250);
  assert.equal(trailingAverageGross([100, null, 200, 300]), 200);
});

test('trailing average: null with fewer than 3 reported weeks', () => {
  assert.equal(trailingAverageGross([100, null, 300, null]), null);
  assert.equal(trailingAverageGross([]), null);
});

test('trend: 4-week mean vs prior 4-week mean', () => {
  const flat = [100, 100, 100, 100];
  assert.equal(computeGrossTrend([110, 110, 110, 110, ...flat]), 'improving');
  assert.equal(computeGrossTrend([90, 90, 90, 90, ...flat]), 'declining');
  assert.equal(computeGrossTrend([102, 102, 102, 102, ...flat]), 'steady');
});

test('trend: unknown when either window has under 3 reported weeks (new or closed shows)', () => {
  assert.equal(computeGrossTrend([110, null, null, 110, 100, 100, 100, 100]), 'unknown');
  assert.equal(computeGrossTrend([110, 110, 110, 110]), 'unknown');
  assert.equal(computeGrossTrend([]), 'unknown');
});

test('trend: a wider threshold is never more likely to say declining', () => {
  const soft = [95, 95, 95, 95, 100, 100, 100, 100]; // -5%
  assert.equal(computeGrossTrend(soft, 2), 'declining');
  assert.equal(computeGrossTrend(soft, 8), 'steady');
  assert.ok(DISPLAY_TREND_THRESHOLD_PCT > 0);
});

// ── P0-6: capital totals ────────────────────────────────────────────────────

test('capital summary: unknown capitalizations are counted as undisclosed, never $0', () => {
  assert.deepEqual(
    summarizeCapital([10_000_000, null, 5_000_000, 0, undefined]),
    { knownTotal: 15_000_000, showCount: 5, undisclosedCount: 3 },
  );
  assert.deepEqual(summarizeCapital([]), { knownTotal: 0, showCount: 0, undisclosedCount: 0 });
  assert.deepEqual(summarizeCapital([null, null]), { knownTotal: 0, showCount: 2, undisclosedCount: 2 });
});

test('running status: open and previews only', () => {
  assert.equal(isRunningStatus('open'), true);
  assert.equal(isRunningStatus('previews'), true);
  assert.equal(isRunningStatus('closed'), false);
  assert.equal(isRunningStatus(undefined), false);
});

// ── P0-7 / P1-3: at risk ────────────────────────────────────────────────────

const atRisk: AtRiskInput = {
  status: 'open',
  recouped: false,
  recoupmentRange: [5, 10, 20],
  avgGross: 500_000,
  breakEven: 700_000,
};

test('at risk: running, below break-even on the 4-week average, under 30% even in the high case', () => {
  assert.equal(isAtRisk(atRisk), true);
  assert.equal(isAtRisk({ ...atRisk, status: 'previews' }), true);
});

test('at risk: a show with no model estimate is skipped (no "<30%" from missing data)', () => {
  assert.equal(isAtRisk({ ...atRisk, recoupmentRange: null }), false);
});

test('at risk: needs both a 4-week average and a break-even', () => {
  assert.equal(isAtRisk({ ...atRisk, avgGross: null }), false);
  assert.equal(isAtRisk({ ...atRisk, breakEven: null }), false);
  assert.equal(isAtRisk({ ...atRisk, breakEven: 0 }), false);
});

test('at risk: at or above break-even is not at risk', () => {
  assert.equal(isAtRisk({ ...atRisk, avgGross: 700_000 }), false);
  assert.equal(isAtRisk({ ...atRisk, avgGross: 900_000 }), false);
});

test('at risk: the high case must be under the threshold', () => {
  assert.equal(isAtRisk({ ...atRisk, recoupmentRange: [5, 15, AT_RISK_MAX_RECOUPED_PCT] }), false);
  assert.equal(isAtRisk({ ...atRisk, recoupmentRange: [5, 15, AT_RISK_MAX_RECOUPED_PCT - 1] }), true);
});

test('at risk: closed or recouped shows are never at risk', () => {
  assert.equal(isAtRisk({ ...atRisk, status: 'closed' }), false);
  assert.equal(isAtRisk({ ...atRisk, recouped: true }), false);
});

// ── P1-2: approaching recoupment ────────────────────────────────────────────

test('approaching: the low end of the model range must reach 50%', () => {
  assert.equal(isApproachingRecoupment([APPROACHING_MIN_LOW_PCT, 70, 90]), true);
  assert.equal(isApproachingRecoupment([APPROACHING_MIN_LOW_PCT - 1, 80, 100]), false);
  assert.equal(isApproachingRecoupment(null), false);
});

// ── P0-2: flops browse page ─────────────────────────────────────────────────

function flopsFilter(status: string, designation: string): boolean {
  const dataFilter = BROWSE_PAGES['biggest-broadway-flops']?.dataFilter;
  assert.ok(dataFilter, 'biggest-broadway-flops must use a dataFilter');
  const show = { slug: 'fixture-show', id: 'fixture-show', status } as unknown as ComputedShow;
  const ctx = {
    getShowCommercial: () => ({ designation } as unknown as ShowCommercial),
    getAudienceBuzz: () => undefined,
    getShowAwards: () => undefined,
    getShowGrosses: () => undefined,
    getShowById: () => undefined,
  } as BrowseFilterContext;
  return dataFilter(show, ctx);
}

test('flops page: running shows are never listed, whatever their designation', () => {
  assert.equal(flopsFilter('open', 'Flop'), false);
  assert.equal(flopsFilter('open', 'Fizzle'), false);
  assert.equal(flopsFilter('previews', 'Flop'), false);
});

test('flops page: closed Flops and Fizzles are listed; other closed outcomes are not', () => {
  assert.equal(flopsFilter('closed', 'Flop'), true);
  assert.equal(flopsFilter('closed', 'Fizzle'), true);
  assert.equal(flopsFilter('closed', 'Easy Winner'), false);
  assert.equal(flopsFilter('closed', 'TBD'), false);
});
