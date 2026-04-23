/**
 * Unit tests for rebuild pipeline helpers (scripts/lib/rebuild-helpers.js)
 *
 * Tests the core scoring priority logic, text cleaning, and excerpt quality gates
 * used by rebuild-all-reviews.js.
 *
 * Run with: npm run test:unit
 * Or: node --test tests/unit/rebuild-helpers.test.mjs
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  normalizeThumb,
  normalizePublishDate,
  fixMojibake,
  fixMissingPeriods,
  isJunkExcerpt,
  isGenericQuote,
  trimToCompleteSentence,
  normalizeQuoteWrapping,
  cleanExcerpt,
  isContentVerificationActive,
  getBestScore,
  scoreToBucket,
  scoreToThumb,
} = require('../../scripts/lib/rebuild-helpers');

const { BUCKET_SCORES, THUMB_SCORES } = require('../../scripts/lib/score-extractors');

// ========================================
// 1a. getBestScore — Explicit Scores (P0, P0.5)
// ========================================

describe('getBestScore — explicit scores', () => {
  test('P0: human review score wins over everything', () => {
    const data = {
      humanReviewScore: 75,
      originalScore: '5/5',
      llmScore: { score: 90, confidence: 'high' },
      ensembleData: {},
      fullText: 'x'.repeat(200),
    };
    const result = getBestScore(data);
    assert.deepStrictEqual(result, { score: 75, source: 'human-review' });
  });

  test('P0: human review score must be 1-100', () => {
    assert.strictEqual(getBestScore({ humanReviewScore: 0 }), null);
    assert.strictEqual(getBestScore({ humanReviewScore: 101 }), null);
  });

  test('P0.5: originalScore star rating parsed', () => {
    const result = getBestScore({ originalScore: '4/5' });
    assert.strictEqual(result.score, 80);
    assert.strictEqual(result.source, 'originalScore-priority0');
  });

  test('P0.5: low-confidence originalScore falls through', () => {
    const data = {
      originalScore: '4/5',
      scoreConfidence: 'low',
      bucket: 'Positive',
    };
    const result = getBestScore(data);
    assert.strictEqual(result.source, 'bucket');
  });

  test('P0.5: star-icon scoreSource falls through', () => {
    const data = {
      originalScore: '1/5',
      scoreSource: 'star-icon',
      dtliThumb: 'Up',
    };
    const result = getBestScore(data);
    assert.strictEqual(result.source, 'thumb');
  });

  test('P0.5: originalScore-LLM conflict flags but still uses originalScore', () => {
    const flags = [];
    const data = {
      originalScore: '5/5',
      llmScore: { score: 30, confidence: 'high' },
    };
    const result = getBestScore(data, {
      flagForHumanReview: (d, reason) => flags.push(reason),
    });
    assert.strictEqual(result.score, 100);
    assert.strictEqual(result.source, 'originalScore-priority0');
    assert.strictEqual(flags[0], 'originalScore-llm-conflict');
  });

  test('P0.5: letter grade only accepted from letter-grade outlets', () => {
    // ew is in LETTER_GRADE_OUTLETS
    const ew = getBestScore({ originalScore: 'A', outletId: 'ew' });
    assert.strictEqual(ew.score, 90);

    // random outlet rejects letter grade, falls through
    const other = getBestScore({ originalScore: 'A', outletId: 'variety' });
    assert.strictEqual(other, null);
  });

  test('P0.5: NY Post css-stars NOT overridden by high-confidence LLM (Fallen Angels 2026-04-19)', () => {
    // Regression fixture for the Notion card "P1: NY Post stars not auto-converted to humanReviewScore at ingest."
    // NY Post published 1/4 stars (originalScore-priority0 = 25). A high-confidence LLM saying 85
    // must NOT be allowed to overwrite the published star rating — NY Post is in
    // OUTLET_STAR_AUTHORITATIVE, so its dedicated css-stars extractor output is treated as
    // ground truth even though 'css-stars' is nominally LOW-reliability for unknown outlets.
    const data = {
      outletId: 'nypost',
      originalScore: '1/4 stars',
      originalScoreNormalized: 25,
      scoreSource: 'css-stars',
      llmScore: { score: 85, confidence: 'high' },
      ensembleData: { needsReview: false },
    };
    const result = getBestScore(data);
    assert.strictEqual(result.score, 25);
    assert.strictEqual(result.source, 'originalScore-priority0');
  });

  test('P0.5: unknown outlet with css-stars STILL allows LLM override (regression guard)', () => {
    // The outlet-level trust is narrow — only OUTLET_STAR_AUTHORITATIVE outlets get it.
    // Generic css-stars from unknown outlets must still be overridable by a confident LLM,
    // otherwise false-positive CSS extractions on random blogs would lock in wrong scores.
    const data = {
      outletId: 'some-unknown-blog',
      originalScore: '1/5',
      originalScoreNormalized: 20,
      scoreSource: 'css-stars',
      llmScore: { score: 85, confidence: 'high' },
      ensembleData: { needsReview: false },
      fullText: 'x'.repeat(500),
    };
    const result = getBestScore(data);
    assert.strictEqual(result.score, 85);
    assert.strictEqual(result.source, 'llmScore-override-star-conflict');
  });

  test('P0a: adjudicatedScore does NOT override NY Post css-stars (adjudication skip)', () => {
    // NY Post 1/4 stars = 25. Adjudicator said 45. Stars win.
    // Before this fix, adjudicatedScore beat css-stars at P0a because nypost wasn't in
    // the gating set. Now OUTLET_STAR_AUTHORITATIVE covers it.
    const data = {
      outletId: 'nypost',
      originalScore: '1/4 stars',
      originalScoreNormalized: 25,
      scoreSource: 'css-stars',
      adjudicatedScore: 45,
    };
    const result = getBestScore(data);
    assert.strictEqual(result.score, 25);
    assert.strictEqual(result.source, 'originalScore-priority0');
  });
});

// ========================================
// 1b. getBestScore — LLM Scoring (P1)
// ========================================

describe('getBestScore — LLM scoring', () => {
  test('P1: high-conf LLM WITH ensemble accepted', () => {
    const data = {
      llmScore: { score: 85, confidence: 'high' },
      ensembleData: { needsReview: false },
      fullText: 'x'.repeat(200),
    };
    const result = getBestScore(data);
    assert.deepStrictEqual(result, { score: 85, source: 'llmScore' });
  });

  test('P1: high-conf LLM WITHOUT ensemble blocked', () => {
    const stats = {};
    const data = {
      llmScore: { score: 85, confidence: 'high' },
      fullText: 'x'.repeat(200),
      // no ensembleData
    };
    const result = getBestScore(data, { stats });
    assert.strictEqual(result, null);
    assert.ok(stats.blockedSingleModel > 0);
  });

  test('P1: excerpt-only text downgrades to low confidence', () => {
    const data = {
      llmScore: { score: 85, confidence: 'high' },
      ensembleData: { needsReview: false },
      // no fullText — excerpt only
    };
    const result = getBestScore(data);
    // Should fall through P1 (downgraded to low) and land at P4 lowconf
    assert.strictEqual(result.source, 'llmScore-lowconf');
  });

  test('P1: fullTextRecoveredFrom downgrades to low confidence', () => {
    const data = {
      llmScore: { score: 85, confidence: 'high' },
      ensembleData: { needsReview: false },
      fullText: 'x'.repeat(200),
      fullTextRecoveredFrom: 'archive.org',
    };
    const result = getBestScore(data);
    assert.strictEqual(result.source, 'llmScore-lowconf');
  });

  test('P1: stale contentVerification cleared when text fetched after verification', () => {
    const stats = {};
    const data = {
      llmScore: { score: 85, confidence: 'high' },
      ensembleData: { needsReview: false },
      fullText: 'x'.repeat(200),
      contentVerification: { wrongArticle: true, verifiedAt: '2025-01-01T00:00:00Z' },
      textFetchedAt: '2025-06-01T00:00:00Z',
    };
    const result = getBestScore(data, { stats });
    assert.strictEqual(result.source, 'llmScore');
    assert.ok(stats.staleContentVerificationCleared > 0);
  });

  test('P1: needsReview blocks P1, falls to P4', () => {
    const data = {
      llmScore: { score: 85, confidence: 'high' },
      ensembleData: { needsReview: true },
      fullText: 'x'.repeat(200),
    };
    const result = getBestScore(data);
    assert.strictEqual(result.source, 'llmScore-review');
  });
});

// ========================================
// 1c. getBestScore — Thumb Validation (P2)
// ========================================

describe('getBestScore — thumb validation', () => {
  test('P2: both thumbs agree with LLM → thumb-validated', () => {
    const data = {
      llmScore: { score: 75, confidence: 'low' },
      ensembleData: {},
      dtliThumb: 'Up',
      bwwThumb: 'Up',
    };
    const result = getBestScore(data);
    assert.strictEqual(result.score, 75);
    assert.strictEqual(result.source, 'llmScore-thumb-validated');
  });

  test('P2: single thumb agrees → thumb-boosted', () => {
    const data = {
      llmScore: { score: 75, confidence: 'low' },
      ensembleData: {},
      dtliThumb: 'Up',
    };
    const result = getBestScore(data);
    assert.strictEqual(result.score, 75);
    assert.strictEqual(result.source, 'llmScore-thumb-boosted');
  });

  test('P2: Meh/Flat thumbs are neutral, fall through', () => {
    const data = {
      llmScore: { score: 75, confidence: 'low' },
      ensembleData: {},
      dtliThumb: 'Meh',
      bwwThumb: 'Flat',
    };
    const result = getBestScore(data);
    // Meh thumbs can't validate → falls to P4 lowconf
    assert.strictEqual(result.source, 'llmScore-lowconf');
  });

  test('P2: thumbs disagree with LLM → falls through', () => {
    const data = {
      llmScore: { score: 75, confidence: 'low' },
      ensembleData: {},
      dtliThumb: 'Down',
      bwwThumb: 'Down',
    };
    const result = getBestScore(data);
    // Disagreeing thumbs → falls to P4 lowconf
    assert.strictEqual(result.source, 'llmScore-lowconf');
  });

  test('P2: bwwScore as directional signal when bwwThumb absent', () => {
    const data = {
      llmScore: { score: 75, confidence: 'low' },
      ensembleData: {},
      dtliThumb: 'Up',
      bwwScore: 8, // >= 7 = positive, agrees with LLM direction
    };
    const result = getBestScore(data);
    assert.strictEqual(result.source, 'llmScore-thumb-validated');
  });
});

// ========================================
// 1d. getBestScore — Fallback Chain (P3b–P6, null)
// ========================================

describe('getBestScore — fallback chain', () => {
  test('P3b: WE ShowScore downgraded originalScore', () => {
    const data = {
      originalScore: '4/5',
      source: 'show-score',
      _showCategory: 'west-end',
      // no outlet-verified scoreSource
    };
    const result = getBestScore(data);
    assert.strictEqual(result.score, 80);
    assert.strictEqual(result.source, 'originalScore-showscore-downgraded');
  });

  test('P0.5: WE ShowScore with outlet-verified source stays at P0.5', () => {
    const data = {
      originalScore: '4/5',
      source: 'show-score',
      _showCategory: 'west-end',
      scoreSource: 'json-ld', // outlet-verified
    };
    const result = getBestScore(data);
    assert.strictEqual(result.score, 80);
    assert.strictEqual(result.source, 'originalScore-priority0');
  });

  test('P4: low-conf LLM fallback', () => {
    const data = {
      llmScore: { score: 60, confidence: 'low' },
      ensembleData: {},
    };
    const result = getBestScore(data);
    assert.deepStrictEqual(result, { score: 60, source: 'llmScore-lowconf' });
  });

  test('P4b: assignedScore with valid scoreSource', () => {
    const data = {
      assignedScore: 72,
      scoreSource: 'llmScore',
    };
    const result = getBestScore(data);
    assert.deepStrictEqual(result, { score: 72, source: 'assignedScore' });
  });

  test('P4b: assignedScore with thumb evidence', () => {
    const data = {
      assignedScore: 72,
      dtliThumb: 'Up',
    };
    const result = getBestScore(data);
    assert.deepStrictEqual(result, { score: 72, source: 'assignedScore' });
  });

  test('P5: bucket mapping uses BUCKET_SCORES', () => {
    for (const [bucket, expectedScore] of Object.entries(BUCKET_SCORES)) {
      const result = getBestScore({ bucket });
      assert.strictEqual(result.score, expectedScore, `${bucket} should map to ${expectedScore}`);
      assert.strictEqual(result.source, 'bucket');
    }
  });

  test('P5.5: bwwScore fallback (1-10 × 10)', () => {
    const result = getBestScore({ bwwScore: 7 });
    assert.deepStrictEqual(result, { score: 70, source: 'bwwScore-fallback' });
  });

  test('P5.5: bwwScore boundary: 0 rejected, 11 rejected', () => {
    assert.strictEqual(getBestScore({ bwwScore: 0 }), null);
    assert.strictEqual(getBestScore({ bwwScore: 11 }), null);
  });

  test('P6: thumb fallback — dtli preferred over bww', () => {
    const result = getBestScore({ dtliThumb: 'Up', bwwThumb: 'Down' });
    assert.strictEqual(result.score, THUMB_SCORES['Up']);
    assert.strictEqual(result.source, 'thumb');
  });

  test('P6: thumb fallback — bww when no dtli', () => {
    const result = getBestScore({ bwwThumb: 'Down' });
    assert.strictEqual(result.score, THUMB_SCORES['Down']);
  });

  test('P6: generic thumb fallback', () => {
    const result = getBestScore({ thumb: 'Up' });
    assert.strictEqual(result.score, THUMB_SCORES['Up']);
  });

  test('null: no score sources returns null', () => {
    assert.strictEqual(getBestScore({}), null);
  });

  test('null: TO_BE_CALCULATED returns null', () => {
    const data = {
      scoreStatus: 'TO_BE_CALCULATED',
      humanReviewScore: 80,
    };
    assert.strictEqual(getBestScore(data), null);
  });
});

// ========================================
// 2. Utility Functions
// ========================================

describe('normalizeThumb', () => {
  test('Meh → Flat', () => assert.strictEqual(normalizeThumb('Meh'), 'Flat'));
  test('Flat → Flat', () => assert.strictEqual(normalizeThumb('Flat'), 'Flat'));
  test('Up → Up', () => assert.strictEqual(normalizeThumb('Up'), 'Up'));
  test('Down → Down', () => assert.strictEqual(normalizeThumb('Down'), 'Down'));
});

describe('normalizePublishDate', () => {
  test('ISO date passthrough', () => {
    assert.strictEqual(normalizePublishDate('2024-03-15'), '2024-03-15');
  });

  test('ISO timestamp extracts date', () => {
    assert.strictEqual(normalizePublishDate('2018-04-22T20:11:20-04:00'), '2018-04-22');
  });

  test('Month Day, Year format', () => {
    assert.strictEqual(normalizePublishDate('March 15, 2024'), '2024-03-15');
  });

  test('ordinal suffix (1st, 2nd, 3rd)', () => {
    assert.strictEqual(normalizePublishDate('January 1st, 2024'), '2024-01-01');
    assert.strictEqual(normalizePublishDate('February 2nd, 2024'), '2024-02-02');
  });

  test('previous production → null', () => {
    assert.strictEqual(normalizePublishDate('previous production'), null);
  });

  test('null → null', () => {
    assert.strictEqual(normalizePublishDate(null), null);
    assert.strictEqual(normalizePublishDate(undefined), null);
  });
});

describe('scoreToBucket', () => {
  test('boundary: 83 = Rave', () => assert.strictEqual(scoreToBucket(83), 'Rave'));
  test('boundary: 82 = Positive', () => assert.strictEqual(scoreToBucket(82), 'Positive'));
  test('boundary: 70 = Positive', () => assert.strictEqual(scoreToBucket(70), 'Positive'));
  test('boundary: 69 = Mixed', () => assert.strictEqual(scoreToBucket(69), 'Mixed'));
  test('boundary: 55 = Mixed', () => assert.strictEqual(scoreToBucket(55), 'Mixed'));
  test('boundary: 54 = Negative', () => assert.strictEqual(scoreToBucket(54), 'Negative'));
  test('boundary: 35 = Negative', () => assert.strictEqual(scoreToBucket(35), 'Negative'));
  test('boundary: 34 = Pan', () => assert.strictEqual(scoreToBucket(34), 'Pan'));
  test('extremes: 100 = Rave', () => assert.strictEqual(scoreToBucket(100), 'Rave'));
  test('extremes: 0 = Pan', () => assert.strictEqual(scoreToBucket(0), 'Pan'));
});

describe('scoreToThumb', () => {
  test('boundary: 70 = Up', () => assert.strictEqual(scoreToThumb(70), 'Up'));
  test('boundary: 69 = Flat', () => assert.strictEqual(scoreToThumb(69), 'Flat'));
  test('boundary: 55 = Flat', () => assert.strictEqual(scoreToThumb(55), 'Flat'));
  test('boundary: 54 = Down', () => assert.strictEqual(scoreToThumb(54), 'Down'));
});

describe('normalizeQuoteWrapping', () => {
  test('strips straight quotes', () => {
    assert.strictEqual(normalizeQuoteWrapping('"Hello world"'), 'Hello world');
  });

  test('strips curly quotes', () => {
    assert.strictEqual(normalizeQuoteWrapping('\u201cHello world\u201d'), 'Hello world');
  });

  test('strips mixed quotes', () => {
    assert.strictEqual(normalizeQuoteWrapping('"Hello world\u201d'), 'Hello world');
  });

  test('leaves unquoted text alone', () => {
    assert.strictEqual(normalizeQuoteWrapping('Hello world'), 'Hello world');
  });

  test('handles null', () => {
    assert.strictEqual(normalizeQuoteWrapping(null), null);
  });
});

// ========================================
// 3. Excerpt Quality Gates
// ========================================

describe('isJunkExcerpt', () => {
  test('null/empty is junk', () => {
    assert.strictEqual(isJunkExcerpt(null), true);
    assert.strictEqual(isJunkExcerpt(''), true);
  });

  test('ad code detected', () => {
    assert.strictEqual(isJunkExcerpt('googletag.cmd.push(function()'), true);
    assert.strictEqual(isJunkExcerpt('blogherads.push_ad(123)'), true);
  });

  test('navigation junk detected', () => {
    assert.strictEqual(isJunkExcerpt('Home Legit Reviews Broadway'), true);
    assert.strictEqual(isJunkExcerpt('Skip to content'), true);
    assert.strictEqual(isJunkExcerpt('Democracy Dies in Darkness'), true);
  });

  test('timestamps detected', () => {
    assert.strictEqual(isJunkExcerpt('5:30 PM PT Updated 3 hours ago'), true);
  });

  test('garbled ROT-1 text detected (no common words)', () => {
    assert.strictEqual(isJunkExcerpt('Uif tipx xbt bnbajoh boe uif bdupst xfsf hsfbu'), true);
  });

  test('valid review text passes', () => {
    assert.strictEqual(isJunkExcerpt('The musical is a stunning achievement that brings the audience to its feet with brilliant performances and soaring melodies.'), false);
  });

  test('privacy policy detected', () => {
    assert.strictEqual(isJunkExcerpt('We use cookies as described in our privacy policy to improve your experience.'), true);
  });
});

describe('isGenericQuote', () => {
  test('null is generic', () => {
    assert.strictEqual(isGenericQuote(null), true);
  });

  test('must-see rejected', () => {
    assert.strictEqual(isGenericQuote("It's a must-see"), true);
    assert.strictEqual(isGenericQuote("This is not to be missed"), true);
  });

  test('scene-setting rejected', () => {
    assert.strictEqual(isGenericQuote('When the curtain rises on the second act'), true);
    assert.strictEqual(isGenericQuote('Walking into the theater, you feel the excitement'), true);
  });

  test('short must-see quotes rejected', () => {
    assert.strictEqual(isGenericQuote('A bold new revival that is a must-see this season'), true);
  });

  test('substantive quote passes', () => {
    assert.strictEqual(isGenericQuote('Audra McDonald delivers a searing performance that redefines the role for a new generation of theatergoers.'), false);
  });

  test('recommended alone is generic', () => {
    assert.strictEqual(isGenericQuote('Highly recommended.'), true);
    assert.strictEqual(isGenericQuote('recommended'), true);
  });
});

describe('trimToCompleteSentence', () => {
  test('already complete — unchanged', () => {
    const text = 'The show was brilliant.';
    assert.strictEqual(trimToCompleteSentence(text), text);
  });

  test('broken contraction trimmed to last sentence', () => {
    // Sentence before contraction must be >= 40 chars for trim to fire
    const text = "The performance was truly extraordinary and moving. And he'";
    const result = trimToCompleteSentence(text);
    assert.strictEqual(result, 'The performance was truly extraordinary and moving.');
  });

  test('mid-sentence cutoff trimmed', () => {
    const text = 'The show was brilliant and the cast delivered outstanding performances in every scene throughout the entire';
    const result = trimToCompleteSentence(text);
    // No sentence boundary found with enough length, returns original
    assert.strictEqual(result, text);
  });

  test('null passthrough', () => {
    assert.strictEqual(trimToCompleteSentence(null), null);
  });

  test('ends with closing quote after punctuation', () => {
    const text = 'She said "the show was amazing."';
    assert.strictEqual(trimToCompleteSentence(text), text);
  });
});

// ========================================
// 4. Text Cleaning
// ========================================

describe('fixMojibake', () => {
  test('fixes smart quotes', () => {
    assert.ok(fixMojibake('â€™').includes('\u2019'));
    assert.ok(fixMojibake('â€œ').includes('\u201c'));
  });

  test('fixes em dash', () => {
    assert.ok(fixMojibake('â€"').includes('\u2014'));
  });

  test('fixes accented characters', () => {
    assert.strictEqual(fixMojibake('Ã©'), 'é');
    assert.strictEqual(fixMojibake('Ã¼'), 'ü');
  });

  test('null passthrough', () => {
    assert.strictEqual(fixMojibake(null), null);
  });

  test('clean text unchanged', () => {
    const clean = 'Hello world';
    assert.strictEqual(fixMojibake(clean), clean);
  });
});

describe('fixMissingPeriods', () => {
  test('year + Capital gets period', () => {
    assert.strictEqual(fixMissingPeriods('circa 1915 There'), 'circa 1915. There');
  });

  test('parenthetical + Capital gets period', () => {
    assert.strictEqual(fixMissingPeriods('(Joan Marcus)Listen'), '(Joan Marcus). Listen');
  });

  test('Darkness + Capital gets period', () => {
    assert.strictEqual(fixMissingPeriods('DarknessThe'), 'Darkness. The');
  });

  test('null passthrough', () => {
    assert.strictEqual(fixMissingPeriods(null), null);
  });
});

// ========================================
// 5. isContentVerificationActive
// ========================================

describe('isContentVerificationActive', () => {
  test('no contentVerification → false', () => {
    assert.strictEqual(isContentVerificationActive({}), false);
  });

  test('wrongArticle false → false', () => {
    assert.strictEqual(isContentVerificationActive({
      contentVerification: { wrongArticle: false },
    }), false);
  });

  test('wrongArticle true, no staleness signals → true', () => {
    assert.strictEqual(isContentVerificationActive({
      contentVerification: { wrongArticle: true },
    }), true);
  });

  test('stale: text fetched after verification → false', () => {
    assert.strictEqual(isContentVerificationActive({
      contentVerification: { wrongArticle: true, verifiedAt: '2025-01-01T00:00:00Z' },
      textFetchedAt: '2025-06-01T00:00:00Z',
    }), false);
  });
});

// ========================================
// 6. cleanExcerpt
// ========================================

describe('cleanExcerpt', () => {
  test('null/empty returns null', () => {
    assert.strictEqual(cleanExcerpt(null), null);
    assert.strictEqual(cleanExcerpt(''), null);
  });

  test('URL-only input returns null', () => {
    assert.strictEqual(cleanExcerpt('https://example.com/review'), null);
  });

  test('valid review text passes through', () => {
    const text = 'The musical is a stunning achievement that captivates the audience from start to finish.';
    assert.strictEqual(cleanExcerpt(text), text);
  });

  test('ad code (googletag) stripped', () => {
    const text = 'A brilliant show. googletag.cmd.push(function(){}); The performances were outstanding and memorable throughout.';
    const result = cleanExcerpt(text);
    assert.ok(result);
    assert.ok(!result.includes('googletag'));
    assert.ok(result.includes('brilliant'));
  });

  test('blogherads ad code stripped', () => {
    const text = 'A moving production. blogherads.adq.push(123); The cast delivers unforgettable performances every night.';
    const result = cleanExcerpt(text);
    assert.ok(result);
    assert.ok(!result.includes('blogherads'));
  });

  test('Skip to content boilerplate stripped', () => {
    const text = 'Skip to content The show delivers a powerful emotional punch that leaves audiences breathless.';
    const result = cleanExcerpt(text);
    assert.ok(result);
    assert.ok(!result.includes('Skip to content'));
    assert.ok(result.includes('delivers'));
  });

  test('Democracy Dies in Darkness stripped', () => {
    const text = 'Democracy Dies in Darkness The revival brings fresh energy to a classic musical that audiences will love.';
    const result = cleanExcerpt(text);
    assert.ok(result);
    assert.ok(!result.includes('Democracy'));
  });

  test('CRITIC\'S PICK prefix stripped', () => {
    const text = "CRITIC'S PICK A revelatory production that redefines what musical theater can achieve on Broadway.";
    const result = cleanExcerpt(text);
    assert.ok(result);
    assert.ok(!result.includes("CRITIC'S PICK"));
    assert.ok(result.startsWith('A revelatory'));
  });

  test('embedded critic attribution stripped', () => {
    const text = 'Laura Collins-Hughes, New York Times: A brilliant new musical that soars from its opening number to its finale.';
    const result = cleanExcerpt(text);
    assert.ok(result);
    assert.ok(!result.includes('Laura Collins'));
    assert.ok(result.includes('brilliant'));
  });

  test('multi-critic truncation stops at second critic', () => {
    const text = 'A stunning revival that breathes new life into a classic show and will delight audiences of all ages. Jesse Green, New York Times: The choreography is superb and innovative.';
    const result = cleanExcerpt(text);
    assert.ok(result);
    assert.ok(result.includes('stunning'));
    assert.ok(!result.includes('Jesse Green'));
  });

  test('mid-sentence lowercase recovery', () => {
    const text = 'a wonderful experience. The show is a triumph of modern musical theater that will be remembered for years.';
    const result = cleanExcerpt(text);
    assert.ok(result);
    assert.ok(result.startsWith('The show'));
  });

  test('mid-sentence lowercase with no recovery returns null', () => {
    const result = cleanExcerpt('the end of a short thing');
    assert.strictEqual(result, null);
  });

  test('junk excerpt rejected', () => {
    assert.strictEqual(cleanExcerpt('Home Legit Reviews Broadway musical theater listings and information for New York City audiences.'), null);
  });

  test('truncation at 350 chars uses sentence boundary', () => {
    // Build text > 350 chars with a period around char 200
    const text = 'The production is a masterwork of theatrical storytelling. ' +
      'Every element of the staging contributes to an immersive experience that transports audiences to another world entirely. ' +
      'The performances are uniformly excellent across the entire cast. ' +
      'The direction brings clarity and emotional depth to material that could easily become overwrought in lesser hands. ' +
      'The choreography integrates seamlessly with the narrative to create moments of pure theatrical magic.';
    const result = cleanExcerpt(text);
    assert.ok(result);
    assert.ok(result.length <= 351); // 350 + trailing period
    assert.ok(result.endsWith('.'));
  });

  test('truncation without sentence boundary adds ellipsis', () => {
    // Long text with no period in first 350 chars but > 350 total
    const longWord = 'The production delivers an extraordinarily compelling and deeply moving theatrical experience that showcases the remarkable talents of every single member of the cast and crew who bring this magnificent story to life on the Broadway stage with passion, dedication, and an unwavering commitment to artistic excellence that audiences will find absolutely thrilling and unforgettable from start to finish and beyond';
    const result = cleanExcerpt(longWord);
    assert.ok(result);
    assert.ok(result.endsWith('...'));
  });

  test('short excerpt (<30 chars) returns null', () => {
    assert.strictEqual(cleanExcerpt('A good show.'), null);
  });

  test('HTML entities decoded', () => {
    const text = 'The show &amp; its cast deliver performances that are both moving and technically brilliant throughout.';
    const result = cleanExcerpt(text);
    assert.ok(result);
    assert.ok(result.includes('show & its'));
    assert.ok(!result.includes('&amp;'));
  });

  test('trailing Read more stripped', () => {
    const text = 'A powerful new drama that explores themes of identity and belonging with remarkable sensitivity and depth. Read more';
    const result = cleanExcerpt(text);
    assert.ok(result);
    assert.ok(!result.includes('Read more'));
  });

  test('copyright footer stripped', () => {
    const text = 'The revival is a triumph of theatrical storytelling that brings this classic work to vivid new life. Copyright © 2024 Los Angeles Times. All rights reserved.';
    const result = cleanExcerpt(text);
    assert.ok(result);
    assert.ok(!result.includes('Copyright'));
  });

  test('control characters stripped', () => {
    const text = 'A remarkable\u0085production\u008Athat showcases extraordinary talent and brings this beautiful story to vivid theatrical life.';
    const result = cleanExcerpt(text);
    assert.ok(result);
    assert.ok(!result.includes('\u0085'));
    assert.ok(!result.includes('\u008A'));
  });

  test('Average Rating metadata stripped', () => {
    const text = 'A stunning musical achievement. Average Rating: 92% based on 45 reviews from major critics across the country.';
    const result = cleanExcerpt(text);
    assert.ok(result);
    assert.ok(!result.includes('Average Rating'));
  });

  test('leading colon artifact stripped', () => {
    const text = ': A brilliant revival that brings fresh energy and insight to this timeless classic musical theater piece.';
    const result = cleanExcerpt(text);
    assert.ok(result);
    assert.ok(result.startsWith('A brilliant'));
  });
});
