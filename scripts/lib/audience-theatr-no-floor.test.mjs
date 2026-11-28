// Owner decision 2026-11-18 (BRO-7805): every audience source's ratings count
// and display however few there are; only the cross-source total
// (src/config/audience-grade.json minReviews) gates the grade.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { isSourceActive, calculateCombinedScore } = require('./audience-weighting.js');

test('a Theatr sample under 10 votes still counts', () => {
  const theatr = { score: 57, reviewCount: 7 };
  assert.equal(isSourceActive('theatr', theatr, { category: 'broadway' }), true);
  const { weights } = calculateCombinedScore({ mezzanine: { score: 45, reviewCount: 16 }, theatr }, { category: 'broadway' });
  assert.ok(weights.theatr > 0, 'Theatr gets weight');
});

test('site components carry no per-source Theatr vote floor', () => {
  for (const f of ['src/components/AudienceBuzzCard.tsx', 'src/components/SortableAudienceBuzzTable.tsx', 'scripts/generate-mobile-show-details.js']) {
    const src = readFileSync(new URL(`../../${f}`, import.meta.url), 'utf8');
    assert.doesNotMatch(src, /theatr'\s*&&\s*\([^)]*reviewCount[^)]*\)\s*<\s*10/, `${f} hardcodes a Theatr floor`);
  }
});

test('the 80% ceiling never hands a tiny source outsized weight', () => {
  // 1 Theatr vote next to 1,000 Mezzanine reviews: ~0.1% weight, not 20%.
  const { score, weights } = calculateCombinedScore({ mezzanine: { score: 80, reviewCount: 1000 }, theatr: { score: 0, reviewCount: 1 } }, { category: 'broadway' });
  assert.ok(weights.theatr <= 1, `theatr weight ${weights.theatr}`);
  assert.ok(score > 79, `score ${score}`);
  // A 10+ review source still absorbs the ceiling's excess.
  const big = calculateCombinedScore({ mezzanine: { score: 80, reviewCount: 1000 }, showScore: { score: 60, reviewCount: 50 } }, { category: 'broadway' });
  assert.equal(big.weights.mezzanine, 80);
});

test('most-divisive list ranks only shown scores on both sides', () => {
  const src = readFileSync(new URL('../../src/config/browse-pages.ts', import.meta.url), 'utf8');
  const start = src.indexOf("'most-divisive-broadway-shows'");
  const block = src.slice(start, src.indexOf('customSort', start));
  assert.match(block, /displaysCriticScore\(show\)/, 'critic TBD shows must not rank (Pygmalion, 2 reviews, was #1)');
  assert.match(block, /hasFullConfidenceAudienceReviews\(buzz\)/, 'audience side needs the full-confidence sample');
});

test('80% ceiling sheds weight only to sources with 10+ reviews', () => {
  // 9 reviews: below CEILING_RECIPIENT_MIN, weights stay proportional.
  let r = calculateCombinedScore({ mezzanine: { score: 50, reviewCount: 1000 }, showScore: { score: 90, reviewCount: 9 } });
  assert.equal(r.weights.mezzanine, 99);
  assert.equal(r.weights.showScore, 1);
  // 10 reviews: a valid recipient, the dominant source is capped at 80%.
  r = calculateCombinedScore({ mezzanine: { score: 50, reviewCount: 1000 }, showScore: { score: 90, reviewCount: 10 } });
  assert.equal(r.weights.mezzanine, 80);
  assert.equal(r.weights.showScore, 20);
  // Mixed: the excess goes to the 50-review source, never the 1-vote one.
  r = calculateCombinedScore({ mezzanine: { score: 50, reviewCount: 1000 }, theatr: { score: 100, reviewCount: 1 }, showScore: { score: 90, reviewCount: 50 } });
  assert.equal(r.weights.mezzanine, 80);
  assert.equal(r.weights.theatr, 0);
  assert.equal(r.weights.showScore, 20);
});
