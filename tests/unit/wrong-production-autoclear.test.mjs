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
  shouldAutoClearStaleDateGuard,
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
