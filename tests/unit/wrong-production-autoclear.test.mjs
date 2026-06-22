/**
 * Unit tests for scripts/lib/wrong-production-autoclear.js — the dual-guard
 * fix preventing rebuild from stripping wrongProduction/wrongShow flags that
 * were explicitly set by manual flags, audit scripts, or high-confidence CV.
 *
 * Historical incident: 2026-04-15 — audit-review-contamination flagged 5
 * cross-market files as wrongProduction=true. Local rebuild stripped all 5
 * within hours because they had allowEarlyDate:true. The auto-clear path
 * didn't check for an explicit wrongProductionReason, so cross-market
 * contamination kept reappearing on every rebuild.
 *
 * Run: node --test tests/unit/wrong-production-autoclear.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  shouldAutoClearWrongProduction,
  shouldAutoClearWrongShow,
  shouldAutoClearWrongProductionUrlYear,
  shouldAutoClearWrongShowUkUrl,
  isWithinPriorRun,
  hasDeclaredPriorRuns,
  shouldAutoClearWrongProductionPriorRun,
} = require('../../scripts/lib/wrong-production-autoclear');

describe('hasDeclaredPriorRuns (transfer discovery gate)', () => {
  it('true when a priorRuns entry has an openingDate', () => {
    assert.strictEqual(
      hasDeclaredPriorRuns({
        priorRuns: [{ venue: "St. Luke's Theatre", openingDate: '2026-05-11', closingDate: '2026-05-24' }],
      }),
      true
    );
  });

  it('false when priorRuns is missing or empty', () => {
    assert.strictEqual(hasDeclaredPriorRuns({}), false);
    assert.strictEqual(hasDeclaredPriorRuns({ priorRuns: [] }), false);
  });

  it('false when no priorRuns entry carries an openingDate', () => {
    assert.strictEqual(
      hasDeclaredPriorRuns({ priorRuns: [{ venue: 'Somewhere' }] }),
      false
    );
  });

  it('false for null/undefined show', () => {
    assert.strictEqual(hasDeclaredPriorRuns(null), false);
    assert.strictEqual(hasDeclaredPriorRuns(undefined), false);
  });
});

describe('shouldAutoClearWrongProduction', () => {
  it('returns false when wrongProduction is not set', () => {
    assert.strictEqual(shouldAutoClearWrongProduction({ allowEarlyDate: true }), false);
  });

  it('returns false when no allow* flag is present', () => {
    assert.strictEqual(shouldAutoClearWrongProduction({ wrongProduction: true }), false);
  });

  it('returns true when wrongProduction + allowEarlyDate, no reason, no CV', () => {
    assert.strictEqual(
      shouldAutoClearWrongProduction({ wrongProduction: true, allowEarlyDate: true }),
      true
    );
  });

  it('returns true when wrongProduction + allowCrossMarket, no reason, no CV', () => {
    assert.strictEqual(
      shouldAutoClearWrongProduction({ wrongProduction: true, allowCrossMarket: true }),
      true
    );
  });

  it('returns false when wrongProductionReason is set (audit-flagged)', () => {
    // Regression: 2026-04-15 cross-market audit fix was getting stripped
    assert.strictEqual(
      shouldAutoClearWrongProduction({
        wrongProduction: true,
        allowEarlyDate: true,
        wrongProductionReason: 'cross-market-audit-2026-04-15',
      }),
      false
    );
  });

  it('returns false when wrongProductionReason is set (manual flag)', () => {
    assert.strictEqual(
      shouldAutoClearWrongProduction({
        wrongProduction: true,
        allowCrossMarket: true,
        wrongProductionReason: 'manual:2026-04-11 systematic audit',
      }),
      false
    );
  });

  it('returns false when CV high-confidence wrongProduction is set', () => {
    assert.strictEqual(
      shouldAutoClearWrongProduction({
        wrongProduction: true,
        allowEarlyDate: true,
        contentVerification: { wrongProduction: true, confidence: 'high' },
      }),
      false
    );
  });

  it('returns true when CV is low confidence (low conf is not authoritative)', () => {
    assert.strictEqual(
      shouldAutoClearWrongProduction({
        wrongProduction: true,
        allowEarlyDate: true,
        contentVerification: { wrongProduction: true, confidence: 'low' },
      }),
      true
    );
  });

  it('returns true when CV has wrongProduction:false (CV says correct production)', () => {
    assert.strictEqual(
      shouldAutoClearWrongProduction({
        wrongProduction: true,
        allowEarlyDate: true,
        contentVerification: { wrongProduction: false, confidence: 'high' },
      }),
      true
    );
  });
});

describe('shouldAutoClearWrongShow', () => {
  it('returns false when wrongShow is not set', () => {
    assert.strictEqual(shouldAutoClearWrongShow({ allowEarlyDate: true }), false);
  });

  it('returns true when wrongShow + allowEarlyDate, no reason, no CV', () => {
    assert.strictEqual(
      shouldAutoClearWrongShow({ wrongShow: true, allowEarlyDate: true }),
      true
    );
  });

  it('returns false when wrongShowReason is set', () => {
    assert.strictEqual(
      shouldAutoClearWrongShow({
        wrongShow: true,
        allowCrossMarket: true,
        wrongShowReason: 'CV-promoted: review is for film adaptation',
      }),
      false
    );
  });

  it('returns false when CV high-confidence wrongArticle is set', () => {
    assert.strictEqual(
      shouldAutoClearWrongShow({
        wrongShow: true,
        allowEarlyDate: true,
        contentVerification: { wrongArticle: true, confidence: 'high' },
      }),
      false
    );
  });
});

describe('shouldAutoClearWrongProductionUrlYear', () => {
  const urlYearNote = 'URL contains year 2019 but show is 2025';

  it('returns false when wrongProduction is not set', () => {
    assert.strictEqual(
      shouldAutoClearWrongProductionUrlYear(
        { wrongProductionNote: urlYearNote },
        { isLondonOrOffBroadway: true }
      ),
      false
    );
  });

  it('returns false when note does not mention URL year', () => {
    assert.strictEqual(
      shouldAutoClearWrongProductionUrlYear(
        { wrongProduction: true, wrongProductionNote: 'Cross-market: US outlet reviewing London show' },
        { isLondonOrOffBroadway: true }
      ),
      false
    );
  });

  it('returns false when show is not London or off-Broadway', () => {
    assert.strictEqual(
      shouldAutoClearWrongProductionUrlYear(
        { wrongProduction: true, wrongProductionNote: urlYearNote },
        { isLondonOrOffBroadway: false }
      ),
      false
    );
  });

  it('returns true on WE/OB with URL-year note, no reason, no CV', () => {
    assert.strictEqual(
      shouldAutoClearWrongProductionUrlYear(
        { wrongProduction: true, wrongProductionNote: urlYearNote },
        { isLondonOrOffBroadway: true }
      ),
      true
    );
  });

  it('returns false when manual wrongProductionReason is set (audit-flagged WE show)', () => {
    // Regression: audit-flagged WE shows with URL-year note in background
    // were getting stripped because URL-year path ignored wrongProductionReason.
    assert.strictEqual(
      shouldAutoClearWrongProductionUrlYear(
        {
          wrongProduction: true,
          wrongProductionNote: urlYearNote,
          wrongProductionReason: 'manual:2026-04-12 prior-production verified',
        },
        { isLondonOrOffBroadway: true }
      ),
      false
    );
  });

  it('returns false when CV high-confidence wrongProduction is set', () => {
    assert.strictEqual(
      shouldAutoClearWrongProductionUrlYear(
        {
          wrongProduction: true,
          wrongProductionNote: urlYearNote,
          contentVerification: { wrongProduction: true, confidence: 'high' },
        },
        { isLondonOrOffBroadway: true }
      ),
      false
    );
  });

  it('returns false when CV high-confidence wrongArticle is set', () => {
    assert.strictEqual(
      shouldAutoClearWrongProductionUrlYear(
        {
          wrongProduction: true,
          wrongProductionNote: urlYearNote,
          contentVerification: { wrongArticle: true, confidence: 'high' },
        },
        { isLondonOrOffBroadway: true }
      ),
      false
    );
  });

  it('returns true when CV is low confidence (low conf is not authoritative)', () => {
    assert.strictEqual(
      shouldAutoClearWrongProductionUrlYear(
        {
          wrongProduction: true,
          wrongProductionNote: urlYearNote,
          contentVerification: { wrongProduction: true, confidence: 'low' },
        },
        { isLondonOrOffBroadway: true }
      ),
      true
    );
  });
});

describe('shouldAutoClearWrongShowUkUrl', () => {
  it('returns false when wrongShow is not set', () => {
    assert.strictEqual(
      shouldAutoClearWrongShowUkUrl(
        {},
        { isLondonMarketShow: true, isUkOutletUrl: true, dateMismatchOver90d: false }
      ),
      false
    );
  });

  it('returns false when show is not London market', () => {
    assert.strictEqual(
      shouldAutoClearWrongShowUkUrl(
        { wrongShow: true },
        { isLondonMarketShow: false, isUkOutletUrl: true, dateMismatchOver90d: false }
      ),
      false
    );
  });

  it('returns false when URL is not a UK outlet', () => {
    assert.strictEqual(
      shouldAutoClearWrongShowUkUrl(
        { wrongShow: true },
        { isLondonMarketShow: true, isUkOutletUrl: false, dateMismatchOver90d: false }
      ),
      false
    );
  });

  it('returns true on London show + UK URL + no reason + no CV + no date mismatch', () => {
    assert.strictEqual(
      shouldAutoClearWrongShowUkUrl(
        { wrongShow: true },
        { isLondonMarketShow: true, isUkOutletUrl: true, dateMismatchOver90d: false }
      ),
      true
    );
  });

  it('returns false when wrongShowReason is set (audit-flagged)', () => {
    // Regression: audit-flagged wrongShow on a London show with UK URL
    // would have been stripped by the old regex filter that missed manual reasons.
    assert.strictEqual(
      shouldAutoClearWrongShowUkUrl(
        { wrongShow: true, wrongShowReason: 'CV-promoted: review is about film adaptation' },
        { isLondonMarketShow: true, isUkOutletUrl: true, dateMismatchOver90d: false }
      ),
      false
    );
  });

  it('returns false when CV wrongArticle is set (any confidence)', () => {
    // Note: wrongShow UK URL path uses presence of wrongArticle, not confidence level,
    // matching the original inline guard.
    assert.strictEqual(
      shouldAutoClearWrongShowUkUrl(
        { wrongShow: true, contentVerification: { wrongArticle: true } },
        { isLondonMarketShow: true, isUkOutletUrl: true, dateMismatchOver90d: false }
      ),
      false
    );
  });

  it('returns false when review is >90 days before opening (prior production)', () => {
    assert.strictEqual(
      shouldAutoClearWrongShowUkUrl(
        { wrongShow: true },
        { isLondonMarketShow: true, isUkOutletUrl: true, dateMismatchOver90d: true }
      ),
      false
    );
  });
});

describe('isWithinPriorRun', () => {
  it('returns false for missing review date', () => {
    assert.strictEqual(isWithinPriorRun(null, [{ openingDate: '2025-04-15' }]), false);
    assert.strictEqual(isWithinPriorRun('', [{ openingDate: '2025-04-15' }]), false);
  });

  it('returns false for empty / missing priorRuns', () => {
    assert.strictEqual(isWithinPriorRun('2025-04-20', undefined), false);
    assert.strictEqual(isWithinPriorRun('2025-04-20', null), false);
    assert.strictEqual(isWithinPriorRun('2025-04-20', []), false);
  });

  it('returns true when review date falls inside an explicit window', () => {
    assert.strictEqual(
      isWithinPriorRun('2025-04-26', [
        { openingDate: '2025-04-15', closingDate: '2025-05-15', venue: 'Bushwick Starr' },
      ]),
      true
    );
  });

  it('returns false when review date is before window opening', () => {
    assert.strictEqual(
      isWithinPriorRun('2025-04-10', [
        { openingDate: '2025-04-15', closingDate: '2025-05-15' },
      ]),
      false
    );
  });

  it('returns false when review date is after window closing', () => {
    assert.strictEqual(
      isWithinPriorRun('2025-06-01', [
        { openingDate: '2025-04-15', closingDate: '2025-05-15' },
      ]),
      false
    );
  });

  it('uses 180-day default window when closingDate is missing', () => {
    // 2025-04-15 + 180d = ~2025-10-12
    assert.strictEqual(
      isWithinPriorRun('2025-09-01', [{ openingDate: '2025-04-15' }]),
      true
    );
    assert.strictEqual(
      isWithinPriorRun('2025-11-01', [{ openingDate: '2025-04-15' }]),
      false
    );
  });

  it('returns true when any window matches in a multi-run array', () => {
    const runs = [
      { openingDate: '2024-11-01', closingDate: '2024-12-31', venue: 'Bedlam' },
      { openingDate: '2025-04-15', closingDate: '2025-05-15', venue: 'Bushwick Starr' },
    ];
    assert.strictEqual(isWithinPriorRun('2024-11-17', runs), true);
    assert.strictEqual(isWithinPriorRun('2025-04-26', runs), true);
    assert.strictEqual(isWithinPriorRun('2025-01-15', runs), false);
  });

  it('skips priorRun entries with unparseable openingDate', () => {
    const runs = [
      { openingDate: 'not-a-date' },
      { openingDate: '2025-04-15', closingDate: '2025-05-15' },
    ];
    assert.strictEqual(isWithinPriorRun('2025-04-26', runs), true);
  });

  it('handles a Date object as input', () => {
    assert.strictEqual(
      isWithinPriorRun(new Date('2025-04-26'), [
        { openingDate: '2025-04-15', closingDate: '2025-05-15' },
      ]),
      true
    );
  });
});

describe('shouldAutoClearWrongProductionPriorRun', () => {
  const show = {
    priorRuns: [
      { openingDate: '2025-04-15', closingDate: '2025-05-15', venue: 'Bushwick Starr' },
    ],
  };

  it('returns true when Pre-opening guard flag now falls inside priorRuns', () => {
    assert.strictEqual(
      shouldAutoClearWrongProductionPriorRun(
        {
          wrongProduction: true,
          wrongProductionNote: 'Pre-opening guard: review dated 2025-04-26 is 90+ days before show starts 2026-04-14',
          publishDate: '2025-04-26',
        },
        show
      ),
      true
    );
  });

  it('returns true for Date guard flag when priorRuns covers', () => {
    assert.strictEqual(
      shouldAutoClearWrongProductionPriorRun(
        {
          wrongProduction: true,
          wrongProductionNote: 'Date guard: review 2025-05-08 is 292d before 2026-03-17',
          publishDate: '2025-05-08',
        },
        { priorRuns: [{ openingDate: '2025-05-01', closingDate: '2025-07-15' }] }
      ),
      true
    );
  });

  it('returns true for "Auto-flagged" prefix (gather-reviews.js Broadway path)', () => {
    assert.strictEqual(
      shouldAutoClearWrongProductionPriorRun(
        {
          wrongProduction: true,
          wrongProductionNote: 'Auto-flagged: published 365 days before show earliest date 2026-03-17',
          publishDate: '2025-05-08',
        },
        { priorRuns: [{ openingDate: '2025-05-01', closingDate: '2025-07-15' }] }
      ),
      true
    );
  });

  it('returns true for "Review published" prefix (rebuild per-review skip-pre-opening writer)', () => {
    assert.strictEqual(
      shouldAutoClearWrongProductionPriorRun(
        {
          wrongProduction: true,
          wrongProductionNote: 'Review published 365 days before show opened — likely reviewing a different production',
          publishDate: '2025-05-08',
        },
        { priorRuns: [{ openingDate: '2025-05-01', closingDate: '2025-07-15' }] }
      ),
      true
    );
  });

  it('returns true for anticipatory_pre_opening_post reason (collect-review-texts ingest gate)', () => {
    assert.strictEqual(
      shouldAutoClearWrongProductionPriorRun(
        {
          wrongProduction: true,
          wrongProductionReason: 'anticipatory_pre_opening_post',
          publishDate: '2025-05-08',
        },
        { priorRuns: [{ openingDate: '2025-05-01', closingDate: '2025-07-15' }] }
      ),
      true
    );
  });

  it('returns false for operator-set wrongProductionReason values (audit, manual:, human-verified)', () => {
    const operatorReasons = [
      'cross-market-audit-2026-04-15',
      'manual:2026-04-11 systematic audit',
      'human-verified prior staging',
    ];
    for (const reason of operatorReasons) {
      assert.strictEqual(
        shouldAutoClearWrongProductionPriorRun(
          {
            wrongProduction: true,
            wrongProductionNote: 'Pre-opening guard: review dated 2025-05-08',
            wrongProductionReason: reason,
            publishDate: '2025-05-08',
          },
          { priorRuns: [{ openingDate: '2025-05-01', closingDate: '2025-07-15' }] }
        ),
        false,
        `should NOT clear with operator reason: ${reason}`
      );
    }
  });

  it('returns true for CV-promoted: prefix (priorRuns trumps CV-promoted wrongProduction)', () => {
    // Phase 1 design: operator-declared priorRuns trumps CV's wrongProduction
    // (CV identifies a different venue/run, which is exactly what priorRuns IS for).
    const cvReasons = [
      'CV-promoted: This is a valid theater review of "X" but it reviews the production at Bushwick Starr',
      'CV-low-but-strong-signal: Cast members are from a later revival',
    ];
    for (const reason of cvReasons) {
      assert.strictEqual(
        shouldAutoClearWrongProductionPriorRun(
          {
            wrongProduction: true,
            wrongProductionReason: reason,
            publishDate: '2025-05-08',
          },
          { priorRuns: [{ openingDate: '2025-05-01', closingDate: '2025-07-15' }] }
        ),
        true,
        `should clear CV-auto reason: ${reason.substring(0, 50)}`
      );
    }
  });

  it('returns false for non-date-only prefixes (cross-market, URL contains year, transfer-superseded)', () => {
    const examples = [
      'Cross-market: London outlet "observer" reviewing off-broadway show',
      'URL contains year 2019 but show opens in 2025 — likely review of different production',
      'OB review superseded by Broadway transfer foo-2026 (shared URL)',
    ];
    for (const note of examples) {
      assert.strictEqual(
        shouldAutoClearWrongProductionPriorRun(
          {
            wrongProduction: true,
            wrongProductionNote: note,
            publishDate: '2025-05-08',
          },
          { priorRuns: [{ openingDate: '2025-05-01', closingDate: '2025-07-15' }] }
        ),
        false,
        `should NOT clear for note: ${note}`
      );
    }
  });

  it('returns false when priorRuns is missing on show', () => {
    assert.strictEqual(
      shouldAutoClearWrongProductionPriorRun(
        {
          wrongProduction: true,
          wrongProductionNote: 'Pre-opening guard: review dated 2025-04-26',
          publishDate: '2025-04-26',
        },
        {}
      ),
      false
    );
  });

  it('returns false when wrongProductionNote is not a date-only auto-flag', () => {
    assert.strictEqual(
      shouldAutoClearWrongProductionPriorRun(
        {
          wrongProduction: true,
          wrongProductionNote: 'Cross-market: London outlet reviewing off-broadway show',
          publishDate: '2025-04-26',
        },
        show
      ),
      false
    );
  });

  it('returns false when manual wrongProductionReason is set', () => {
    assert.strictEqual(
      shouldAutoClearWrongProductionPriorRun(
        {
          wrongProduction: true,
          wrongProductionNote: 'Pre-opening guard: review dated 2025-04-26',
          wrongProductionReason: 'manual: confirmed prior staging',
          publishDate: '2025-04-26',
        },
        show
      ),
      false
    );
  });

  it('returns true when CV high-conf wrongProduction is set (priorRuns trumps CV.wrongProduction)', () => {
    // Phase 1 design: operator-declared priorRuns is authoritative over CV's
    // wrongProduction. CV identifies a different venue/run, but priorRuns just
    // declared that venue/run is the same artistic production.
    assert.strictEqual(
      shouldAutoClearWrongProductionPriorRun(
        {
          wrongProduction: true,
          wrongProductionNote: 'Pre-opening guard: review dated 2025-04-26',
          publishDate: '2025-04-26',
          contentVerification: { wrongProduction: true, confidence: 'high' },
        },
        show
      ),
      true
    );
  });

  it('returns false when CV high-conf wrongArticle is set', () => {
    assert.strictEqual(
      shouldAutoClearWrongProductionPriorRun(
        {
          wrongProduction: true,
          wrongProductionNote: 'Pre-opening guard: review dated 2025-04-26',
          publishDate: '2025-04-26',
          contentVerification: { wrongArticle: true, confidence: 'high' },
        },
        show
      ),
      false
    );
  });

  it('returns false when publishDate is missing', () => {
    assert.strictEqual(
      shouldAutoClearWrongProductionPriorRun(
        {
          wrongProduction: true,
          wrongProductionNote: 'Pre-opening guard: review dated 2025-04-26',
        },
        show
      ),
      false
    );
  });

  it('returns false when publishDate is outside all priorRuns windows', () => {
    assert.strictEqual(
      shouldAutoClearWrongProductionPriorRun(
        {
          wrongProduction: true,
          wrongProductionNote: 'Pre-opening guard: review dated 2024-01-15',
          publishDate: '2024-01-15',
        },
        show
      ),
      false
    );
  });

  it('returns false when wrongProduction is not set', () => {
    assert.strictEqual(
      shouldAutoClearWrongProductionPriorRun(
        { publishDate: '2025-04-26' },
        show
      ),
      false
    );
  });
});
