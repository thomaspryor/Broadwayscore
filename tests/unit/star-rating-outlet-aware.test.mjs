/**
 * Tests for outlet-aware star rating parsing.
 *
 * Real-world trigger: The Recs / Celebrity Autobiography 2026-05-20.
 * Gemini misparsed "★★★★" as "4/4 stars" → score 100 (Rave). Should be
 * "4/5 stars" → 80 (Positive) because The Recs rates out of 5.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  parseStarRating,
  parseOriginalScore,
} = require('../../scripts/lib/score-parsers');
const {
  buildUserPrompt,
  extractFromJsonLd,
} = require('../../scripts/lib/llm-score-extractor');

// Tiny fixture registry — avoids reading the real outlet-registry.json so the
// test is deterministic across registry edits.
const FIXTURE_REGISTRY = {
  outlets: {
    'the-recs': { starScale: 5 },
    'usatoday': { starScale: 4 },
    'nypost': { starScale: 4 },
    'guardian': { starScale: 5 },
    'no-scale-outlet': {},
  },
};

describe('parseStarRating with maxStarsHint', () => {
  test('bare "4 stars" + hint=5 → 80', () => {
    assert.strictEqual(parseStarRating('4 stars', { maxStarsHint: 5 }), 80);
  });

  test('bare "4 stars" + hint=4 → 100', () => {
    assert.strictEqual(parseStarRating('4 stars', { maxStarsHint: 4 }), 100);
  });

  test('bare "4 stars" + no hint → 80 (default denom = 5)', () => {
    assert.strictEqual(parseStarRating('4 stars'), 80);
  });

  test('"4/5 stars" + hint=4 → 80 (explicit denom beats hint)', () => {
    assert.strictEqual(parseStarRating('4/5 stars', { maxStarsHint: 4 }), 80);
  });

  test('"4/4 stars" + hint=5 → 100 (explicit denom beats hint — but THIS is the original bug; we trust the explicit value)', () => {
    // Note: this case is where the LLM mis-extracted "4/4 stars" from a 4-star
    // glyph. With the prompt change, the LLM will return {found:false} or "4/5"
    // instead. parseStarRating still respects the explicit denominator if given.
    assert.strictEqual(parseStarRating('4/4 stars', { maxStarsHint: 5 }), 100);
  });

  test('★★★★ unicode + hint=5 → 80 (no empty stars to derive denom)', () => {
    // The Recs canonical case.
    assert.strictEqual(parseStarRating('★★★★', { maxStarsHint: 5 }), 80);
  });

  test('★★★★ unicode + hint=4 → 100', () => {
    assert.strictEqual(parseStarRating('★★★★', { maxStarsHint: 4 }), 100);
  });

  test('★★★★☆ unicode + hint=4 → still 80 (glyph denom wins over hint)', () => {
    // 4 filled + 1 empty = 5 total glyphs → /5 explicit
    assert.strictEqual(parseStarRating('★★★★☆', { maxStarsHint: 4 }), 80);
  });

  test('★★★★ unicode + no hint → 80 (default denom = 5)', () => {
    assert.strictEqual(parseStarRating('★★★★'), 80);
  });

  test('5 filled stars, no empty + hint=5 → 100 (max rating)', () => {
    assert.strictEqual(parseStarRating('★★★★★', { maxStarsHint: 5 }), 100);
  });

  test('overflow: 5 filled, no empty + hint=4 → null (invalid)', () => {
    // hint=4 means scale is 4, but we have 5 filled stars → impossible
    assert.strictEqual(parseStarRating('★★★★★', { maxStarsHint: 4 }), null);
  });
});

describe('parseOriginalScore with outlet-registry lookup', () => {
  test('"4 stars" on the-recs (starScale=5) → 80', () => {
    assert.strictEqual(
      parseOriginalScore('4 stars', 'the-recs', { outletRegistry: FIXTURE_REGISTRY }),
      80
    );
  });

  test('"4 stars" on usatoday (starScale=4) → 100', () => {
    assert.strictEqual(
      parseOriginalScore('4 stars', 'usatoday', { outletRegistry: FIXTURE_REGISTRY }),
      100
    );
  });

  test('"4 stars" on no-scale-outlet → 80 (default)', () => {
    assert.strictEqual(
      parseOriginalScore('4 stars', 'no-scale-outlet', { outletRegistry: FIXTURE_REGISTRY }),
      80
    );
  });

  test('"4 stars" with unknown outletId → 80 (default)', () => {
    assert.strictEqual(
      parseOriginalScore('4 stars', 'never-heard-of-this-outlet', { outletRegistry: FIXTURE_REGISTRY }),
      80
    );
  });

  test('"4 stars" with null outletId → 80 (default)', () => {
    assert.strictEqual(
      parseOriginalScore('4 stars', null, { outletRegistry: FIXTURE_REGISTRY }),
      80
    );
  });

  test('"4/5 stars" with usatoday (starScale=4) → 80 (explicit wins)', () => {
    assert.strictEqual(
      parseOriginalScore('4/5 stars', 'usatoday', { outletRegistry: FIXTURE_REGISTRY }),
      80
    );
  });

  test('letter-grade still gated by outletId allow-list (regression check)', () => {
    // Letter grades only accepted from outlets in LETTER_GRADE_OUTLETS.
    assert.strictEqual(
      parseOriginalScore('A-', 'the-recs', { outletRegistry: FIXTURE_REGISTRY }),
      null
    );
    assert.strictEqual(
      parseOriginalScore('A-', 'ew', { outletRegistry: FIXTURE_REGISTRY }),
      85
    );
  });
});

describe('buildUserPrompt formats starScale correctly', () => {
  test('starScale present → structured line in prompt', () => {
    const p = buildUserPrompt('test review text', 'the-recs', 5);
    assert.ok(p.includes('Outlet: the-recs'), 'should include outlet');
    assert.ok(p.includes('starScale: 5'), 'should include structured starScale line');
    assert.ok(p.includes('Review text:'), 'should include review section');
  });

  test('starScale absent → no scale line, no English filler', () => {
    const p = buildUserPrompt('test review text', 'unknown-outlet');
    assert.ok(p.includes('Outlet: unknown-outlet'));
    assert.ok(!p.includes('starScale'), 'should NOT include starScale line');
  });

  test('starScale=null → treated as absent', () => {
    const p = buildUserPrompt('test review text', 'x', null);
    assert.ok(!p.includes('starScale'));
  });
});

describe('extractFromJsonLd respects starScale fallback', () => {
  test('ratingValue=4, no bestRating, starScale=5 → 80 (THE FIX)', () => {
    // Pre-fix: heuristic (rating <= 5 ? 5 : 100) would have picked 5, accidentally OK here.
    // The bug surfaced when rating=4 + scale defaulted to 5 silently and JSON-LD said scale=4.
    // This test pins the behavior: when bestRating missing, starScale wins.
    const html = '{"@type":"Review","ratingValue":"4"}';
    const result = extractFromJsonLd(html, 5);
    assert.ok(result, 'should extract');
    assert.strictEqual(result.normalizedScore, 80);
  });

  test('ratingValue=4, no bestRating, starScale=4 → 100', () => {
    const html = '{"@type":"Review","ratingValue":"4"}';
    const result = extractFromJsonLd(html, 4);
    assert.ok(result);
    assert.strictEqual(result.normalizedScore, 100);
  });

  test('ratingValue=4, bestRating=5 explicit, starScale=4 hint → 80 (JSON-LD bestRating wins)', () => {
    const html = '{"@type":"Review","ratingValue":"4","bestRating":"5"}';
    const result = extractFromJsonLd(html, 4);
    assert.ok(result);
    assert.strictEqual(result.normalizedScore, 80);
  });

  test('ratingValue=4, no bestRating, no starScale → 100 (heuristic fallback, pre-existing behavior)', () => {
    // Documented edge case: when neither JSON-LD nor registry tells us, the heuristic
    // assumes /5 for rating<=5. This was the bug class on outlets without starScale yet.
    const html = '{"@type":"Review","ratingValue":"4"}';
    const result = extractFromJsonLd(html);
    assert.ok(result);
    // rating=4 <= 5 → scale=5 → 4/5 = 80
    assert.strictEqual(result.normalizedScore, 80);
  });

  test('ratingValue=85, no bestRating, no starScale → 85 (heuristic 100-scale)', () => {
    // When neither JSON-LD bestRating nor starScale hint is present and the
    // raw value exceeds 5, the heuristic falls back to /100 (percentage).
    const html = '{"@type":"Review","ratingValue":"85"}';
    const noHint = extractFromJsonLd(html);
    assert.ok(noHint);
    assert.strictEqual(noHint.normalizedScore, 85);
  });

  test('ratingValue=85 with conflicting starScale=5 → null (rejected as unreasonable)', () => {
    // Documented behavior: starScale=5 + rating=85 means starScale is wrong
    // for this rating. The code rejects rather than guess. Caller can re-try
    // without the hint or fall through to the LLM path.
    const html = '{"@type":"Review","ratingValue":"85"}';
    const result = extractFromJsonLd(html, 5);
    assert.strictEqual(result, null);
  });
});
