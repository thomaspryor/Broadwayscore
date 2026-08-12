/**
 * Unit tests for task #1315 (opening-window BD budget reservation).
 *
 * Run: node --test tests/unit/opening-window-budget-reserve.test.mjs
 *
 * Covers the pure decision functions in scripts/lib/opening-night-budget.js
 * (applyOpeningWindowReserve, countOpeningWindowShows/RESERVE_WINDOW_OPTS) and
 * scripts/lib/brightdata-caps.js (effectiveCeilingForOpeningWindow). Production
 * code requires both modules — change a decision function, these fail
 * (CLAUDE.md rule 15).
 */
// Pinned before any Date use: the window predicate parses date-only
// openingDate strings as UTC midnight (ECMA-262) but computes its cutoff via
// LOCAL Date methods (setDate/setHours) — consistent only when the process
// TZ is UTC, which is what the real runtimes (GitHub Actions cron, CI) use.
// Without this pin, the boundary tests below are flaky on any dev machine
// running a non-UTC local TZ (verified failing on America/New_York).
process.env.TZ = 'UTC';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const budget = require('../../scripts/lib/opening-night-budget.js');
const caps = require('../../scripts/lib/brightdata-caps.js');
const { selectOpeningNightShows } = require('../../scripts/lib/opening-night-selection.js');

const { applyOpeningWindowReserve, countOpeningWindowShows, RESERVE_WINDOW_OPTS, DEFAULT_PER_SHOW } = budget;
const { effectiveCeilingForOpeningWindow, DEFAULT_OPENING_WINDOW_RESERVE_PER_SHOW } = caps;

// ---------- applyOpeningWindowReserve (fetchBrightDataRemaining's pure math) ----------

test('applyOpeningWindowReserve: no reserve behaves like a plain floor-at-zero subtraction', () => {
  assert.equal(applyOpeningWindowReserve({ used: 100, max: 3000, reserve: 0 }), 2900);
  assert.equal(applyOpeningWindowReserve({ used: 5000, max: 3000, reserve: 0 }), 0);
});

test('applyOpeningWindowReserve: reserve is a FLOOR — guaranteed even when routine usage has exhausted the raw cap', () => {
  // Reproduces the live 2026-08-12 incident: used (5273) far exceeds max
  // (3000), so the raw calc would report 0 available. With a reservation in
  // effect, the opening-window show still sees its floor.
  assert.equal(applyOpeningWindowReserve({ used: 5273, max: 3000, reserve: 250 }), 250);
});

test('applyOpeningWindowReserve: reserve never SHRINKS genuine headroom below the raw calc', () => {
  // Plenty of raw headroom (used well under max) — the reserve floor must not
  // clip it down to the reservation amount.
  assert.equal(applyOpeningWindowReserve({ used: 100, max: 3000, reserve: 250 }), 2900);
});

test('applyOpeningWindowReserve: negative/non-finite reserve is ignored, not honored', () => {
  assert.equal(applyOpeningWindowReserve({ used: 5000, max: 3000, reserve: -10 }), 0);
  assert.equal(applyOpeningWindowReserve({ used: 5000, max: 3000, reserve: NaN }), 0);
});

// ---------- countOpeningWindowShows / RESERVE_WINDOW_OPTS (the [today-1, today+3] window) ----------

function writeShowsFixture(shows) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-reserve-test-'));
  const file = path.join(dir, 'shows.json');
  fs.writeFileSync(file, JSON.stringify({ shows }));
  return file;
}

function isoDaysFromNow(now, days) {
  const d = new Date(now);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

test('RESERVE_WINDOW_OPTS: matches the card-specified [today-1, today+3] window', () => {
  assert.equal(RESERVE_WINDOW_OPTS.lookbackDays, 1);
  assert.equal(RESERVE_WINDOW_OPTS.lookAheadHours, 72);
});

test('countOpeningWindowShows: today-1 and today+3 are inside the window', () => {
  const now = new Date('2026-08-12T12:00:00Z');
  const showsFile = writeShowsFixture([
    { id: 'yesterday', category: 'broadway', status: 'open', openingDate: isoDaysFromNow(now, -1) },
    { id: 'plus-three', category: 'broadway', status: 'open', openingDate: isoDaysFromNow(now, 3) },
  ]);
  assert.equal(countOpeningWindowShows(showsFile, now), 2);
});

test('countOpeningWindowShows: today-2 and today+4 are outside the window', () => {
  const now = new Date('2026-08-12T12:00:00Z');
  const showsFile = writeShowsFixture([
    { id: 'minus-two', category: 'broadway', status: 'open', openingDate: isoDaysFromNow(now, -2) },
    { id: 'plus-four', category: 'broadway', status: 'open', openingDate: isoDaysFromNow(now, 4) },
  ]);
  assert.equal(countOpeningWindowShows(showsFile, now), 0);
});

test('countOpeningWindowShows: missing openingDate never counts', () => {
  const now = new Date('2026-08-12T12:00:00Z');
  const showsFile = writeShowsFixture([
    { id: 'no-date', category: 'broadway', status: 'open' },
  ]);
  assert.equal(countOpeningWindowShows(showsFile, now), 0);
});

test('countOpeningWindowShows: unreadable/missing shows.json fails to 0, not a throw', () => {
  assert.equal(countOpeningWindowShows('/nonexistent/shows.json', new Date()), 0);
});

test('countOpeningWindowShows: delegates to selectOpeningNightShows (single source of truth, not a forked predicate)', () => {
  // A show mid-run (status 'closed') with an in-window openingDate is excluded
  // by selectOpeningNightShows' status gate — proving the reservation reuses
  // the canonical predicate's gates (market/status/trust) rather than a naive
  // date-only check that would over-reserve for shows no longer worth
  // protecting.
  const now = new Date('2026-08-12T12:00:00Z');
  const closedShow = { id: 'closed-mid-window', category: 'broadway', status: 'closed', openingDate: isoDaysFromNow(now, 1) };
  const showsFile = writeShowsFixture([closedShow]);
  assert.equal(countOpeningWindowShows(showsFile, now), 0);
  assert.equal(selectOpeningNightShows([closedShow], { ...RESERVE_WINDOW_OPTS, now }).length, 0);
});

// ---------- checkBudget end-to-end reservation (acceptance criterion #1) ----------

test('checkBudget: an opening-window show keeps its BD reservation even when routine spend has exhausted the raw daily cap', async () => {
  const liveUsageWithoutReserve = {
    scrapingbee: { remaining: null, reason: 'no-key' },
    // Mirrors the live 2026-08-12 incident numbers, but computed through the
    // real reservation path rather than hand-injected — used > max, reserve
    // applied via applyOpeningWindowReserve.
    brightdata: { remaining: applyOpeningWindowReserve({ used: 5273, max: 3000, reserve: DEFAULT_PER_SHOW.brightdata }), used: 5273, max: 3000, reserve: DEFAULT_PER_SHOW.brightdata },
    browserbase: { remaining: null, reason: 'no-api' },
    anthropic: { remaining: null, reason: 'no-api' },
    openai: { remaining: null, reason: 'no-api' },
    gemini: { remaining: null, reason: 'no-api' },
    gha_minutes: { remaining: null, reason: 'requires-pat-with-user-scope' },
  };

  const result = await budget.checkBudget(1, { liveUsage: liveUsageWithoutReserve });

  assert.equal(result.usage.brightdata.remaining, DEFAULT_PER_SHOW.brightdata);
  assert.ok(
    result.usage.brightdata.remaining >= DEFAULT_PER_SHOW.brightdata,
    `reserved brightdata remaining (${result.usage.brightdata.remaining}) must be >= the per-show estimate (${DEFAULT_PER_SHOW.brightdata})`,
  );
  const bdBlocker = result.blockers.find((b) => b.resource === 'brightdata');
  assert.equal(bdBlocker, undefined, 'brightdata must not block a single opening-window show once its reservation is applied');
});

test('checkBudget: with NO reservation, the same exhausted-cap numbers DO block (proves the fixture reproduces the pre-fix bug)', async () => {
  const liveUsageNoReserve = {
    scrapingbee: { remaining: null, reason: 'no-key' },
    brightdata: { remaining: applyOpeningWindowReserve({ used: 5273, max: 3000, reserve: 0 }), used: 5273, max: 3000, reserve: 0 },
    browserbase: { remaining: null, reason: 'no-api' },
    anthropic: { remaining: null, reason: 'no-api' },
    openai: { remaining: null, reason: 'no-api' },
    gemini: { remaining: null, reason: 'no-api' },
    gha_minutes: { remaining: null, reason: 'requires-pat-with-user-scope' },
  };
  const result = await budget.checkBudget(1, { liveUsage: liveUsageNoReserve });
  assert.equal(result.usage.brightdata.remaining, 0);
  const bdBlocker = result.blockers.find((b) => b.resource === 'brightdata');
  assert.ok(bdBlocker, 'without a reservation the exhausted-cap fixture must reproduce the original FAIL');
});

// ---------- effectiveCeilingForOpeningWindow (bulk breaker throttle) ----------

test('effectiveCeilingForOpeningWindow: 0 shows in window leaves the ceiling unchanged', () => {
  assert.equal(effectiveCeilingForOpeningWindow({ ceiling: 3500, openingWindowShows: 0 }), 3500);
});

test('effectiveCeilingForOpeningWindow: N shows carve out N * reservePerShow', () => {
  assert.equal(
    effectiveCeilingForOpeningWindow({ ceiling: 3500, openingWindowShows: 1, reservePerShow: 250 }),
    3250,
  );
  assert.equal(
    effectiveCeilingForOpeningWindow({ ceiling: 3500, openingWindowShows: 4, reservePerShow: 250 }),
    2500,
  );
});

test('effectiveCeilingForOpeningWindow: defaults reservePerShow to DEFAULT_OPENING_WINDOW_RESERVE_PER_SHOW', () => {
  assert.equal(
    effectiveCeilingForOpeningWindow({ ceiling: 3500, openingWindowShows: 1 }),
    3500 - DEFAULT_OPENING_WINDOW_RESERVE_PER_SHOW,
  );
});

test('effectiveCeilingForOpeningWindow: never goes negative even if the reserve exceeds the ceiling', () => {
  assert.equal(
    effectiveCeilingForOpeningWindow({ ceiling: 500, openingWindowShows: 10, reservePerShow: 250 }),
    0,
  );
});

test('effectiveCeilingForOpeningWindow: invalid ceiling/reservePerShow pass through unchanged (fail-safe)', () => {
  assert.equal(effectiveCeilingForOpeningWindow({ ceiling: 0, openingWindowShows: 2 }), 0);
  assert.equal(effectiveCeilingForOpeningWindow({ ceiling: 3500, openingWindowShows: 2, reservePerShow: 0 }), 3500);
  assert.equal(effectiveCeilingForOpeningWindow({ ceiling: 3500, openingWindowShows: NaN }), 3500);
});
