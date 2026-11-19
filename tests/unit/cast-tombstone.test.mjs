// Unit tests for the cast backfill tombstone decision.
// Per feedback_test_extraction_pattern.md — tests the real module via require().

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const { shouldTombstone, shouldAbortMassWipe, parseIbdbProductionYear, isProductionYearMismatch } = require('../../scripts/lib/cast-tombstone');

describe('cast-tombstone shouldTombstone', () => {
  it('tombstones a GENUINE empty (page loaded, production has no IBDB cast)', () => {
    // extractCastFromIBDBPage parsed the page fine but found no OpeningNightCast.
    assert.equal(shouldTombstone({ found: false, openingNightCast: [], fetchFailed: false }), true);
  });

  it('does NOT tombstone a TRANSIENT fetch failure (page did not load)', () => {
    assert.equal(shouldTombstone({ found: false, openingNightCast: [], fetchFailed: true }), false);
  });

  it('does NOT tombstone a thrown-error / network failure', () => {
    // lookupIBDBCast catch path returns fetchFailed:true.
    assert.equal(shouldTombstone({ found: false, openingNightCast: [], fetchFailed: true }), false);
  });

  it('treats a missing fetchFailed flag as genuine empty (back-compat, tombstone)', () => {
    // Old result shape with no fetchFailed key → behave as before (tombstone).
    assert.equal(shouldTombstone({ found: false, openingNightCast: [] }), true);
  });

  it('handles a null/undefined result defensively (tombstone)', () => {
    assert.equal(shouldTombstone(null), true);
    assert.equal(shouldTombstone(undefined), true);
  });
});

describe('cast-tombstone shouldAbortMassWipe', () => {
  it('does not abort under the 30% threshold', () => {
    assert.equal(shouldAbortMassWipe(30, 8), false); // ~26.7%
  });

  it('aborts once wiped share crosses the 30% threshold', () => {
    assert.equal(shouldAbortMassWipe(30, 10), true); // exactly 33.3%
  });

  it('matches the task #712 incident shape (29-30 shows, all wiped)', () => {
    assert.equal(shouldAbortMassWipe(29, 29), true);
  });

  it('does not abort with zero wipes', () => {
    assert.equal(shouldAbortMassWipe(29, 0), false);
  });

  it('never aborts when nothing was populated beforehand (nothing to protect)', () => {
    assert.equal(shouldAbortMassWipe(0, 0), false);
  });

  it('respects a custom threshold', () => {
    assert.equal(shouldAbortMassWipe(10, 2, 0.1), true); // 20% > 10%
    assert.equal(shouldAbortMassWipe(10, 1, 0.1), false); // 10% is not > 10%
  });
});

describe('cast-tombstone production-year guard (BRO-4171)', () => {
  it('parses the production year from an IBDB <title>', () => {
    assert.equal(parseIbdbProductionYear('The Imaginary Invalid \u2013 Broadway Play \u2013 1967 Revival | IBDB'), 1967);
    assert.equal(parseIbdbProductionYear('Hamilton \u2013 Broadway Musical \u2013 Original | IBDB'), null);
    assert.equal(parseIbdbProductionYear(''), null);
    assert.equal(parseIbdbProductionYear(undefined), null);
  });
  it('rejects the 1967 revival for a 2026 show (the real bug)', () => {
    assert.equal(isProductionYearMismatch(1967, 2026), true);
  });
  it('accepts same/adjacent year and unknown years', () => {
    assert.equal(isProductionYearMismatch(2026, 2026), false);
    assert.equal(isProductionYearMismatch(2025, 2026), false);
    assert.equal(isProductionYearMismatch(null, 2026), false);
    assert.equal(isProductionYearMismatch(1967, null), false);
  });
});

// BRO-5809: announced shows have no openingDate, so a past-run IBDB cast slipped through.
describe('expectedOpeningYear / castFileMismatchReason (BRO-5809)', () => {
  const { expectedOpeningYear, castFileMismatchReason } = require('../../scripts/lib/cast-tombstone.js');
  const announced = { id: 'private-lives-2025', status: 'announced', openingDate: null };
  it('falls back to previews year, then the id year', () => {
    assert.equal(expectedOpeningYear({ openingDate: '2026-03-01', id: 'x-2020' }), 2026);
    assert.equal(expectedOpeningYear({ previewsStartDate: '2026-02-01', id: 'x' }), 2026);
    assert.equal(expectedOpeningYear(announced), 2025);
    assert.equal(expectedOpeningYear({ id: 'hamilton' }), null);
  });
  it('rejects the 1948 Private Lives cast for the 2025 announced show', () => {
    assert.equal(castFileMismatchReason({ ibdbUrl: 'u', productionYear: 1948 }, announced), 'year-mismatch');
  });
  it('rejects an unverifiable IBDB file on an unopened show, accepts web-search and matching years', () => {
    assert.equal(castFileMismatchReason({ ibdbUrl: 'u' }, announced), 'unverified-ibdb');
    assert.equal(castFileMismatchReason({ source: 'web-search' }, announced), null);
    assert.equal(castFileMismatchReason({ ibdbUrl: 'u', productionYear: 2025 }, announced), null);
    assert.equal(castFileMismatchReason({ ibdbUrl: 'u' }, { id: 'a-2025', status: 'open', openingDate: '2025-04-01' }), null);
  });
});

describe('BRO-5809 review follow-ups', () => {
  const { shouldTombstone, expectedOpeningYear, castFileMismatchReason } = require('../../scripts/lib/cast-tombstone.js');
  it('never tombstones a wrong-production result', () => {
    assert.equal(shouldTombstone({ productionMismatch: true }), false);
    assert.equal(shouldTombstone({}), true);
  });
  it('ignores the id year for shows that already opened or are running', () => {
    assert.equal(expectedOpeningYear({ id: 'harry-potter-2021', status: 'open' }), null);
    assert.equal(expectedOpeningYear({ id: 'x-2026', status: 'upcoming' }), 2026);
  });
  it('covers upcoming shows in the unverified-ibdb rule', () => {
    assert.equal(castFileMismatchReason({ ibdbUrl: 'u' }, { id: 'x-2026', status: 'upcoming' }), 'unverified-ibdb');
  });
});

describe('BRO-7665 cast-not-applicable shows', () => {
  const { classifyCastCoverage, CAST_NOT_APPLICABLE_SHOW_IDS } = require('../../scripts/lib/cast-tombstone.js');
  const empty = { openingNightCast: [], scrapedAt: '2026-09-24T13:56:13.096Z' };
  it('never reports an anonymous-performer show as a coverage gap', () => {
    const show = { id: 'blue-man-group-a-new-holiday-surprise-2026', status: 'open', openingDate: '2026-11-17' };
    assert.equal(classifyCastCoverage(show, empty, Date.parse('2026-12-30')), 'not-applicable');
    assert.equal(classifyCastCoverage(show, null, Date.parse('2026-12-30')), 'not-applicable');
  });
  it('still flags an ordinary show with the same empty file', () => {
    const show = { id: 'ordinary-2026', status: 'open', openingDate: '2026-11-17' };
    assert.equal(classifyCastCoverage(show, empty, Date.parse('2026-12-30')), 'exhausted');
    assert.equal(CAST_NOT_APPLICABLE_SHOW_IDS.has('ordinary-2026'), false);
  });
});

describe('BRO-7665 backfill does not re-scrape cast-not-applicable shows', () => {
  const { shouldRetryTombstone } = require('../../scripts/lib/cast-tombstone.js');
  it('skips the daily tombstone retry', () => {
    const show = { id: 'blue-man-group-a-new-holiday-surprise-2026', status: 'open', openingDate: '2026-11-17' };
    assert.equal(shouldRetryTombstone({ openingNightCast: [], scrapedAt: '2026-09-24T00:00:00Z' }, show, Date.parse('2026-11-18')), false);
  });
});

describe('shouldRetryTombstone: IBDB page appeared after an empty scrape (Dirty Dancing 2027, feedback #1192)', () => {
  const { shouldRetryTombstone } = require('../../scripts/lib/cast-tombstone.js');
  const now = Date.parse('2026-11-19');
  const upcoming = { id: 'dirty-dancing-2027', status: 'upcoming', openingDate: '2027-03-14', ibdbUrl: 'https://www.ibdb.com/broadway-production/dirty-dancing-the-musical-548291' };
  it('retries an upcoming show whose empty tombstone predates its IBDB url', () => {
    assert.equal(shouldRetryTombstone({ ibdbUrl: null, openingNightCast: [], scrapedAt: '2026-10-07T13:50:30Z' }, upcoming, now), true);
  });
  it('is one-shot: once the tombstone carries the url, an upcoming show is not retried', () => {
    assert.equal(shouldRetryTombstone({ ibdbUrl: upcoming.ibdbUrl, openingNightCast: [], scrapedAt: '2026-11-19T00:00:00Z' }, upcoming, now), false);
  });
  it('does not retry when the show still has no IBDB url', () => {
    assert.equal(shouldRetryTombstone({ ibdbUrl: null, openingNightCast: [], scrapedAt: '2026-10-07T13:50:30Z' }, { ...upcoming, ibdbUrl: null }, now), false);
  });
  it('never retries a populated cast file', () => {
    assert.equal(shouldRetryTombstone({ ibdbUrl: null, openingNightCast: [{ name: 'X' }], scrapedAt: '2026-10-07T13:50:30Z' }, upcoming, now), false);
  });
});
