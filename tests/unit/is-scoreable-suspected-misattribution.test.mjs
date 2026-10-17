/**
 * Unit tests for the LLM scoring gate (scripts/lib/is-scoreable.js + the TS
 * source of truth scripts/llm-scoring/is-scoreable.ts).
 *
 * Regression for the gap caught in /ship-check on Notion 34e637c5-416f-81b8:
 * the scoreability gate did NOT check suspectedMisattribution at all, so the
 * LLM scorer kept re-scoring files that rebuild correctly excluded — burning
 * Anthropic/OpenAI/Gemini budget. This file verifies the gate enforces the
 * same staleness override as the rebuild gates.
 *
 * Tests load the JS mirror (scripts/lib/is-scoreable.js). The TS source of
 * truth at scripts/llm-scoring/is-scoreable.ts mirrors the same logic.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { isScoreable } = require('../../scripts/lib/is-scoreable.js');

const longReviewText = 'A real critic review with substance. '.repeat(40);

const COMPLETE_BASE = {
  contentTier: 'complete',
  isFullReview: true,
  fullText: longReviewText,
};

describe('isScoreable — suspectedMisattribution gate', () => {
  test('flagged file with current-registry-confirmed misattribution is NOT scoreable', () => {
    // Susannah Clapp at WSL — Clapp is in registry as observer/guardian non-freelancer,
    // and wsj is NOT in her knownOutlets and NOT in KNOWN_MULTI_OUTLET_PAIRS, so
    // Guard G would fire today and the predicate should NOT clear the flag.
    const data = {
      ...COMPLETE_BASE,
      suspectedMisattribution: true,
      criticName: 'Susannah Clapp',
      outletId: 'wsj',
    };
    assert.strictEqual(isScoreable(data), false,
      'Real misattribution must not be sent to the LLM scorer');
  });

  test('flagged file where outlet is now in registry knownOutlets IS scoreable (stale flag)', () => {
    // Susannah Clapp at guardian — registry now lists guardian in her knownOutlets
    // (Notion 34e637c5-416f-81b8 sweep), so the flag is stale and the gate-side
    // override allows scoring.
    const data = {
      ...COMPLETE_BASE,
      suspectedMisattribution: true,
      criticName: 'Susannah Clapp',
      outletId: 'guardian',
    };
    assert.strictEqual(isScoreable(data), true,
      'Stale misattribution on a substantial review must allow LLM scoring');
  });

  test('no suspectedMisattribution flag — scoreable as normal', () => {
    const data = { ...COMPLETE_BASE, criticName: 'Susannah Clapp', outletId: 'guardian' };
    assert.strictEqual(isScoreable(data), true);
  });

  test('flag set to literal false — scoreable (predicate guards on === true)', () => {
    const data = {
      ...COMPLETE_BASE,
      suspectedMisattribution: false,
      criticName: 'Susannah Clapp',
      outletId: 'guardian',
    };
    assert.strictEqual(isScoreable(data), true);
  });

  test('other exclusion still wins even when suspectedMisattribution is stale', () => {
    // contentTier=invalid is checked at the top of the gate — the stale-clear
    // override for suspectedMisattribution should NOT bypass other guards.
    const data = {
      suspectedMisattribution: true,
      criticName: 'Susannah Clapp',
      outletId: 'guardian',
      contentTier: 'invalid',
      fullText: longReviewText,
    };
    assert.strictEqual(isScoreable(data), false,
      'contentTier=invalid still excludes regardless of stale-misattr override');
  });
});
