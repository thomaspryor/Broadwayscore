/**
 * Unit tests for review-guards.js — isLikelyWrongProduction
 *
 * Tests the date-mismatch guard that flags reviews likely from a prior production.
 * Pattern: require() the real function, never copy logic into tests.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  isLikelyWrongProduction,
  checkLlmVerificationAgainstKeywords,
} = require('../../scripts/lib/review-guards.js');

describe('isLikelyWrongProduction', () => {
  test('review 91 days before show -> true', () => {
    // 91 days before 2026-06-01 = 2026-03-02
    assert.strictEqual(isLikelyWrongProduction('2026-03-02', '2026-06-01'), true);
  });

  test('review 89 days before show -> false', () => {
    // 89 days before 2026-06-01 = 2026-03-04
    assert.strictEqual(isLikelyWrongProduction('2026-03-04', '2026-06-01'), false);
  });

  test('review on show date -> false', () => {
    assert.strictEqual(isLikelyWrongProduction('2026-06-01', '2026-06-01'), false);
  });

  test('review after show date -> false', () => {
    assert.strictEqual(isLikelyWrongProduction('2026-07-15', '2026-06-01'), false);
  });

  test('no review date -> false', () => {
    assert.strictEqual(isLikelyWrongProduction(null, '2026-06-01'), false);
    assert.strictEqual(isLikelyWrongProduction('', '2026-06-01'), false);
  });

  test('no show date -> false', () => {
    assert.strictEqual(isLikelyWrongProduction('2026-03-01', null), false);
    assert.strictEqual(isLikelyWrongProduction('2026-03-01', ''), false);
  });

  test('date with ordinal suffix ("May 10th, 2019") -> correctly parsed', () => {
    assert.strictEqual(isLikelyWrongProduction('May 10th, 2019', '2026-06-01'), true);
  });

  test('2016 review for 2026 show -> true', () => {
    assert.strictEqual(isLikelyWrongProduction('2016-04-15', '2026-06-01'), true);
  });

  test('2018 review for 2018 show -> false', () => {
    assert.strictEqual(isLikelyWrongProduction('2018-09-15', '2018-10-01'), false);
  });
});

describe('checkLlmVerificationAgainstKeywords', () => {
  const hamiltonShow = {
    id: 'hamilton-2015',
    title: 'Hamilton',
    cast: [{ name: 'Lin-Manuel Miranda' }, { name: 'Leslie Odom Jr' }],
    creativeTeam: [{ name: 'Thomas Kail' }],
    venue: 'Richard Rodgers Theatre',
  };
  const llmValidCv = { verifiedBy: 'llm:gemini', isValid: true };
  const llmInvalidCv = { verifiedBy: 'llm:gemini', isValid: false };
  const llmWrongArticleCv = { verifiedBy: 'llm:gemini', isValid: true, wrongArticle: true };
  const heuristicCv = { verifiedBy: 'heuristic', isValid: true };

  test('real Hamilton review text -> passed:true', () => {
    const text = 'Lin-Manuel Miranda\'s Hamilton opened last night at the Richard Rodgers Theatre. The cast is stellar.';
    const result = checkLlmVerificationAgainstKeywords(hamiltonShow, text, llmValidCv);
    assert.ok(result, 'should return a result object');
    assert.strictEqual(result.passed, true);
    assert.ok(result.matchedKeyword, 'should name which keyword matched');
  });

  test('AlliedSignal hallucination text (no show keyword) -> passed:false', () => {
    // Mimics the actual hallucination found in ship-check: AMP shareholder news
    // that Gemini marked isValid:true for Hamilton.
    const text = 'AlliedSignal reported its quarterly earnings today. The conglomerate beat analyst expectations, with CEO Larry Bossidy highlighting strong demand in aerospace. Shares rose 4% in after-hours trading following the announcement.';
    const result = checkLlmVerificationAgainstKeywords(hamiltonShow, text, llmValidCv);
    assert.ok(result);
    assert.strictEqual(result.passed, false);
    assert.strictEqual(result.matchedKeyword, null);
    assert.ok(result.keywordsChecked.includes('hamilton'));
  });

  test('browser-update hallucination text -> passed:false', () => {
    const text = 'Your browser is out of date. Please update to the latest version of Chrome, Firefox, or Safari to continue using our site. We recommend enabling JavaScript for the best experience.';
    const result = checkLlmVerificationAgainstKeywords(hamiltonShow, text, llmValidCv);
    assert.strictEqual(result.passed, false);
  });

  test('LLM said isValid:false -> returns null (not applicable)', () => {
    const text = 'Any text, we do not care.';
    assert.strictEqual(checkLlmVerificationAgainstKeywords(hamiltonShow, text, llmInvalidCv), null);
  });

  test('LLM flagged wrongArticle -> returns null (already handled upstream)', () => {
    const text = 'AlliedSignal reported earnings.';
    assert.strictEqual(checkLlmVerificationAgainstKeywords(hamiltonShow, text, llmWrongArticleCv), null);
  });

  test('non-LLM verification -> returns null', () => {
    const text = 'AlliedSignal reported earnings.';
    assert.strictEqual(checkLlmVerificationAgainstKeywords(hamiltonShow, text, heuristicCv), null);
  });

  test('no contentVerification -> returns null', () => {
    assert.strictEqual(checkLlmVerificationAgainstKeywords(hamiltonShow, 'any text over 100 chars '.repeat(10), null), null);
    assert.strictEqual(checkLlmVerificationAgainstKeywords(hamiltonShow, 'any text', undefined), null);
  });

  test('text under 100 chars -> returns null (too short to judge)', () => {
    const result = checkLlmVerificationAgainstKeywords(hamiltonShow, 'short text', llmValidCv);
    assert.strictEqual(result, null);
  });

  test('empty/missing keyword set -> returns null (no signal)', () => {
    const showWithNoKeywords = { id: 'x', title: '', cast: [], creativeTeam: [] };
    const longText = 'a'.repeat(200);
    assert.strictEqual(checkLlmVerificationAgainstKeywords(showWithNoKeywords, longText, llmValidCv), null);
  });

  test('short-title show (Wit) with legitimate review -> passed:true', () => {
    const witShow = {
      id: 'wit-2012',
      title: 'Wit',
      cast: [{ name: 'Cynthia Nixon' }],
      creativeTeam: [{ name: 'Lynne Meadow' }],
      venue: 'Samuel J Friedman Theatre',
    };
    const text = 'Cynthia Nixon delivers a shattering performance in this revival of Margaret Edson\'s Pulitzer-winning play. Lynne Meadow directs at the Samuel J Friedman Theatre.';
    const result = checkLlmVerificationAgainstKeywords(witShow, text, llmValidCv);
    assert.strictEqual(result.passed, true);
  });

  test('llm:grok prefix also triggers check', () => {
    const text = 'AlliedSignal reported quarterly earnings today. The conglomerate beat analyst expectations, with strong demand across aerospace. Shares rose four percent in after-hours trading.';
    const grokCv = { verifiedBy: 'llm:grok', isValid: true };
    const result = checkLlmVerificationAgainstKeywords(hamiltonShow, text, grokCv);
    assert.ok(result, 'should return a result object');
    assert.strictEqual(result.passed, false);
  });
});
