/**
 * Unit tests for evaluatePreWindowInclusion (scripts/lib/date-guard.js).
 *
 * The pre-window inclusion predicate is the single source of truth for the
 * rebuild-all-reviews.js inclusion pass, its duplicate-reference replica, the
 * flag pass, the scoring-delta.js sim, and validate-data.js's US-on-WE error
 * tier (card 386637c5). Tests require() the real function per CLAUDE.md §15.
 *
 * Colocated in scripts/lib/ — CI runs every scripts/lib/*.test.mjs via glob
 * (test.yml "Run scripts/lib tests" step), no batch registration needed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  evaluatePreWindowInclusion,
  evaluateDateGuard,
  PRE_WINDOW_DAYS,
  PRE_WINDOW_DAYS_BROADWAY,
} = require('./date-guard.js');

const D = (s) => new Date(s + 'T00:00:00Z');

test('thresholds: flex = 60d, Broadway = 14d (card 386637c5 tightened flex from 90)', () => {
  assert.equal(PRE_WINDOW_DAYS, 60);
  assert.equal(PRE_WINDOW_DAYS_BROADWAY, 14);
});

test('flex category: review 61d before earliest date is excluded as pre-window', () => {
  const r = evaluatePreWindowInclusion({
    pubDate: D('2026-01-01'),
    showEarliest: D('2026-03-03'), // 61 days later
    isFlexCategory: true,
    priorRuns: null,
  });
  assert.equal(r.exclude, true);
  assert.equal(r.reason, 'pre-window date');
  assert.equal(r.threshold, 60);
  assert.equal(r.daysBefore, 61);
});

test('flex category: review 59d before earliest date is included (in window)', () => {
  const r = evaluatePreWindowInclusion({
    pubDate: D('2026-01-03'),
    showEarliest: D('2026-03-03'), // 59 days later
    isFlexCategory: true,
    priorRuns: null,
  });
  assert.equal(r.exclude, false);
  assert.equal(r.reason, null);
});

test('regression (was 90d): a 75d-early flex review is now excluded', () => {
  // Under the pre-2026-07 90d threshold this review passed inclusion.
  const r = evaluatePreWindowInclusion({
    pubDate: D('2025-12-18'),
    showEarliest: D('2026-03-03'), // 75 days later
    isFlexCategory: true,
    priorRuns: null,
  });
  assert.equal(r.exclude, true);
});

test('priorRuns window covering the date exempts the review (legitimate return engagement)', () => {
  // Mirrors sexual-misconduct-of-the-middle-classes-off-broadway-2026: reviews
  // dated 2025-05-08 (~313d before the 2026 entry) fall inside the declared
  // 2025 Minetta Lane priorRun — legitimate prior-run coverage, never excluded.
  const r = evaluatePreWindowInclusion({
    pubDate: D('2025-05-08'),
    showEarliest: D('2026-03-17'),
    isFlexCategory: true,
    priorRuns: [{ openingDate: '2025-05-01', closingDate: '2025-07-15', venue: "Audible's Minetta Lane Theatre" }],
  });
  assert.equal(r.exclude, false);
  assert.equal(r.reason, 'prior-run window');
});

test('pre-window date OUTSIDE every priorRun is still excluded', () => {
  const r = evaluatePreWindowInclusion({
    pubDate: D('2024-05-08'), // a year before the declared run
    showEarliest: D('2026-03-17'),
    isFlexCategory: true,
    priorRuns: [{ openingDate: '2025-05-01', closingDate: '2025-07-15' }],
  });
  assert.equal(r.exclude, true);
  assert.equal(r.reason, 'pre-window date');
});

test('Broadway category: 15d early excluded, 13d early included (14d embargo grace)', () => {
  const base = { showEarliest: D('2026-03-03'), isFlexCategory: false, priorRuns: null };
  assert.equal(evaluatePreWindowInclusion({ ...base, pubDate: D('2026-02-16') }).exclude, true);  // 15d
  assert.equal(evaluatePreWindowInclusion({ ...base, pubDate: D('2026-02-18') }).exclude, false); // 13d
});

test('abstains (never excludes) on missing or invalid dates', () => {
  assert.equal(evaluatePreWindowInclusion({ pubDate: null, showEarliest: D('2026-03-03'), isFlexCategory: true }).exclude, false);
  assert.equal(evaluatePreWindowInclusion({ pubDate: D('2026-01-01'), showEarliest: null, isFlexCategory: true }).exclude, false);
  assert.equal(evaluatePreWindowInclusion({ pubDate: new Date('garbage'), showEarliest: D('2026-03-03'), isFlexCategory: true }).exclude, false);
});

test('reviews published on or after the earliest date are always included', () => {
  const r = evaluatePreWindowInclusion({
    pubDate: D('2026-04-01'),
    showEarliest: D('2026-03-03'),
    isFlexCategory: true,
    priorRuns: null,
  });
  assert.equal(r.exclude, false);
});

// BRO-222: evaluateDateGuard() itself must be priorRuns-aware, not just its
// callers. Before this fix, a review dated inside a declared priorRun window
// but outside the CURRENT run's grace window was still flagged 'before_preview'
// by this pure function — every downstream caller had to remember to bolt on
// its own isWithinPriorRun() check (and the reverse cross-market guard in
// rebuild-all-reviews.js never did).
test('evaluateDateGuard: review dated inside a declared priorRun window is NOT date-guarded', () => {
  const show = {
    previewsStartDate: '2026-07-15',
    openingDate: '2026-07-22',
    // Edinburgh Fringe prior run, well outside the current show's 21d grace window.
    priorRuns: [{ openingDate: '2025-08-01', closingDate: '2025-08-10', venue: 'Edinburgh Festival Fringe (Assembly)' }],
  };
  const r = evaluateDateGuard({
    pubDate: D('2025-08-05'), // inside the declared priorRun window
    show,
    outletId: 'neurodiversereview',
    priorRuns: show.priorRuns,
  });
  assert.equal(r.flag, false);
  assert.equal(r.issue, null);
});

test('evaluateDateGuard: same pubDate WITHOUT priorRuns passed is still flagged (proves the fix, not a tautology)', () => {
  const show = { previewsStartDate: '2026-07-15', openingDate: '2026-07-22' };
  const r = evaluateDateGuard({
    pubDate: D('2025-08-05'),
    show,
    outletId: 'neurodiversereview',
    // priorRuns omitted — mirrors current-guard-logic-before-the-fix behavior
  });
  assert.equal(r.flag, true);
  assert.equal(r.issue, 'before_preview');
});

test('evaluateDateGuard: a date OUTSIDE every declared priorRun is still flagged', () => {
  const show = {
    previewsStartDate: '2026-07-15',
    openingDate: '2026-07-22',
    priorRuns: [{ openingDate: '2025-08-01', closingDate: '2025-08-10', venue: 'Edinburgh Festival Fringe (Assembly)' }],
  };
  const r = evaluateDateGuard({
    pubDate: D('2024-01-01'), // nowhere near the declared run
    show,
    outletId: 'neurodiversereview',
    priorRuns: show.priorRuns,
  });
  assert.equal(r.flag, true);
  assert.equal(r.issue, 'before_preview');
});
