/**
 * Unit tests for the Coverage Verdict S4 returning-production protocol:
 * scripts/lib/wrong-production-autoclear.js's isWithinTourLeg/hasDeclaredTourLegs
 * and scripts/lib/tour-legs-validation.js's validation rails (corroboration
 * required, no overlap with a declared priorRuns window at the same venue).
 *
 * Run: node --test tests/unit/tour-legs-validation.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { isWithinTourLeg, hasDeclaredTourLegs, REVIEW_LAG_GRACE_DAYS } = require('../../scripts/lib/wrong-production-autoclear');
const {
  tourLegMissingCorroboration,
  tourLegMissingVenue,
  tourLegMissingStartDate,
  tourLegHasReversedRange,
  tourLegOverlapsPriorRun,
  validateShowTourLegs,
} = require('../../scripts/lib/tour-legs-validation');

describe('isWithinTourLeg', () => {
  it('false for null/empty reviewDate or tourLegs', () => {
    assert.strictEqual(isWithinTourLeg(null, [{ startDate: '2025-04-15' }]), false);
    assert.strictEqual(isWithinTourLeg('', [{ startDate: '2025-04-15' }]), false);
    assert.strictEqual(isWithinTourLeg('2025-04-20', undefined), false);
    assert.strictEqual(isWithinTourLeg('2025-04-20', null), false);
    assert.strictEqual(isWithinTourLeg('2025-04-20', []), false);
  });

  it('true when the date falls inside a leg window (explicit endDate)', () => {
    assert.strictEqual(
      isWithinTourLeg('2025-04-20', [
        { venue: 'Ahmanson Theatre', startDate: '2025-04-15', endDate: '2025-05-25', corroborationUrl: 'https://example.com/a' },
      ]),
      true
    );
  });

  it('false when the date falls outside every leg window (incl. grace)', () => {
    assert.strictEqual(
      isWithinTourLeg('2025-06-02', [
        { venue: 'Ahmanson Theatre', startDate: '2025-04-15', endDate: '2025-05-25', corroborationUrl: 'https://example.com/a' },
      ]),
      false
    );
  });

  it('BRO-2561: grants REVIEW_LAG_GRACE_DAYS of lag past endDate', () => {
    const legs = [
      { venue: 'Ahmanson Theatre', startDate: '2025-04-15', endDate: '2025-05-25', corroborationUrl: 'https://example.com/a' },
    ];
    // Exactly at the grace boundary — still within.
    assert.strictEqual(isWithinTourLeg('2025-06-01', legs), true);
    // One day past the grace boundary — outside.
    assert.strictEqual(isWithinTourLeg('2025-06-02', legs), false);
    assert.strictEqual(REVIEW_LAG_GRACE_DAYS, 7);
  });

  it('BRO-2561: does not extend the 180-day default window when endDate is absent', () => {
    // 2025-04-15 + 180d = 2025-10-12; grace only applies to an explicit endDate.
    assert.strictEqual(
      isWithinTourLeg('2025-10-12', [{ venue: 'Some Venue', startDate: '2025-04-15', corroborationUrl: 'https://example.com/a' }]),
      true
    );
    assert.strictEqual(
      isWithinTourLeg('2025-10-19', [{ venue: 'Some Venue', startDate: '2025-04-15', corroborationUrl: 'https://example.com/a' }]),
      false
    );
  });

  it('BRO-2561: a strict match in a later leg beats a graced match in an earlier one', () => {
    // Leg A closes June 1; leg B opens June 3 (a back-to-back tour stop
    // change, the norm for tourLegs). A June 4 review is genuinely B's own
    // opening-week coverage — it must not be swallowed by A's grace tail
    // just because A comes first in the array.
    const legs = [
      { venue: 'Venue A', startDate: '2025-04-15', endDate: '2025-06-01', corroborationUrl: 'https://example.com/a' },
      { venue: 'Venue B', startDate: '2025-06-03', endDate: '2025-06-20', corroborationUrl: 'https://example.com/b' },
    ];
    assert.strictEqual(isWithinTourLeg('2025-06-04', legs), true);
  });

  it('defaults endDate to startDate + 180 days when missing', () => {
    assert.strictEqual(
      isWithinTourLeg('2025-09-01', [{ venue: 'Some Venue', startDate: '2025-04-15', corroborationUrl: 'https://example.com/a' }]),
      true
    );
    assert.strictEqual(
      isWithinTourLeg('2025-12-01', [{ venue: 'Some Venue', startDate: '2025-04-15', corroborationUrl: 'https://example.com/a' }]),
      false
    );
  });

  it('true when covered by ANY of several legs', () => {
    assert.strictEqual(
      isWithinTourLeg('2025-08-01', [
        { venue: 'Venue A', startDate: '2025-01-01', endDate: '2025-02-01', corroborationUrl: 'https://example.com/a' },
        { venue: 'Venue B', startDate: '2025-07-15', endDate: '2025-08-15', corroborationUrl: 'https://example.com/b' },
      ]),
      true
    );
  });

  it('skips a leg with no startDate and still checks the rest', () => {
    assert.strictEqual(
      isWithinTourLeg('2025-08-01', [
        { venue: 'Venue A', corroborationUrl: 'https://example.com/a' },
        { venue: 'Venue B', startDate: '2025-07-15', endDate: '2025-08-15', corroborationUrl: 'https://example.com/b' },
      ]),
      true
    );
  });
});

describe('hasDeclaredTourLegs', () => {
  it('true when a tourLegs entry has a startDate', () => {
    assert.strictEqual(
      hasDeclaredTourLegs({ tourLegs: [{ venue: 'Ahmanson Theatre', startDate: '2025-04-15' }] }),
      true
    );
  });

  it('false when tourLegs is missing or empty', () => {
    assert.strictEqual(hasDeclaredTourLegs({}), false);
    assert.strictEqual(hasDeclaredTourLegs({ tourLegs: [] }), false);
  });

  it('false when no tourLegs entry carries a startDate', () => {
    assert.strictEqual(hasDeclaredTourLegs({ tourLegs: [{ venue: 'Somewhere' }] }), false);
  });

  it('false for null/undefined show', () => {
    assert.strictEqual(hasDeclaredTourLegs(null), false);
    assert.strictEqual(hasDeclaredTourLegs(undefined), false);
  });
});

describe('tourLegMissingCorroboration', () => {
  it('true when corroborationUrl is absent, empty, or whitespace', () => {
    assert.strictEqual(tourLegMissingCorroboration({ venue: 'X', startDate: '2025-04-15' }), true);
    assert.strictEqual(tourLegMissingCorroboration({ venue: 'X', startDate: '2025-04-15', corroborationUrl: '' }), true);
    assert.strictEqual(tourLegMissingCorroboration({ venue: 'X', startDate: '2025-04-15', corroborationUrl: '   ' }), true);
    assert.strictEqual(tourLegMissingCorroboration(null), true);
  });

  it('false when a non-empty corroborationUrl is present', () => {
    assert.strictEqual(
      tourLegMissingCorroboration({ venue: 'X', startDate: '2025-04-15', corroborationUrl: 'https://playbill.com/article/x' }),
      false
    );
  });
});

describe('tourLegOverlapsPriorRun', () => {
  const corroborated = 'https://playbill.com/article/tour-leg';

  it('true when the leg window overlaps a priorRun at the SAME venue', () => {
    const leg = { venue: 'Bushwick Starr', startDate: '2025-04-01', endDate: '2025-04-30', corroborationUrl: corroborated };
    const priorRuns = [{ venue: 'Bushwick Starr', openingDate: '2025-04-15', closingDate: '2025-05-15' }];
    assert.strictEqual(tourLegOverlapsPriorRun(leg, priorRuns), true);
  });

  it('false when the windows overlap but venues differ', () => {
    const leg = { venue: 'Ahmanson Theatre', startDate: '2025-04-01', endDate: '2025-04-30', corroborationUrl: corroborated };
    const priorRuns = [{ venue: 'Bushwick Starr', openingDate: '2025-04-15', closingDate: '2025-05-15' }];
    assert.strictEqual(tourLegOverlapsPriorRun(leg, priorRuns), false);
  });

  it('false when the venues match but windows do not overlap', () => {
    const leg = { venue: 'Bushwick Starr', startDate: '2025-01-01', endDate: '2025-01-31', corroborationUrl: corroborated };
    const priorRuns = [{ venue: 'Bushwick Starr', openingDate: '2025-04-15', closingDate: '2025-05-15' }];
    assert.strictEqual(tourLegOverlapsPriorRun(leg, priorRuns), false);
  });

  it('venue match is case/whitespace-insensitive', () => {
    const leg = { venue: '  BUSHWICK starr  ', startDate: '2025-04-01', endDate: '2025-04-30', corroborationUrl: corroborated };
    const priorRuns = [{ venue: 'Bushwick Starr', openingDate: '2025-04-15', closingDate: '2025-05-15' }];
    assert.strictEqual(tourLegOverlapsPriorRun(leg, priorRuns), true);
  });

  it('false when priorRuns is missing/empty or leg has no venue/date', () => {
    assert.strictEqual(tourLegOverlapsPriorRun({ venue: 'X', startDate: '2025-04-01' }, undefined), false);
    assert.strictEqual(tourLegOverlapsPriorRun({ venue: 'X', startDate: '2025-04-01' }, []), false);
    assert.strictEqual(
      tourLegOverlapsPriorRun({ startDate: '2025-04-01' }, [{ venue: 'X', openingDate: '2025-04-01' }]),
      false
    );
  });
});

describe('tourLegMissingVenue', () => {
  it('true when venue is absent, empty, or whitespace', () => {
    assert.strictEqual(tourLegMissingVenue({ startDate: '2026-01-10' }), true);
    assert.strictEqual(tourLegMissingVenue({ startDate: '2026-01-10', venue: '' }), true);
    assert.strictEqual(tourLegMissingVenue({ startDate: '2026-01-10', venue: '   ' }), true);
    assert.strictEqual(tourLegMissingVenue(null), true);
  });

  it('false when a non-empty venue is present', () => {
    assert.strictEqual(tourLegMissingVenue({ venue: 'Ahmanson Theatre' }), false);
  });
});

describe('tourLegMissingStartDate', () => {
  it('true when startDate is absent or unparseable', () => {
    assert.strictEqual(tourLegMissingStartDate({ venue: 'X' }), true);
    assert.strictEqual(tourLegMissingStartDate({ venue: 'X', startDate: 'not-a-date' }), true);
    assert.strictEqual(tourLegMissingStartDate(null), true);
  });

  it('false when startDate parses', () => {
    assert.strictEqual(tourLegMissingStartDate({ venue: 'X', startDate: '2026-01-10' }), false);
  });
});

describe('tourLegHasReversedRange', () => {
  it('true when endDate is before startDate', () => {
    assert.strictEqual(
      tourLegHasReversedRange({ startDate: '2026-02-14', endDate: '2026-01-10' }),
      true
    );
  });

  it('false when endDate is on/after startDate, or either date is missing/unparseable', () => {
    assert.strictEqual(tourLegHasReversedRange({ startDate: '2026-01-10', endDate: '2026-02-14' }), false);
    assert.strictEqual(tourLegHasReversedRange({ startDate: '2026-01-10', endDate: '2026-01-10' }), false);
    assert.strictEqual(tourLegHasReversedRange({ startDate: '2026-01-10' }), false);
    assert.strictEqual(tourLegHasReversedRange({ endDate: '2026-01-10' }), false);
  });
});

describe('validateShowTourLegs', () => {
  it('clean show with no tourLegs returns no issues', () => {
    assert.deepStrictEqual(validateShowTourLegs({ id: 'x', tourLegs: [] }), []);
    assert.deepStrictEqual(validateShowTourLegs({ id: 'x' }), []);
  });

  it('a fully valid, corroborated, non-overlapping leg produces no issues', () => {
    const show = {
      id: 'some-tour-2026',
      tourLegs: [
        { venue: 'Ahmanson Theatre', startDate: '2026-01-10', endDate: '2026-02-14', corroborationUrl: 'https://playbill.com/a' },
      ],
      priorRuns: [{ venue: 'Bushwick Starr', openingDate: '2023-01-01', closingDate: '2023-02-01' }],
    };
    assert.deepStrictEqual(validateShowTourLegs(show), []);
  });

  it('rejects a leg missing corroborationUrl', () => {
    const show = {
      id: 'some-tour-2026',
      tourLegs: [{ venue: 'Ahmanson Theatre', startDate: '2026-01-10', endDate: '2026-02-14' }],
    };
    const issues = validateShowTourLegs(show);
    assert.strictEqual(issues.length, 1);
    assert.match(issues[0], /missing a corroborationUrl/);
  });

  it('rejects a leg overlapping a priorRuns window at the same venue', () => {
    const show = {
      id: 'some-tour-2026',
      tourLegs: [
        { venue: 'Bushwick Starr', startDate: '2025-04-01', endDate: '2025-04-30', corroborationUrl: 'https://playbill.com/a' },
      ],
      priorRuns: [{ venue: 'Bushwick Starr', openingDate: '2025-04-15', closingDate: '2025-05-15' }],
    };
    const issues = validateShowTourLegs(show);
    assert.strictEqual(issues.length, 1);
    assert.match(issues[0], /overlaps a declared priorRuns window/);
  });

  it('a leg can fail BOTH rails at once (two issues)', () => {
    const show = {
      id: 'some-tour-2026',
      tourLegs: [{ venue: 'Bushwick Starr', startDate: '2025-04-01', endDate: '2025-04-30' }],
      priorRuns: [{ venue: 'Bushwick Starr', openingDate: '2025-04-15', closingDate: '2025-05-15' }],
    };
    const issues = validateShowTourLegs(show);
    assert.strictEqual(issues.length, 2);
  });

  it('rejects a leg missing venue', () => {
    const show = {
      id: 'some-tour-2026',
      tourLegs: [{ startDate: '2026-01-10', endDate: '2026-02-14', corroborationUrl: 'https://playbill.com/a' }],
    };
    const issues = validateShowTourLegs(show);
    assert.strictEqual(issues.length, 1);
    assert.match(issues[0], /missing a venue/);
  });

  it('rejects a leg missing startDate', () => {
    const show = {
      id: 'some-tour-2026',
      tourLegs: [{ venue: 'Ahmanson Theatre', corroborationUrl: 'https://playbill.com/a' }],
    };
    const issues = validateShowTourLegs(show);
    assert.strictEqual(issues.length, 1);
    assert.match(issues[0], /missing a parseable startDate/);
  });

  it('rejects a leg with a reversed date range', () => {
    const show = {
      id: 'some-tour-2026',
      tourLegs: [{ venue: 'Ahmanson Theatre', startDate: '2026-02-14', endDate: '2026-01-10', corroborationUrl: 'https://playbill.com/a' }],
    };
    const issues = validateShowTourLegs(show);
    assert.strictEqual(issues.length, 1);
    assert.match(issues[0], /endDate before startDate/);
  });

  it('multiple legs are each validated independently', () => {
    const show = {
      id: 'some-tour-2026',
      tourLegs: [
        { venue: 'Ahmanson Theatre', startDate: '2026-01-10', endDate: '2026-02-14', corroborationUrl: 'https://playbill.com/a' },
        { venue: 'Kennedy Center', startDate: '2026-03-01', endDate: '2026-04-05' },
      ],
    };
    const issues = validateShowTourLegs(show);
    assert.strictEqual(issues.length, 1);
    assert.match(issues[0], /tourLegs\[1\]/);
  });
});
