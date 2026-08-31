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
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirnameCompat = path.dirname(fileURLToPath(import.meta.url));

const require = createRequire(import.meta.url);
const {
  shouldAutoClearWrongProduction,
  shouldAutoClearWrongShow,
  shouldAutoClearWrongProductionUrlYear,
  shouldAutoClearWrongShowUkUrl,
  isWithinPriorRun,
  REVIEW_LAG_GRACE_DAYS,
  hasDeclaredPriorRuns,
  shouldAutoClearWrongProductionPriorRun,
  shouldAutoClearStaleDateGuard,
  shouldAutoClearAnticipatoryGrace,
  hasEnsembleConsensus,
  shouldAutoClearWrongProductionTourLeg,
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

  it('returns false when a 2+ model ensemble consensus named a different show (task #1146)', () => {
    assert.strictEqual(
      shouldAutoClearWrongShow({
        wrongShow: true,
        allowCrossMarket: true,
        rejectionReason: 'wrong_show',
        rejectedBy: 'ensemble-scoreability-check',
        rejectionReasoning: "claude: This is a review of Noughts & Crosses; openai: This is about Noughts & Crosses, not Romeo and Juliet.",
      }),
      false
    );
  });

  it('returns false when fetched text predates a later URL rewrite (task #1146)', () => {
    assert.strictEqual(
      shouldAutoClearWrongShow({
        wrongShow: true,
        allowCrossMarket: true,
        urlCorrectedFrom: 'https://example.com/old-article',
        urlUpdatedAt: '2026-04-03T17:01:15.864Z',
        textFetchedAt: '2026-02-26T03:18:04.314Z',
      }),
      false
    );
  });
});

describe('shouldAutoClearWrongProductionUrlYear', () => {
  // Task #1193: this predicate was dead code — the real rebuild-all-reviews.js
  // call site ran its own diverging inline logic. Ctx shape (cvBlocksClear,
  // isShowListingUrl) now mirrors what the caller actually computes and
  // passes in — same pattern as shouldAutoClearWrongProductionUkDualMarket.
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

  it('returns false when caller-computed cvBlocksClear is true (CV wrongProduction/wrongArticle/non-review-articleType)', () => {
    assert.strictEqual(
      shouldAutoClearWrongProductionUrlYear(
        { wrongProduction: true, wrongProductionNote: urlYearNote },
        { isLondonOrOffBroadway: true, cvBlocksClear: true }
      ),
      false
    );
  });

  it('returns true when cvBlocksClear is false (e.g. CV was only low confidence)', () => {
    assert.strictEqual(
      shouldAutoClearWrongProductionUrlYear(
        { wrongProduction: true, wrongProductionNote: urlYearNote },
        { isLondonOrOffBroadway: true, cvBlocksClear: false }
      ),
      true
    );
  });

  it('returns false when isShowListingUrl is true (whatsonstage/broadwayworld /shows/ aggregate page)', () => {
    // Cousin of the Birmingham-Rep whatsonstage /shows/ stub incident
    // (2026-07-05) — a listing page URL-year mismatch is not a dated
    // review's false positive.
    assert.strictEqual(
      shouldAutoClearWrongProductionUrlYear(
        { wrongProduction: true, wrongProductionNote: urlYearNote },
        { isLondonOrOffBroadway: true, isShowListingUrl: true }
      ),
      false
    );
  });

  it('returns false on ensemble wrong_production consensus (outranks the URL-year heuristic)', () => {
    assert.strictEqual(
      shouldAutoClearWrongProductionUrlYear(
        {
          wrongProduction: true,
          wrongProductionNote: urlYearNote,
          rejectedBy: 'ensemble-scoreability-check',
          rejectionReason: 'wrong_production',
          rejectionReasoning:
            "claude: This review is about a different production; "
            + "gemini: The text is a review of a different production.",
        },
        { isLondonOrOffBroadway: true }
      ),
      false
    );
  });

  it('returns false when fetched text predates a later URL rewrite (stale-text guard)', () => {
    assert.strictEqual(
      shouldAutoClearWrongProductionUrlYear(
        {
          wrongProduction: true,
          wrongProductionNote: urlYearNote,
          urlCorrectedFrom: 'https://example.com/old-article',
          urlUpdatedAt: '2026-04-03T17:01:15.864Z',
          textFetchedAt: '2026-02-26T03:18:04.314Z',
        },
        { isLondonOrOffBroadway: true }
      ),
      false
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

  it('returns false on a 3/3 ensemble wrong_show verdict naming a different show (task #1146 regression)', () => {
    // romeo-and-juliet-west-end-2026/london-theatre--holly-omahony.json: URL
    // pointed at the R&J page, but all 3 models independently identified the
    // fetched text as a review of a different show (Noughts & Crosses).
    assert.strictEqual(
      shouldAutoClearWrongShowUkUrl(
        {
          wrongShow: true,
          rejectionReason: 'wrong_show',
          rejectedBy: 'ensemble-scoreability-check',
          rejectionReasoning:
            "claude: This review is about 'Noughts & Crosses' at Regent's Park Open Air Theatre, not 'Romeo and Juliet' at Harold Pinter Theatre; " +
            "openai: The text is a review of 'Noughts & Crosses' at the Regent's Park Open Air Theatre, not 'Romeo and Juliet' at the Harold Pinter Theatre.; " +
            "gemini: This review is for Noughts & Crosses at Regent's Park Open Air Theatre, not Romeo and Juliet at Harold Pinter Theatre.",
        },
        { isLondonMarketShow: true, isUkOutletUrl: true, dateMismatchOver90d: false }
      ),
      false
    );
  });

  it('returns false when fetched text predates a later URL rewrite (task #1146)', () => {
    assert.strictEqual(
      shouldAutoClearWrongShowUkUrl(
        {
          wrongShow: true,
          urlCorrectedFrom: 'https://example.com/old-sondheim-review',
          urlUpdatedFrom: 'https://example.com/old-sondheim-review',
          urlUpdatedAt: '2026-04-03T17:01:15.864Z',
          textFetchedAt: '2026-02-26T03:18:04.314Z',
        },
        { isLondonMarketShow: true, isUkOutletUrl: true, dateMismatchOver90d: false }
      ),
      false
    );
  });

  it('still clears on a single-model rejection (not a >=2-model consensus)', () => {
    assert.strictEqual(
      shouldAutoClearWrongShowUkUrl(
        {
          wrongShow: true,
          rejectionReason: 'wrong_show',
          rejectedBy: 'ensemble-scoreability-check',
          rejectionReasoning: 'claude: This looks like a different show.',
        },
        { isLondonMarketShow: true, isUkOutletUrl: true, dateMismatchOver90d: false }
      ),
      true
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

  it('BRO-2561: grants REVIEW_LAG_GRACE_DAYS of lag past closingDate', () => {
    const runs = [{ openingDate: '2025-04-15', closingDate: '2025-05-15' }];
    // Exactly at the grace boundary — still within.
    assert.strictEqual(isWithinPriorRun('2025-05-22', runs), true);
    // One day past the grace boundary — outside.
    assert.strictEqual(isWithinPriorRun('2025-05-23', runs), false);
    assert.strictEqual(REVIEW_LAG_GRACE_DAYS, 7);
  });

  it('BRO-80: a truthful closingDate no longer rejects a next-day review', () => {
    // The Reviews Hub filed 2025-08-26 for a Summerhall Fringe run that
    // closed 2025-08-25 — the incident that motivated this grace.
    assert.strictEqual(
      isWithinPriorRun('2025-08-26', [
        { openingDate: '2025-08-01', closingDate: '2025-08-25', venue: 'Summerhall' },
      ]),
      true
    );
  });

  it('BRO-2561: a strict match in a later run beats a graced match in an earlier one', () => {
    // Run A closes June 1; run B opens June 3 (a multi-leg tour/festival
    // pattern). A June 4 review is genuinely B's own opening-week coverage —
    // it must not be swallowed by A's grace tail just because A comes first
    // in the array.
    const runs = [
      { openingDate: '2025-04-15', closingDate: '2025-06-01', venue: 'Venue A' },
      { openingDate: '2025-06-03', closingDate: '2025-06-20', venue: 'Venue B' },
    ];
    const { findMatchingPriorRun } = require('../../scripts/lib/wrong-production-autoclear');
    assert.strictEqual(findMatchingPriorRun('2025-06-04', runs).venue, 'Venue B');
  });

  it('does not extend the 180-day default window when closingDate is absent', () => {
    // 2025-04-15 + 180d = 2025-10-12; grace only applies to an explicit closingDate.
    assert.strictEqual(
      isWithinPriorRun('2025-10-12', [{ openingDate: '2025-04-15' }]),
      true
    );
    assert.strictEqual(
      isWithinPriorRun('2025-10-19', [{ openingDate: '2025-04-15' }]),
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

  it('date-fallback: recovers the flag date from the note when publishDate is missing', () => {
    // Premiere-era files often carry a null/year-less publishDate, but the
    // date-guard note embeds the real ISO date. Fall back to it so a declared
    // priorRuns window can match.
    assert.strictEqual(
      shouldAutoClearWrongProductionPriorRun(
        {
          wrongProduction: true,
          wrongProductionNote: 'Pre-opening guard: review dated 2025-04-26 is 90+ days before show starts',
          // no publishDate
        },
        show
      ),
      true
    );
  });

  it('returns false when publishDate is missing and no date is recoverable', () => {
    assert.strictEqual(
      shouldAutoClearWrongProductionPriorRun(
        {
          wrongProduction: true,
          wrongProductionNote: 'Pre-opening guard: review predates the run',
        },
        show
      ),
      false
    );
  });

  it('returns false when the recovered note date is outside every priorRuns window', () => {
    assert.strictEqual(
      shouldAutoClearWrongProductionPriorRun(
        {
          wrongProduction: true,
          wrongProductionNote: 'Pre-opening guard: review dated 2099-01-01 is 90+ days before show starts',
        },
        show
      ),
      false
    );
  });

  it('honors date-guard provenance stored in wrongProductionReason (not just the Note)', () => {
    assert.strictEqual(
      shouldAutoClearWrongProductionPriorRun(
        {
          wrongProduction: true,
          wrongProductionReason: 'Date guard: review 2025-04-26 is 555d before (preview/open)',
          publishDate: '2025-04-26',
        },
        show
      ),
      true
    );
  });

  it('clears a pure year-gap "Haiku reverify" reason inside a priorRuns window', () => {
    assert.strictEqual(
      shouldAutoClearWrongProductionPriorRun(
        {
          wrongProduction: true,
          wrongProductionReason: 'Haiku reverify: publishDate 2025 vs showId year 2026 (gap 1yr)',
          publishDate: '2025-04-26',
        },
        show
      ),
      true
    );
  });

  it('does NOT clear a non-year-gap Haiku reverify reason (content/venue verdict stays protected)', () => {
    assert.strictEqual(
      shouldAutoClearWrongProductionPriorRun(
        {
          wrongProduction: true,
          wrongProductionReason: 'Haiku reverify: review describes a different staging at the Old Vic',
          publishDate: '2025-04-26',
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

describe('shouldAutoClearStaleDateGuard (date-corrected pre-opening flag)', () => {
  it('clears a Pre-opening-guard flag once the date is back in window', () => {
    // all-my-sons-west-end-2025 Guardian/Arifa Akbar: flag set on a long-gone
    // 2025-07-01 date, real publishDate corrected to 2025-11-22 (in window).
    assert.strictEqual(
      shouldAutoClearStaleDateGuard(
        {
          wrongProduction: true,
          wrongProductionNote: 'Pre-opening guard: review dated 2025-07-01 is 90+ days before show starts 2025-11-14',
        },
        { nowInWindow: true }
      ),
      true
    );
  });

  it('does NOT clear when the date is still out of window', () => {
    assert.strictEqual(
      shouldAutoClearStaleDateGuard(
        {
          wrongProduction: true,
          wrongProductionNote: 'Pre-opening guard: review dated 2024-01-15 is 90+ days before show starts 2025-11-14',
        },
        { nowInWindow: false }
      ),
      false
    );
  });

  it('does NOT touch a flag set by something other than the dated guard', () => {
    // Operator / CV / cross-market / dateless-revival flags must survive even
    // when the date is in window — only the dated guard's own flag is matched.
    for (const note of [
      'Cross-market contamination (audit-review-contamination)',
      'Dateless revival guard: no publishDate on multi-production title',
      'URL contains year 2019 not matching show season',
      '',
    ]) {
      assert.strictEqual(
        shouldAutoClearStaleDateGuard(
          { wrongProduction: true, wrongProductionNote: note, wrongProductionReason: 'manual' },
          { nowInWindow: true }
        ),
        false,
        `should not clear note=${JSON.stringify(note)}`
      );
    }
  });

  it('returns false when wrongProduction is not set', () => {
    assert.strictEqual(
      shouldAutoClearStaleDateGuard(
        { wrongProductionNote: 'Pre-opening guard: ...' },
        { nowInWindow: true }
      ),
      false
    );
  });

  it('returns false when nowInWindow is omitted/undefined', () => {
    assert.strictEqual(
      shouldAutoClearStaleDateGuard(
        { wrongProduction: true, wrongProductionNote: 'Pre-opening guard: ...' },
        {}
      ),
      false
    );
  });
});

describe('shouldAutoClearAnticipatoryGrace (BRO-39: retroactive OB 14-day grace)', () => {
  it('clears when the re-run gate no longer rejects (category lookup fixed / date corrected)', () => {
    assert.strictEqual(
      shouldAutoClearAnticipatoryGrace(
        {
          wrongProduction: true,
          wrongProductionReason: 'anticipatory_pre_opening_post',
          wrongProductionDetail: 'published 4d before openingDate (2026-06-29); exceeds 2-day grace',
        },
        { stillRejected: false }
      ),
      true
    );
  });

  it('does NOT clear when the re-run gate still rejects (genuinely 15+ days early)', () => {
    assert.strictEqual(
      shouldAutoClearAnticipatoryGrace(
        { wrongProduction: true, wrongProductionReason: 'anticipatory_pre_opening_post' },
        { stillRejected: true }
      ),
      false
    );
  });

  it('does NOT clear a flag set by something other than the anticipatory gate', () => {
    for (const reason of ['CV-promoted: wrong venue', 'dateless-revival', '', undefined]) {
      assert.strictEqual(
        shouldAutoClearAnticipatoryGrace(
          { wrongProduction: true, wrongProductionReason: reason },
          { stillRejected: false }
        ),
        false,
        `should not clear reason=${JSON.stringify(reason)}`
      );
    }
  });

  it('does NOT clear when wrongProduction is not set', () => {
    assert.strictEqual(
      shouldAutoClearAnticipatoryGrace(
        { wrongProductionReason: 'anticipatory_pre_opening_post' },
        { stillRejected: false }
      ),
      false
    );
  });

  it('does NOT clear when stillRejected is omitted/undefined/true', () => {
    for (const stillRejected of [undefined, true]) {
      assert.strictEqual(
        shouldAutoClearAnticipatoryGrace(
          { wrongProduction: true, wrongProductionReason: 'anticipatory_pre_opening_post' },
          { stillRejected }
        ),
        false
      );
    }
  });

  it('does NOT clear when high-confidence CV independently confirms wrongProduction', () => {
    // a-midsummer-nights-dream-west-end-2026/east-midlands-theatre--unknown.json shape:
    // the anticipatory date math flips, but the fetched text is a DIFFERENT
    // production (RSC/Unicorn Theatre at The Other Place, not the West End show).
    assert.strictEqual(
      shouldAutoClearAnticipatoryGrace(
        {
          wrongProduction: true,
          wrongProductionReason: 'anticipatory_pre_opening_post',
          contentVerification: { wrongProduction: true, confidence: 'high' },
        },
        { stillRejected: false }
      ),
      false
    );
  });

  it('clears when CV wrongProduction confidence was downgraded to low by the temporal override', () => {
    assert.strictEqual(
      shouldAutoClearAnticipatoryGrace(
        {
          wrongProduction: true,
          wrongProductionReason: 'anticipatory_pre_opening_post',
          contentVerification: { wrongProduction: true, confidence: 'low' },
        },
        { stillRejected: false }
      ),
      true
    );
  });

  it('does NOT clear when high-confidence CV confirms wrongArticle', () => {
    assert.strictEqual(
      shouldAutoClearAnticipatoryGrace(
        {
          wrongProduction: true,
          wrongProductionReason: 'anticipatory_pre_opening_post',
          contentVerification: { wrongArticle: true, confidence: 'high' },
        },
        { stillRejected: false }
      ),
      false
    );
  });

  it('does NOT clear on ensemble wrong_production consensus', () => {
    assert.strictEqual(
      shouldAutoClearAnticipatoryGrace(
        {
          wrongProduction: true,
          wrongProductionReason: 'anticipatory_pre_opening_post',
          rejectionReason: 'wrong_production',
          rejectedBy: 'ensemble-scoreability-check',
          rejectionReasoning: 'claude: different venue; openai: different venue',
        },
        { stillRejected: false }
      ),
      false
    );
  });
});

// ── hasEnsembleConsensus: the ensemble outranks the heuristic ────────────────
// Coverage-pipeline tracker #2 / task #1146 (2026-08-09). A blanket domain
// heuristic ("UK outlet URL on a London show") and the allowCrossMarket
// override both deleted wrongShow even when the ensemble scoreability check had
// rejected the file as wrong_show with claude + openai + gemini independently
// naming a different production. 28 wrongShow files and 42 wrongProduction
// files were in that state corpus-wide;
// romeo-and-juliet-west-end-2026/london-theatre--holly-omahony.json was LIVE
// serving Noughts & Crosses text.
//
// Fixture fields copied verbatim from that real file.
const REAL_ROMEO_SHAPE = {
  showId: 'romeo-and-juliet-west-end-2026',
  outletId: 'london-theatre',
  url: 'https://www.londontheatre.co.uk/reviews/romeo-and-juliet-review-sadie-sink-noah-jupe-rob-icke',
  rejectedAt: '2026-04-27T09:03:25.185Z',
  rejectedBy: 'ensemble-scoreability-check',
  rejectionReason: 'wrong_show',
  rejectionReasoning:
    "claude: This review is about 'Noughts & Crosses' at Regent's Park Open Air Theatre, not 'Romeo and Juliet' at Harold Pinter Theatre; "
    + "openai: The text is a review of 'Noughts & Crosses' at the Regent's Park Open Air Theatre, not 'Romeo and Juliet' at the Harold Pinter Theatre.; "
    + 'gemini: This review is for Noughts & Crosses at Regent\'s Park Open Air Theatre, not Romeo and Juliet at Harold Pinter Theatre.',
};

describe('hasEnsembleConsensus', () => {
  it('recognises the real romeo-and-juliet file shape', () => {
    assert.equal(hasEnsembleConsensus(REAL_ROMEO_SHAPE, 'wrong_show'), true);
  });

  it('is scoped to the kind asked about', () => {
    assert.equal(hasEnsembleConsensus(REAL_ROMEO_SHAPE, 'wrong_production'), false);
  });

  it('reads STRUCTURED fields only — never the LLM prose', () => {
    // Same verdict prose, but no structured rejection recorded. A prose parser
    // would fire here; this must not, because rejectionReasoning is
    // LLM-authored text that moves with PROMPT_VERSION.
    const proseOnly = { rejectionReasoning: REAL_ROMEO_SHAPE.rejectionReasoning };
    assert.equal(hasEnsembleConsensus(proseOnly, 'wrong_show'), false);
  });

  it('ignores non-ensemble rejecters (human/manual/OCR triage)', () => {
    for (const by of ['human-manual-cleanup', 'ocr-extraction', 'manual-contamination-triage']) {
      assert.equal(
        hasEnsembleConsensus({ rejectionReason: 'wrong_show', rejectedBy: by }, 'wrong_show'),
        false,
        `${by} is not the ensemble`,
      );
    }
  });

  it('never throws on malformed input', () => {
    for (const d of [null, undefined, {}, { rejectionReason: 'wrong_show' }, { rejectedBy: 42, rejectionReason: 'wrong_show' }]) {
      assert.doesNotThrow(() => hasEnsembleConsensus(d, 'wrong_show'));
    }
  });
});

describe('an ensemble verdict outranks every auto-clear heuristic', () => {
  it('shouldAutoClearWrongShowUkUrl refuses to clear the real romeo-and-juliet file', () => {
    // The exact call rebuild-all-reviews.js makes for that file: London market,
    // UK outlet URL, no date mismatch. Pre-fix this returned true and the flag
    // was deleted, which is why the file went live with another show's text.
    assert.equal(
      shouldAutoClearWrongShowUkUrl(
        { ...REAL_ROMEO_SHAPE, wrongShow: true },
        { isLondonMarketShow: true, isUkOutletUrl: true, dateMismatchOver90d: false },
      ),
      false,
    );
  });

  it('shouldAutoClearWrongShow refuses even with allowCrossMarket set', () => {
    assert.equal(
      shouldAutoClearWrongShow({ ...REAL_ROMEO_SHAPE, wrongShow: true, allowCrossMarket: true }),
      false,
    );
  });

  it('shouldAutoClearWrongProduction refuses on the wrongProduction cousin', () => {
    // The larger population (42 files): same hole, other flag. Fixing one and
    // leaving the cousin is how this class keeps coming back.
    const d = {
      wrongProduction: true,
      allowCrossMarket: true,
      rejectedBy: 'ensemble-scoreability-check',
      rejectionReason: 'wrong_production',
      rejectionReasoning: 'claude: names a different production; openai: names a different production',
    };
    assert.equal(shouldAutoClearWrongProduction(d), false);
  });

  it('shouldAutoClearWrongProductionUrlYear refuses too', () => {
    const d = {
      wrongProduction: true,
      wrongProductionNote: 'URL contains year 2019',
      rejectedBy: 'ensemble-scoreability-check',
      rejectionReason: 'wrong_production',
      rejectionReasoning: 'claude: names a different production; openai: names a different production',
    };
    assert.equal(shouldAutoClearWrongProductionUrlYear(d, { isLondonOrOffBroadway: true }), false);
  });

  it('WITHOUT an ensemble rejection the heuristics still clear — the guard is narrow', () => {
    // The UK-URL heuristic exists because LLM wrongShow false positives on
    // London shows are real. This must not become a blanket "never clear".
    assert.equal(
      shouldAutoClearWrongShowUkUrl(
        { wrongShow: true },
        { isLondonMarketShow: true, isUkOutletUrl: true, dateMismatchOver90d: false },
      ),
      true,
    );
    assert.equal(shouldAutoClearWrongShow({ wrongShow: true, allowCrossMarket: true }), true);
    assert.equal(shouldAutoClearWrongProduction({ wrongProduction: true, allowCrossMarket: true }), true);
  });
});

// ship-check 2026-08-09: the first cut of the ensemble guard covered only 4 of
// the 6 auto-clear paths. priorRuns/tourLegs answer "is this DATE legitimate
// for this production" — they cannot answer "is this TEXT about a different
// production", which is exactly what the ensemble asserts. Operator-trust over
// CV (the Phase 1 design) does not extend to overruling three models that read
// the text and named another show.
describe('ensemble guard covers the priorRuns / tourLegs auto-clear paths too', () => {
  const SHOW_PRIOR = { priorRuns: [{ openingDate: '2025-01-01', closingDate: '2025-06-01' }] };
  const SHOW_TOUR = { tourLegs: [{ startDate: '2025-01-01', endDate: '2025-06-01' }] };
  const dateOnlyFlag = {
    wrongProduction: true,
    wrongProductionNote: 'Pre-opening guard: review predates previews',
    publishDate: '2025-03-01',
  };

  it('priorRun clear happens WITHOUT an ensemble rejection (guard stays narrow)', () => {
    assert.equal(shouldAutoClearWrongProductionPriorRun({ ...dateOnlyFlag }, SHOW_PRIOR), true);
  });

  it('priorRun clear is REFUSED when the ensemble rejected the file', () => {
    assert.equal(
      shouldAutoClearWrongProductionPriorRun(
        { ...dateOnlyFlag, rejectedBy: 'ensemble-scoreability-check', rejectionReason: 'wrong_production',
          rejectionReasoning: 'claude: different production; gemini: different production' },
        SHOW_PRIOR,
      ),
      false,
    );
  });

  it('tourLeg clear happens WITHOUT an ensemble rejection', () => {
    assert.equal(shouldAutoClearWrongProductionTourLeg({ ...dateOnlyFlag }, SHOW_TOUR), true);
  });

  it('tourLeg clear is REFUSED when the ensemble rejected the file', () => {
    assert.equal(
      shouldAutoClearWrongProductionTourLeg(
        { ...dateOnlyFlag, rejectedBy: 'ensemble-scoreability-check', rejectionReason: 'wrong_production',
          rejectionReasoning: 'claude: different production; gemini: different production' },
        SHOW_TOUR,
      ),
      false,
    );
  });
});

// The census guard: every auto-clear predicate this module exports must consult
// hasEnsembleConsensus. Structural, so a SEVENTH predicate added later cannot
// quietly re-open the hole the way priorRun/tourLeg did.
describe('no auto-clear predicate may skip the ensemble guard', () => {
  it('every shouldAutoClear* function body references hasEnsembleConsensus', () => {
    const src = fs.readFileSync(
      path.join(__dirnameCompat, '..', '..', 'scripts', 'lib', 'wrong-production-autoclear.js'),
      'utf8',
    );
    // Split on top-level function declarations and check each shouldAutoClear* body.
    const bodies = src.split(/\nfunction /).slice(1);
    const missing = [];
    for (const b of bodies) {
      const name = b.slice(0, b.indexOf('('));
      if (!/^shouldAutoClear/.test(name)) continue;
      // Stale-date-guard clears are re-evaluations of OUR OWN date guard against
      // a corrected date; they carry no cross-production claim, so they are
      // deliberately exempt. Named explicitly so the exemption is a decision.
      if (name === 'shouldAutoClearStaleDateGuard' || name === 'shouldAutoClearDatelessRevival') continue;
      if (!b.includes('hasEnsembleConsensus')) missing.push(name);
    }
    assert.deepEqual(
      missing, [],
      `these auto-clear predicates do not consult hasEnsembleConsensus: ${missing.join(', ')}. `
        + 'A heuristic must never overrule a multi-model verdict that read the text (tracker #2).',
    );
  });
});

// The dead-code guard: this module has twice shipped a tested, exported
// shouldAutoClear* predicate that no caller actually invoked — the real
// rebuild-all-reviews.js call site ran its own diverging inline logic
// instead (shouldAutoClearWrongProductionUrlYear, task #1193; the sibling
// UK-dual-market predicate had the same defect class, task #1189). Tests
// passing gave false confidence the predicate governed production behavior.
// Structural, so an EIGHTH predicate added later cannot quietly repeat it.
describe('no exported shouldAutoClear* predicate may go unwired (dead-code guard)', () => {
  it('every exported shouldAutoClear* name has at least one call site in a documented caller script', () => {
    const libSrc = fs.readFileSync(
      path.join(__dirnameCompat, '..', '..', 'scripts', 'lib', 'wrong-production-autoclear.js'),
      'utf8',
    );
    const exportsMatch = libSrc.match(/module\.exports\s*=\s*\{([\s\S]*?)\};/);
    assert.ok(exportsMatch, 'expected a module.exports = { ... } block');
    const exportedNames = exportsMatch[1]
      .split(',')
      .map(s => s.trim())
      .filter(s => /^shouldAutoClear\w+$/.test(s));
    assert.ok(exportedNames.length > 0, 'expected at least one exported shouldAutoClear* name');

    // The two production callers documented in this file's header docstring.
    const callerPaths = [
      path.join(__dirnameCompat, '..', '..', 'scripts', 'rebuild-all-reviews.js'),
      path.join(__dirnameCompat, '..', '..', 'scripts', 'flag-wrong-production-by-date.js'),
    ];
    const callerSrc = callerPaths.map(p => fs.readFileSync(p, 'utf8')).join('\n');

    const unwired = exportedNames.filter(name => !callerSrc.includes(`${name}(`));
    assert.deepEqual(
      unwired, [],
      `these exported predicates have zero call sites in rebuild-all-reviews.js or `
        + `flag-wrong-production-by-date.js: ${unwired.join(', ')}. A predicate with unit `
        + 'tests but no caller is dead code masquerading as tested production logic (#1193).',
    );
  });
});
