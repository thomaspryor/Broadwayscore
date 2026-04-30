/**
 * Parity contract: scripts/lib/is-scoreable.js MUST be no-more-permissive
 * than scripts/lib/review-guards.js#isIncludableForRebuild.
 *
 * Background: pre-2026-04-29 these two predicates diverged on 14 flag checks
 * (Codex audit, Notion 34f637c5-416f-810d). LLM was more permissive on 10 —
 * wasting Anthropic/OpenAI/Gemini budget on files rebuild excludes. LLM was
 * more restrictive on 2 — orphan-unscored bug (Lost Boys 2026-04-26 #8).
 *
 * Refactor 2026-04-29: is-scoreable now delegates to isIncludableForRebuild
 * and layers two LLM-only extras (scraper_garbage, showNotMentioned-no-excerpt).
 * This test enforces that contract going forward:
 *
 *   isScoreable(data) === true  ⇒  isIncludableForRebuild(data) === true
 *
 * Equivalently: rebuild excludes ⇒ LLM excludes (LLM is no more permissive).
 *
 * The reverse direction (rebuild includes ⇒ LLM scores) is intentionally
 * NOT enforced — the two LLM-only extras are documented exceptions:
 *   - scraper_garbage: rebuild can fall back to aggregator stars; LLM can't.
 *   - showNotMentioned without excerpt: no anchor for LLM to score against.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { isScoreable } = require('../../scripts/lib/is-scoreable.js');
const { isIncludableForRebuild } = require('../../scripts/lib/review-guards.js');

const longReviewText = 'A real critic review with substance. '.repeat(40);
const COMPLETE_BASE = {
  contentTier: 'complete',
  isFullReview: true,
  fullText: longReviewText,
};

describe('Parity contract — LLM no more permissive than rebuild', () => {

  test('clean file: both include', () => {
    const data = { ...COMPLETE_BASE };
    assert.equal(isIncludableForRebuild(data), true, 'rebuild should include');
    assert.equal(isScoreable(data), true, 'LLM should score');
  });

  // The 10 LLM-permissive flags caught by the 2026-04-29 parity audit.
  // Each one: rebuild excludes for this flag → LLM must also exclude.
  for (const flag of [
    'fabricatedEntry',
    'isSyndicatedDuplicate',
    'crossOutletDuplicate',
    'isNonReview',
    'isNotReview',
    'nonReviewFlag',
    'nonReviewContent',
  ]) {
    test(`${flag}=true: rebuild excludes ⇒ LLM excludes`, () => {
      const data = { ...COMPLETE_BASE, [flag]: true };
      assert.equal(isIncludableForRebuild(data), false, `rebuild should exclude on ${flag}`);
      assert.equal(isScoreable(data), false, `LLM must also exclude on ${flag}`);
    });
  }

  test('contentVerification.wrongArticle + confidence=high: rebuild excludes ⇒ LLM excludes', () => {
    const data = {
      ...COMPLETE_BASE,
      contentVerification: { wrongArticle: true, confidence: 'high' },
    };
    assert.equal(isIncludableForRebuild(data), false);
    assert.equal(isScoreable(data), false);
  });

  test('rejectedBy[] length >= 2: rebuild excludes ⇒ LLM excludes', () => {
    const data = { ...COMPLETE_BASE, rejectedBy: ['nyt', 'variety'] };
    assert.equal(isIncludableForRebuild(data), false);
    assert.equal(isScoreable(data), false);
  });

  test('rejectedAt timestamp without textFetchedAt or wpClear: rebuild excludes ⇒ LLM excludes', () => {
    const data = { ...COMPLETE_BASE, rejectedAt: '2026-04-20T00:00:00Z' };
    assert.equal(isIncludableForRebuild(data), false);
    assert.equal(isScoreable(data), false);
  });

  test('incompleteReason=wrong_content + wrongShow: rebuild excludes ⇒ LLM excludes', () => {
    const data = {
      ...COMPLETE_BASE,
      incompleteReason: 'wrong_content',
      wrongShow: true,
    };
    assert.equal(isIncludableForRebuild(data), false);
    assert.equal(isScoreable(data), false);
  });

  test('finalContentGate (no fullText, no aggregatorSignal): rebuild excludes ⇒ LLM excludes', () => {
    const data = { contentTier: 'complete', isFullReview: true };
    assert.equal(isIncludableForRebuild(data), false);
    assert.equal(isScoreable(data), false);
  });

});

describe('Manual-clear paths — LLM honors rebuild overrides (Lost Boys #8 fix)', () => {

  test('wrongProduction with wrongProductionManualClear=true: rebuild includes ⇒ LLM scores', () => {
    const data = {
      ...COMPLETE_BASE,
      wrongProduction: true,
      wrongProductionManualClear: true,
    };
    assert.equal(isIncludableForRebuild(data), true, 'rebuild should include cleared');
    assert.equal(isScoreable(data), true, 'LLM must score cleared (was orphan-unscored pre-2026-04-29)');
  });

  test('wrongProduction with wrongProductionOverride=true: rebuild includes ⇒ LLM scores', () => {
    const data = {
      ...COMPLETE_BASE,
      wrongProduction: true,
      wrongProductionOverride: true,
    };
    assert.equal(isIncludableForRebuild(data), true);
    assert.equal(isScoreable(data), true);
  });

  test('wrongProduction with humanReviewedWrongProduction=false: rebuild includes ⇒ LLM scores', () => {
    const data = {
      ...COMPLETE_BASE,
      wrongProduction: true,
      humanReviewedWrongProduction: false,
    };
    assert.equal(isIncludableForRebuild(data), true);
    assert.equal(isScoreable(data), true);
  });

  test('contentTier=invalid with wrongProductionManualClear: rebuild includes ⇒ LLM scores', () => {
    const data = {
      ...COMPLETE_BASE,
      contentTier: 'invalid',
      wrongProductionManualClear: true,
    };
    assert.equal(isIncludableForRebuild(data), true);
    assert.equal(isScoreable(data), true);
  });

});

describe('LLM-only extras — documented exceptions', () => {

  test('scraper_garbage: rebuild may include via aggregator signal, LLM blocks', () => {
    const data = {
      contentTier: 'complete',
      isFullReview: true,
      fullText: longReviewText, // non-empty so rebuild includes
      incompleteReason: 'scraper_garbage',
    };
    assert.equal(isIncludableForRebuild(data), true, 'rebuild includes (has fullText)');
    assert.equal(isScoreable(data), false, 'LLM blocks scraper_garbage');
  });

  test('showNotMentioned without any excerpt: rebuild includes via fullText, LLM blocks', () => {
    const data = {
      contentTier: 'complete',
      isFullReview: true,
      fullText: longReviewText,
      showNotMentioned: true,
    };
    assert.equal(isIncludableForRebuild(data), true);
    assert.equal(isScoreable(data), false, 'LLM blocks no-anchor reviews');
  });

  test('showNotMentioned WITH excerpt: both include', () => {
    const data = {
      contentTier: 'complete',
      isFullReview: true,
      fullText: longReviewText,
      showNotMentioned: true,
      dtliExcerpt: 'A real excerpt about the show.',
    };
    assert.equal(isIncludableForRebuild(data), true);
    assert.equal(isScoreable(data), true);
  });

});
