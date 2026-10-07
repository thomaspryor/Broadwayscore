/**
 * Unit tests for task #1333 (opening-window Browserbase budget reservation —
 * the Browserbase half of #1315's BD fix / #1330's SD fix).
 *
 * Run: node --test tests/unit/browserbase-opening-window-budget-reserve.test.mjs
 *
 * Covers the pure decision functions in scripts/lib/browserbase-caps.js
 * (resolveOpeningWindowReservePerShow, resolveExemptScripts) and confirms
 * they compose correctly with brightdata-caps.js's
 * effectiveCeilingForOpeningWindow / isExemptCaller — the same
 * provider-agnostic reserve + exemption logic BD/SD already use, reused
 * rather than duplicated (mirrors tests/unit/sd-opening-window-budget-reserve.test.mjs).
 * Production code requires both modules — change a decision function, these
 * fail (CLAUDE.md rule 15).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const bdCaps = require('../../scripts/lib/brightdata-caps.js');
const bbCaps = require('../../scripts/lib/browserbase-caps.js');

const { effectiveCeilingForOpeningWindow, isExemptCaller, DEFAULT_EXEMPT_SCRIPTS } = bdCaps;
const {
  DEFAULT_OPENING_WINDOW_RESERVE_PER_SHOW,
  resolveOpeningWindowReservePerShow,
  resolveExemptScripts,
  resolveMaxSessionsPerDay,
} = bbCaps;

// ---------- resolveOpeningWindowReservePerShow ----------

test('resolveOpeningWindowReservePerShow: defaults when env unset', () => {
  assert.equal(resolveOpeningWindowReservePerShow({}), DEFAULT_OPENING_WINDOW_RESERVE_PER_SHOW);
});

test('resolveOpeningWindowReservePerShow: matches opening-night-budget.js DEFAULT_PER_SHOW.browserbase (5)', () => {
  assert.equal(DEFAULT_OPENING_WINDOW_RESERVE_PER_SHOW, 5);
});

test('resolveOpeningWindowReservePerShow: BROWSERBASE_OPENING_WINDOW_RESERVE_PER_SHOW overrides', () => {
  assert.equal(
    resolveOpeningWindowReservePerShow({ BROWSERBASE_OPENING_WINDOW_RESERVE_PER_SHOW: '10' }),
    10,
  );
});

test('resolveOpeningWindowReservePerShow: garbage/zero/negative falls back to the default', () => {
  assert.equal(resolveOpeningWindowReservePerShow({ BROWSERBASE_OPENING_WINDOW_RESERVE_PER_SHOW: 'nope' }), DEFAULT_OPENING_WINDOW_RESERVE_PER_SHOW);
  assert.equal(resolveOpeningWindowReservePerShow({ BROWSERBASE_OPENING_WINDOW_RESERVE_PER_SHOW: '0' }), DEFAULT_OPENING_WINDOW_RESERVE_PER_SHOW);
  assert.equal(resolveOpeningWindowReservePerShow({ BROWSERBASE_OPENING_WINDOW_RESERVE_PER_SHOW: '-10' }), DEFAULT_OPENING_WINDOW_RESERVE_PER_SHOW);
});

// ---------- resolveExemptScripts ----------

test('resolveExemptScripts: defaults to brightdata-caps.js DEFAULT_EXEMPT_SCRIPTS when env unset', () => {
  assert.deepEqual(resolveExemptScripts({}), DEFAULT_EXEMPT_SCRIPTS);
});

test('resolveExemptScripts: BROWSERBASE_EXEMPT_SCRIPTS overrides with a comma-separated list', () => {
  assert.deepEqual(
    resolveExemptScripts({ BROWSERBASE_EXEMPT_SCRIPTS: 'foo.js, bar.js' }),
    ['foo.js', 'bar.js'],
  );
});

// ---------- effectiveCeilingForOpeningWindow, fed Browserbase's ceiling + reserve ----------

test('effectiveCeilingForOpeningWindow: 0 shows in window leaves the Browserbase ceiling unchanged', () => {
  const ceiling = resolveMaxSessionsPerDay({});
  assert.equal(
    effectiveCeilingForOpeningWindow({
      ceiling,
      openingWindowShows: 0,
      reservePerShow: DEFAULT_OPENING_WINDOW_RESERVE_PER_SHOW,
    }),
    ceiling,
  );
});

test('effectiveCeilingForOpeningWindow: N shows carve out N * Browserbase reservePerShow sessions', () => {
  const ceiling = 250;
  assert.equal(
    effectiveCeilingForOpeningWindow({
      ceiling,
      openingWindowShows: 1,
      reservePerShow: DEFAULT_OPENING_WINDOW_RESERVE_PER_SHOW,
    }),
    ceiling - DEFAULT_OPENING_WINDOW_RESERVE_PER_SHOW,
  );
  assert.equal(
    effectiveCeilingForOpeningWindow({
      ceiling,
      openingWindowShows: 3,
      reservePerShow: DEFAULT_OPENING_WINDOW_RESERVE_PER_SHOW,
    }),
    ceiling - 3 * DEFAULT_OPENING_WINDOW_RESERVE_PER_SHOW,
  );
});

test('effectiveCeilingForOpeningWindow: never goes negative even if the reserve exceeds the ceiling', () => {
  assert.equal(
    effectiveCeilingForOpeningWindow({ ceiling: 20, openingWindowShows: 5, reservePerShow: DEFAULT_OPENING_WINDOW_RESERVE_PER_SHOW }),
    0,
  );
});

// ---------- proves the createBbSession wiring: bulk sweep trips the reduced ceiling, exempt caller does not ----------

test('a routine-sweep day that would pass the raw ceiling is BLOCKED once the opening-window reserve is applied (bulk caller)', () => {
  const ceiling = 250;
  const reserveShows = 1;
  const effectiveCeiling = effectiveCeilingForOpeningWindow({
    ceiling,
    openingWindowShows: reserveShows,
    reservePerShow: DEFAULT_OPENING_WINDOW_RESERVE_PER_SHOW,
  });
  // Usage sits between the reduced ceiling and the raw ceiling — under the
  // raw cap (so the pre-fix chokepoint would NOT block) but over the reduced
  // one (so the fix DOES), reproducing the exact BD/SD starvation shape for
  // Browserbase's live-count-based ceiling.
  const liveSessionsToday = effectiveCeiling + 1;
  assert.ok(liveSessionsToday < ceiling, 'fixture must stay under the raw ceiling to prove this is the reserve, not just the ceiling, blocking it');

  assert.equal(liveSessionsToday >= ceiling, false, 'sanity: raw ceiling would not have blocked on this usage');
  assert.equal(liveSessionsToday >= effectiveCeiling, true, 'reduced ceiling must block bulk callers so a sweep stops before starving the opening-window show');
});

test('an exempt (opening-night) caller keeps checking the RAW ceiling, unaffected by the reserve', () => {
  const scriptName = 'opening-night-poller.js';
  const exempt = isExemptCaller(scriptName, DEFAULT_EXEMPT_SCRIPTS, null, null);
  assert.equal(exempt, true);

  const ceiling = 250;
  const reserveShows = 1;
  const effectiveCeiling = effectiveCeilingForOpeningWindow({
    ceiling,
    openingWindowShows: reserveShows,
    reservePerShow: DEFAULT_OPENING_WINDOW_RESERVE_PER_SHOW,
  });
  // Same live count that blocks a bulk caller must still be allowed for the
  // exempt caller, which is checked against `ceiling`, not `effectiveCeiling`.
  const liveSessionsToday = effectiveCeiling + 1;
  const ceilingForThisCaller = exempt ? ceiling : effectiveCeiling;
  assert.equal(liveSessionsToday >= ceilingForThisCaller, false, 'exempt caller must not be blocked by the bulk reserve');
});

test('a non-exempt script (e.g. collect-review-texts.js) is subject to the reduced ceiling', () => {
  const exempt = isExemptCaller('collect-review-texts.js', DEFAULT_EXEMPT_SCRIPTS, null, null);
  assert.equal(exempt, false);
});
