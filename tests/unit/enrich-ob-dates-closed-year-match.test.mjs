// --include-closed-when-year-matches (2026 data audit, S2-T11).
//
// scripts/enrich-off-broadway-dates.js never repaired closed OB rows: its
// status allowlist admits only open/previews/upcoming/announced, because a
// closed row's title can be reused by a later production and the schedule
// article would feed that production's dates into the historical entry
// (Romeo & Juliet Suite 2026). The flag admits closed rows, but a closed row
// may take a date ONLY from a Playbill production page whose year equals the
// row's own year (openingDate, else previewsStartDate, else the id's trailing
// year). These tests require the REAL exported decision functions from
// scripts/lib/ob-date-fix-eligibility.js (CLAUDE.md §15 — no copied logic)
// and pin the script's wiring to them.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const {
  ELIGIBLE_STATUSES,
  getShowOpeningYear,
  isStatusEligibleForDateFix,
  isEligibleForDateFix,
} = require('../../scripts/lib/ob-date-fix-eligibility.js');
// The script's own Phase 3 queue predicate — exported for its colocated test,
// reused here so the closed-row admission is exercised on the real function.
const { isPhase3DefaultCandidate } = require('../../scripts/enrich-off-broadway-dates.js');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = path.join(HERE, '..', '..', 'scripts', 'enrich-off-broadway-dates.js');

const FLAG = { includeClosedWhenYearMatches: true };
const NO_FLAG = { includeClosedWhenYearMatches: false };

const closed2025 = {
  id: 'heathers-the-musical-off-broadway-2025',
  status: 'closed',
  openingDate: '2025-07-10',
  previewsStartDate: '2025-07-10', // IBDB same-date class
  openingDateSource: 'ibdb',
};

// ---------------------------------------------------------------------------
// isEligibleForDateFix — closed rows
// ---------------------------------------------------------------------------

test('closed row + Playbill year equal to its own year is eligible WITH the flag', () => {
  assert.equal(isEligibleForDateFix(closed2025, 2025, FLAG), true);
  // URL-derived years may arrive as strings; equality is numeric.
  assert.equal(isEligibleForDateFix(closed2025, '2025', FLAG), true);
});

test('closed row + a different Playbill year is NOT eligible, even with the flag', () => {
  // The ±1-year window that the page-title validator allows is NOT enough
  // for a closed row — exact equality only.
  assert.equal(isEligibleForDateFix(closed2025, 2024, FLAG), false);
  assert.equal(isEligibleForDateFix(closed2025, 2026, FLAG), false);
  assert.equal(isEligibleForDateFix(closed2025, 2019, FLAG), false);
});

test('closed row with NO Playbill page year (schedule article / Lortel entry) is NOT eligible', () => {
  // This is the Romeo & Juliet Suite guard: the schedule article lists
  // upcoming runs and carries no production-page year, so it can never
  // feed a closed row.
  assert.equal(isEligibleForDateFix(closed2025, null, FLAG), false);
  assert.equal(isEligibleForDateFix(closed2025, undefined, FLAG), false);
  assert.equal(isEligibleForDateFix(closed2025, '', FLAG), false);
  assert.equal(isEligibleForDateFix(closed2025, 'n/a', FLAG), false);
});

test('closed row WITHOUT the flag is never eligible, even when the year matches', () => {
  assert.equal(isEligibleForDateFix(closed2025, 2025, NO_FLAG), false);
  assert.equal(isEligibleForDateFix(closed2025, 2025, {}), false);
  assert.equal(isEligibleForDateFix(closed2025, 2025), false);
});

test('closed row year precedence: openingDate, else previewsStartDate, else id year', () => {
  const byOpening = { id: 'x-off-broadway-2023', status: 'closed', openingDate: '2025-03-01', previewsStartDate: '2024-12-30' };
  assert.equal(getShowOpeningYear(byOpening), 2025);
  assert.equal(isEligibleForDateFix(byOpening, 2025, FLAG), true);
  assert.equal(isEligibleForDateFix(byOpening, 2024, FLAG), false);
  assert.equal(isEligibleForDateFix(byOpening, 2023, FLAG), false);

  const byPreviews = { id: 'x-off-broadway-2023', status: 'closed', openingDate: null, previewsStartDate: '2024-12-30' };
  assert.equal(getShowOpeningYear(byPreviews), 2024);
  assert.equal(isEligibleForDateFix(byPreviews, 2024, FLAG), true);
  assert.equal(isEligibleForDateFix(byPreviews, 2023, FLAG), false);

  const byId = { id: 'x-off-broadway-2023', status: 'closed', openingDate: null, previewsStartDate: null };
  assert.equal(getShowOpeningYear(byId), 2023);
  assert.equal(isEligibleForDateFix(byId, 2023, FLAG), true);
  assert.equal(isEligibleForDateFix(byId, 2024, FLAG), false);

  const noYear = { id: 'x-off-broadway', status: 'closed', openingDate: null, previewsStartDate: null };
  assert.equal(getShowOpeningYear(noYear), null);
  assert.equal(isEligibleForDateFix(noYear, 2023, FLAG), false);
});

// ---------------------------------------------------------------------------
// isEligibleForDateFix — non-closed rows are unchanged by the flag
// ---------------------------------------------------------------------------

test('open/previews/upcoming/announced rows are eligible with or without the flag, whatever the year', () => {
  for (const status of ['open', 'previews', 'upcoming', 'announced']) {
    const show = { id: `s-off-broadway-2026`, status, openingDate: '2026-04-01', previewsStartDate: '2026-04-01' };
    for (const opts of [FLAG, NO_FLAG, {}, undefined]) {
      for (const year of [2026, 2025, 2027, null, undefined]) {
        assert.equal(isEligibleForDateFix(show, year, opts), true, `${status} year=${year} opts=${JSON.stringify(opts)}`);
      }
    }
  }
});

test('cancelled/postponed/transferred rows are never eligible, with or without the flag', () => {
  for (const status of ['cancelled', 'postponed', 'transferred']) {
    const show = { id: 's-off-broadway-2026', status, openingDate: '2026-04-01' };
    assert.equal(isEligibleForDateFix(show, 2026, FLAG), false, status);
    assert.equal(isEligibleForDateFix(show, 2026, NO_FLAG), false, status);
  }
  assert.equal(isEligibleForDateFix(null, 2026, FLAG), false);
  assert.equal(isEligibleForDateFix(undefined, 2026, FLAG), false);
});

// ---------------------------------------------------------------------------
// isStatusEligibleForDateFix — pool admission
// ---------------------------------------------------------------------------

test('pool admission: the allowlist is exactly the pre-flag set', () => {
  assert.deepEqual([...ELIGIBLE_STATUSES].sort(), ['announced', 'open', 'previews', 'upcoming']);
});

test('pool admission: closed rows enter the pool only under the flag; other statuses unchanged', () => {
  assert.equal(isStatusEligibleForDateFix({ status: 'closed' }, FLAG), true);
  assert.equal(isStatusEligibleForDateFix({ status: 'closed' }, NO_FLAG), false);
  assert.equal(isStatusEligibleForDateFix({ status: 'closed' }), false);
  for (const status of ['open', 'previews', 'upcoming', 'announced']) {
    assert.equal(isStatusEligibleForDateFix({ status }, FLAG), true, status);
    assert.equal(isStatusEligibleForDateFix({ status }, NO_FLAG), true, status);
  }
  for (const status of ['cancelled', 'postponed', 'transferred', undefined]) {
    assert.equal(isStatusEligibleForDateFix({ status }, FLAG), false, String(status));
    assert.equal(isStatusEligibleForDateFix({ status }, NO_FLAG), false, String(status));
  }
  assert.equal(isStatusEligibleForDateFix(null, FLAG), false);
});

// ---------------------------------------------------------------------------
// Phase 3 default queue — closed null-opening rows are probed only under the flag
// ---------------------------------------------------------------------------

test('Phase 3 queue: closed row with no openingDate is probed only with includeClosed (same recency window)', () => {
  const today = '2026-09-28';
  const recentClosed = { id: 'r-off-broadway-2026', status: 'closed', openingDate: null, previewsStartDate: '2026-08-01' };
  assert.equal(isPhase3DefaultCandidate(recentClosed, today), false);
  assert.equal(isPhase3DefaultCandidate(recentClosed, today, {}), false);
  assert.equal(isPhase3DefaultCandidate(recentClosed, today, { includeClosed: true }), true);
  // Older than the 120-day lookback: still not queued by default (--phase3-broad widens).
  const oldClosed = { id: 'o-off-broadway-2025', status: 'closed', openingDate: null, previewsStartDate: '2025-08-01' };
  assert.equal(isPhase3DefaultCandidate(oldClosed, today, { includeClosed: true }), false);
  // Same-date class is queued regardless of status (pre-existing behaviour).
  const sameDateClosed = { id: 'c-off-broadway-2026', status: 'closed', openingDate: '2026-05-05', previewsStartDate: '2026-05-05' };
  assert.equal(isPhase3DefaultCandidate(sameDateClosed, today), true);
  // Open / previews rows unchanged by the option.
  const live = { id: 'l-off-broadway-2026', status: 'previews', openingDate: null, previewsStartDate: '2026-09-11' };
  assert.equal(isPhase3DefaultCandidate(live, today), true);
  assert.equal(isPhase3DefaultCandidate(live, today, { includeClosed: true }), true);
});

// ---------------------------------------------------------------------------
// Wiring — the script calls the real lib, no inline copy of the allowlist
// ---------------------------------------------------------------------------

test('wiring: enrich-off-broadway-dates.js requires the lib and calls both eligibility functions', () => {
  const src = fs.readFileSync(SCRIPT_PATH, 'utf8');
  assert.match(src, /require\('\.\/lib\/ob-date-fix-eligibility'\)/, 'script must require scripts/lib/ob-date-fix-eligibility');
  assert.match(src, /isStatusEligibleForDateFix\(s, \{ includeClosedWhenYearMatches \}\)/, 'pool filter must call isStatusEligibleForDateFix');
  assert.match(src, /isEligibleForDateFix\(show, entry\.playbillYear \?\? null, \{ includeClosedWhenYearMatches \}\)/, 'Phase 4 must call isEligibleForDateFix with the page year');
  assert.match(src, /args\.includes\('--include-closed-when-year-matches'\)/, 'flag must be parsed from argv');
  // The inline allowlist must not survive as a second copy of the decision.
  assert.doesNotMatch(src, /const ELIGIBLE_STATUSES = new Set\(/, 'inline ELIGIBLE_STATUSES copy must be gone (lib owns it)');
  // Closed rows never title-match schedule/Lortel entries (Romeo & Juliet Suite guard).
  assert.match(src, /matchTitleToShow\(entry\.title, titleMatchShows,/, 'Phase 4 fuzzy match must use the non-closed pool');
  assert.match(src, /matchTitleToShow\(entry\.title, titleMatchCandidates,/, 'alreadyMatched must use the non-closed candidate pool');
  // Summary + per-id skip logging.
  assert.match(src, /skipped \(Playbill year mismatch\)/, 'run summary must report closed rows skipped for year mismatch');
  assert.match(src, /SKIP \$\{show\.id\}: closed row/, 'each skipped closed id must be logged');
});
