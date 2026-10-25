import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// extractIndividualReviewFromLBO is not exported, so we exercise the bstarsN
// regex directly. The regex is the contract: every LBO byline review page
// has `class="bstarsN"` (N=1..5) and the extractor must find it.
//
// Stuart King contamination 2026-04-26: prior implementation hardcoded
// stars=null, so every first-party LBO review (Stuart King + colleagues)
// landed without aggregator stars and the LLM scored sentiment alone,
// often disagreeing with the published rating.

const STAR_REGEX = /class="[^"]*\bbstars(\d)\b[^"]*"/;

function extractStars(html) {
  const m = html && html.match(STAR_REGEX);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return (n >= 1 && n <= 5) ? n : null;
}

describe('LBO individual review star extraction (bstarsN)', () => {
  test('extracts 4 stars from canonical LBO markup', () => {
    const html = '<html><body><div class="bstars4 starsblock"></div></body></html>';
    assert.strictEqual(extractStars(html), 4);
  });

  test('extracts 5 stars (rave)', () => {
    const html = '<div class="starsblock bstars5"></div>';
    assert.strictEqual(extractStars(html), 5);
  });

  test('extracts 2 stars (negative)', () => {
    const html = '<span class="bstars2 plain"></span>';
    assert.strictEqual(extractStars(html), 2);
  });

  test('returns null when no bstarsN present', () => {
    const html = '<div class="content">no rating</div>';
    assert.strictEqual(extractStars(html), null);
  });

  test('does not match unrelated digit-suffixed classes', () => {
    // Without the \b word boundary, `bstars4abc` could leak. Boundary required.
    const html = '<div class="bstars4abc"></div>';
    assert.strictEqual(extractStars(html), null);
  });

  test('rejects out-of-range bstarsN', () => {
    const html = '<div class="bstars7"></div>';
    assert.strictEqual(extractStars(html), null);
  });

  test('handles multi-class attribute with bstarsN in any position', () => {
    const html = '<div class="foo bar bstars3 baz"></div>';
    assert.strictEqual(extractStars(html), 3);
  });

  test('null/empty html returns null', () => {
    assert.strictEqual(extractStars(null), null);
    assert.strictEqual(extractStars(''), null);
  });
});
