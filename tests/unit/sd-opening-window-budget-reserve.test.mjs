/**
 * Unit tests for task #1330 (opening-window SD budget reservation — the SD
 * half of #1315's BD fix).
 *
 * Run: node --test tests/unit/sd-opening-window-budget-reserve.test.mjs
 *
 * Covers the pure decision functions in scripts/lib/scrapingdog-caps.js
 * (resolveOpeningWindowReservePerShowCredits) and confirms it composes
 * correctly with brightdata-caps.js's effectiveCeilingForOpeningWindow — the
 * same provider-agnostic reserve math BD already uses, reused rather than
 * duplicated (scrapingdog-caps.js already imports two other symbols from
 * brightdata-caps.js). Production code requires both modules — change a
 * decision function, these fail (CLAUDE.md rule 15).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const caps = require('../../scripts/lib/brightdata-caps.js');
const sdCaps = require('../../scripts/lib/scrapingdog-caps.js');

const { effectiveCeilingForOpeningWindow } = caps;
const {
  DEFAULT_OPENING_WINDOW_RESERVE_PER_SHOW_CREDITS,
  resolveOpeningWindowReservePerShowCredits,
} = sdCaps;

// ---------- resolveOpeningWindowReservePerShowCredits ----------

test('resolveOpeningWindowReservePerShowCredits: defaults when env unset', () => {
  assert.equal(resolveOpeningWindowReservePerShowCredits({}), DEFAULT_OPENING_WINDOW_RESERVE_PER_SHOW_CREDITS);
});

test('resolveOpeningWindowReservePerShowCredits: SD_OPENING_WINDOW_RESERVE_PER_SHOW_CREDITS overrides', () => {
  assert.equal(
    resolveOpeningWindowReservePerShowCredits({ SD_OPENING_WINDOW_RESERVE_PER_SHOW_CREDITS: '5000' }),
    5000,
  );
});

test('resolveOpeningWindowReservePerShowCredits: garbage/zero/negative falls back to the default', () => {
  assert.equal(resolveOpeningWindowReservePerShowCredits({ SD_OPENING_WINDOW_RESERVE_PER_SHOW_CREDITS: 'nope' }), DEFAULT_OPENING_WINDOW_RESERVE_PER_SHOW_CREDITS);
  assert.equal(resolveOpeningWindowReservePerShowCredits({ SD_OPENING_WINDOW_RESERVE_PER_SHOW_CREDITS: '0' }), DEFAULT_OPENING_WINDOW_RESERVE_PER_SHOW_CREDITS);
  assert.equal(resolveOpeningWindowReservePerShowCredits({ SD_OPENING_WINDOW_RESERVE_PER_SHOW_CREDITS: '-10' }), DEFAULT_OPENING_WINDOW_RESERVE_PER_SHOW_CREDITS);
});

// ---------- effectiveCeilingForOpeningWindow, fed SD's ceiling + reserve (check-sd-breaker.js's call site) ----------

test('effectiveCeilingForOpeningWindow: 0 shows in window leaves SD ceiling unchanged', () => {
  assert.equal(
    effectiveCeilingForOpeningWindow({
      ceiling: 45000,
      openingWindowShows: 0,
      reservePerShow: DEFAULT_OPENING_WINDOW_RESERVE_PER_SHOW_CREDITS,
    }),
    45000,
  );
});

test('effectiveCeilingForOpeningWindow: N shows carve out N * SD reservePerShow credits', () => {
  assert.equal(
    effectiveCeilingForOpeningWindow({
      ceiling: 45000,
      openingWindowShows: 1,
      reservePerShow: DEFAULT_OPENING_WINDOW_RESERVE_PER_SHOW_CREDITS,
    }),
    45000 - DEFAULT_OPENING_WINDOW_RESERVE_PER_SHOW_CREDITS,
  );
  assert.equal(
    effectiveCeilingForOpeningWindow({
      ceiling: 45000,
      openingWindowShows: 3,
      reservePerShow: DEFAULT_OPENING_WINDOW_RESERVE_PER_SHOW_CREDITS,
    }),
    45000 - 3 * DEFAULT_OPENING_WINDOW_RESERVE_PER_SHOW_CREDITS,
  );
});

test('effectiveCeilingForOpeningWindow: never goes negative even if the SD reserve exceeds the ceiling', () => {
  assert.equal(
    effectiveCeilingForOpeningWindow({ ceiling: 2000, openingWindowShows: 5, reservePerShow: DEFAULT_OPENING_WINDOW_RESERVE_PER_SHOW_CREDITS }),
    0,
  );
});

// ---------- shouldTripBreaker fed the reduced ceiling (proves the wiring check-sd-breaker.js does) ----------

test('shouldTripBreaker: a routine-sweep day that would pass the raw ceiling TRIPS once the opening-window reserve is applied', () => {
  const ceiling = 45000;
  const reserveShows = 1;
  const effectiveCeiling = effectiveCeilingForOpeningWindow({
    ceiling,
    openingWindowShows: reserveShows,
    reservePerShow: DEFAULT_OPENING_WINDOW_RESERVE_PER_SHOW_CREDITS,
  });
  // Usage sits between the reduced ceiling and the raw ceiling — under the
  // raw cap (so the pre-fix breaker would NOT trip) but over the reduced one
  // (so the fixed breaker DOES), reproducing the exact BD starvation shape
  // (#1315) for SD's credit-denominated ceiling.
  const dayCredits = effectiveCeiling + 1;
  assert.ok(dayCredits < ceiling, 'fixture must stay under the raw ceiling to prove this is the reserve, not just the ceiling, tripping it');

  const rawVerdict = sdCaps.shouldTripBreaker({ dayCredits, ceiling });
  assert.equal(rawVerdict.tripped, false, 'sanity: raw ceiling would not have tripped on this usage');

  const reservedVerdict = sdCaps.shouldTripBreaker({ dayCredits, ceiling: effectiveCeiling });
  assert.equal(reservedVerdict.tripped, true, 'reduced ceiling must trip so bulk sweeps stop before starving the opening-window show');
});
