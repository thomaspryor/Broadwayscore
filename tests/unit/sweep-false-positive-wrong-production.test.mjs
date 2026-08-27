/**
 * BRO-23: false-positive wrongProduction sweep — misparsed publishDate +
 * truncated wrongProductionReason signals, and the corroboration guard that
 * keeps human-adjudicated flags out of both.
 *
 * Fixtures:
 *   - care-west-end-2026 incident (misparsed-date): The Stage review stamped
 *     2023-10-12 (live page 2026-05-20), Theatre Record 2026/5 inside the run
 *     window.
 *   - gypsy-2024/culturesauce--thom-geier.json (truncated-reason): real corpus
 *     file, card 39c637c5 (2026-07-13) — wrongProductionReason cut mid-word
 *     ("...the review explicitl"), full text recoverable from
 *     contentVerification.reasoning.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const {
  isTruncatedReason,
  classifyWrongProductionFPCandidate,
} = require('../../scripts/lib/wrong-production-fp-signals.js');

const CARE_SHOW = {
  id: 'care-west-end-2026',
  previewsStartDate: '2026-05-11',
  openingDate: '2026-05-20',
  closingDate: '2026-06-20',
  category: 'west-end',
};

// Real corpus reason string (gypsy-2024/culturesauce--thom-geier.json),
// hard-cut at 200 chars by rebuild-all-reviews.js's substring(0, 200).
const GYPSY_TRUNCATED_REASON = 'CV-promoted: The scraped content is definitively a review of the '
  + 'Broadway Gypsy production at Majestic Theatre with Audra McDonald, and the excerpt matches '
  + 'the expected known excerpt. However, the review explicitl';

const GYPSY_FULL_REASONING = 'The scraped content is definitively a review of the Broadway Gypsy '
  + 'production at Majestic Theatre with Audra McDonald, and the excerpt matches the expected '
  + "known excerpt. However, the review explicitly states it was published in 'the February issue "
  + "of U.K.-based Musicals magazine,' not in Culture Sauce as expected. This is a critical "
  + 'outlet/source mismatch indicating the wrong article was scraped.';

describe('isTruncatedReason', () => {
  test('flags the real gypsy-2024 mid-word cutoff (CV-promoted prefix, 200-char cap)', () => {
    assert.equal(isTruncatedReason(GYPSY_TRUNCATED_REASON), true);
  });

  test('flags the Collector LLM prefix at the same 200-char cap', () => {
    const reason = `Collector LLM: wrong production (high) — ${'x'.repeat(199)}z`;
    assert.equal(isTruncatedReason(reason), true);
  });

  test('flags the CV-low-but-strong-signal prefix at the 200-char cap', () => {
    const reason = `CV-low-but-strong-signal: ${'x'.repeat(199)}z`;
    assert.equal(isTruncatedReason(reason), true);
  });

  test('does not flag a CV-promoted reason under the 200-char cap (never truncated)', () => {
    assert.equal(isTruncatedReason('CV-promoted: this is a wrong-production review of a 2019 revival.'), false);
  });

  test('does not flag exactly 200 chars ending in terminal punctuation (a genuine short-sentence coincidence)', () => {
    const reasoning = 'x'.repeat(199) + '.';
    assert.equal(reasoning.length, 200);
    assert.equal(isTruncatedReason(`CV-promoted: ${reasoning}`), false);
  });

  test('terse operator/audit notes without a CV-promotion prefix are never flagged, however long or unpunctuated', () => {
    // Real corpus shapes that legitimately never end in a period — the naive
    // "no terminal punctuation" heuristic false-positived on 1500+ of these.
    assert.equal(isTruncatedReason('URL mentions Almeida Theatre but show is at Ambassadors Theatre (venue-mismatch guard)'), false);
    assert.equal(isTruncatedReason('cross-production-audit'), false);
    assert.equal(isTruncatedReason('BWW roundup from 2016 but show opened 2007 (9yr gap) — likely revival/tour review'), false);
  });

  test('does not flag short terse reasons', () => {
    assert.equal(isTruncatedReason('Wrong production'), false);
    assert.equal(isTruncatedReason('Cross-market routing'), false);
  });

  test('handles non-string / missing input', () => {
    assert.equal(isTruncatedReason(undefined), false);
    assert.equal(isTruncatedReason(null), false);
    assert.equal(isTruncatedReason(42), false);
  });

  test('leading/trailing whitespace around the reason does not defeat detection', () => {
    assert.equal(isTruncatedReason(`  ${GYPSY_TRUNCATED_REASON}  `), true);
  });
});

describe('classifyWrongProductionFPCandidate — misparsed-date signal', () => {
  test('care incident: date-guard flag + TR-month corroboration → strong misparsed-date candidate', () => {
    const review = {
      wrongProduction: true,
      wrongProductionNote: 'Date guard: review 2023-10-12 is 950d before 2026-05-11 (previews) — likely different production',
      publishDate: '2023-10-12',
      theatreRecordUrl: 'https://www.theatrerecord.com/archive/2026/5/39813-care',
    };
    const c = classifyWrongProductionFPCandidate({ review, show: CARE_SHOW });
    assert.ok(c);
    assert.equal(c.kind, 'misparsed-date');
    assert.equal(c.strength, 'strong');
    assert.deepEqual(c.signals, ['theatre-record-month:2026/5']);
  });

  test('roundup-excerpt only → weak misparsed-date candidate', () => {
    const review = {
      wrongProduction: true,
      wrongProductionNote: 'Date guard: review 2019-06-12 is 2500d before 2026-05-11 (previews) — likely different production',
      publishDate: '2019-06-12',
      theStageExcerpt: 'quoted in current roundup…',
    };
    const c = classifyWrongProductionFPCandidate({ review, show: CARE_SHOW });
    assert.ok(c);
    assert.equal(c.kind, 'misparsed-date');
    assert.equal(c.strength, 'weak');
  });

  test('date-guard flag with NO corroboration → not a candidate (guard holds)', () => {
    const review = {
      wrongProduction: true,
      wrongProductionNote: 'Date guard: review 2009-04-09 is 6000d before 2026-05-11 (previews) — likely different production',
      publishDate: '2009-04-09',
    };
    assert.equal(classifyWrongProductionFPCandidate({ review, show: CARE_SHOW }), null);
  });

  test('after_close TR-month match is informational only, not a sweep-actionable date candidate', () => {
    const review = {
      wrongProduction: true,
      wrongProductionNote: 'Date guard: review 2026-07-05 is 15d after 2026-06-20 (close+7d) — likely different production',
      publishDate: '2026-07-05',
      theatreRecordUrl: 'https://www.theatrerecord.com/archive/2026/5/39813-care',
    };
    assert.equal(classifyWrongProductionFPCandidate({ review, show: CARE_SHOW }), null);
  });
});

describe('classifyWrongProductionFPCandidate — truncated-reason signal', () => {
  test('gypsy-2024 corpus shape: truncated reason + recoverable full reasoning → strong', () => {
    const review = {
      wrongProduction: true,
      wrongProductionReason: GYPSY_TRUNCATED_REASON,
      contentVerification: {
        isValid: false,
        confidence: 'high',
        wrongProduction: true,
        reasoning: GYPSY_FULL_REASONING,
      },
    };
    const c = classifyWrongProductionFPCandidate({ review, show: { id: 'gypsy-2024' } });
    assert.ok(c);
    assert.equal(c.kind, 'truncated-reason');
    assert.equal(c.strength, 'strong');
    assert.equal(c.fullReasoning, GYPSY_FULL_REASONING);
  });

  test('truncated reason with no contentVerification fallback → weak (unreadable, no recovery path)', () => {
    const review = {
      wrongProduction: true,
      wrongProductionReason: GYPSY_TRUNCATED_REASON,
    };
    const c = classifyWrongProductionFPCandidate({ review, show: { id: 'gypsy-2024' } });
    assert.ok(c);
    assert.equal(c.kind, 'truncated-reason');
    assert.equal(c.strength, 'weak');
    assert.equal(c.fullReasoning, null);
  });

  test('complete (non-truncated) reason on a non-date-guard flag → not a candidate', () => {
    const review = {
      wrongProduction: true,
      wrongProductionReason: 'CV-promoted: this is unambiguously a review of a different, earlier production.',
    };
    assert.equal(classifyWrongProductionFPCandidate({ review, show: { id: 'gypsy-2024' } }), null);
  });
});

describe('classifyWrongProductionFPCandidate — corroboration guard vs. legitimate flags', () => {
  test('wrongProduction:false is never a candidate regardless of other fields', () => {
    const review = {
      wrongProduction: false,
      wrongProductionReason: GYPSY_TRUNCATED_REASON,
    };
    assert.equal(classifyWrongProductionFPCandidate({ review, show: CARE_SHOW }), null);
  });

  test('human-reviewed flag is never surfaced even with a truncated reason', () => {
    const review = {
      wrongProduction: true,
      wrongProductionReason: GYPSY_TRUNCATED_REASON,
      humanReviewedWrongProduction: true,
    };
    assert.equal(classifyWrongProductionFPCandidate({ review, show: { id: 'gypsy-2024' } }), null);
  });

  test('manual-provenance flag is never surfaced even with TR-month corroboration', () => {
    const review = {
      wrongProduction: true,
      wrongProductionNote: 'Date guard: review 2023-10-12 is 950d before 2026-05-11 (previews) — likely different production',
      wrongProductionProvenance: 'manual',
      publishDate: '2023-10-12',
      theatreRecordUrl: 'https://www.theatrerecord.com/archive/2026/5/39813-care',
    };
    assert.equal(classifyWrongProductionFPCandidate({ review, show: CARE_SHOW }), null);
  });

  test('humanReviewScore present is treated as a human assertion', () => {
    const review = {
      wrongProduction: true,
      wrongProductionReason: GYPSY_TRUNCATED_REASON,
      humanReviewScore: 75,
    };
    assert.equal(classifyWrongProductionFPCandidate({ review, show: { id: 'gypsy-2024' } }), null);
  });

  test('a genuine wrong-production flag (complete reason, no corroboration) is left alone', () => {
    const review = {
      wrongProduction: true,
      wrongProductionNote: 'Date guard: review 2010-01-01 is 6000d before 2026-05-11 (previews) — likely different production',
      wrongProductionReason: 'CV-promoted: this is confirmed to be a review of the 2010 revival, not the current production.',
      publishDate: '2010-01-01',
    };
    assert.equal(classifyWrongProductionFPCandidate({ review, show: CARE_SHOW }), null);
  });

  test('missing review or show is handled without throwing', () => {
    assert.equal(classifyWrongProductionFPCandidate({}), null);
    assert.equal(classifyWrongProductionFPCandidate({ review: null, show: CARE_SHOW }), null);
  });
});
