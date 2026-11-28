/**
 * Two audience-review bars (owner decision 2026-10-31, BRO-6735):
 *  - hasEnoughAudienceReviews: show a grade from 10 reviews.
 *  - hasFullConfidenceAudienceReviews: rankings, ranked lists, analyses, Tony
 *    predictions and fantasy scoring keep the 15-review bar, so a show with 13
 *    reviews is graded but never "#2 of 81".
 *
 * Run with: npx tsx --test tests/unit/audience-grade-floors.test.ts
 */
import { test, describe } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

import {
  hasEnoughAudienceReviews,
  hasFullConfidenceAudienceReviews,
  audienceSortScore,
  MIN_AUDIENCE_REVIEWS,
  FULL_CONFIDENCE_AUDIENCE_REVIEWS,
} from '../../src/lib/audience-grade-utils';
import type { AudienceBuzzData } from '../../src/lib/data-types';

const buzz = (n: number): AudienceBuzzData =>
  ({ combinedScore: 90, sources: { mezzanine: { score: 90, reviewCount: n } } } as unknown as AudienceBuzzData);

describe('audience review bars', () => {
  test('config values', () => {
    assert.strictEqual(MIN_AUDIENCE_REVIEWS, 10);
    assert.strictEqual(FULL_CONFIDENCE_AUDIENCE_REVIEWS, 15);
  });

  for (const [n, grade, ranked] of [[0, false, false], [9, false, false], [10, true, false], [14, true, false], [15, true, true], [931, true, true]] as const) {
    test(`${n} reviews -> grade ${grade}, ranked ${ranked}`, () => {
      assert.strictEqual(hasEnoughAudienceReviews(buzz(n)), grade);
      assert.strictEqual(hasFullConfidenceAudienceReviews(buzz(n)), ranked);
    });
  }

  test('sources split across platforms are summed, null sources ignored', () => {
    const b = { combinedScore: 80, sources: { mezzanine: { score: 80, reviewCount: 8 }, showScore: { score: 80, reviewCount: 7 }, reddit: null } } as unknown as AudienceBuzzData;
    assert.strictEqual(hasFullConfidenceAudienceReviews(b), true);
  });

  test('suppressed sources never count toward the gate (BRO-6738)', () => {
    const only = { combinedScore: 81, sources: { reddit: { score: 81, reviewCount: 223, suppressed: true } } } as unknown as AudienceBuzzData;
    assert.strictEqual(hasEnoughAudienceReviews(only), false);
    const mixed = { combinedScore: 81, sources: { reddit: { score: 81, reviewCount: 223, suppressed: true }, showScore: { score: 80, reviewCount: 9 } } } as unknown as AudienceBuzzData;
    assert.strictEqual(hasEnoughAudienceReviews(mixed), false);
  });
});

describe('audience sort key', () => {
  test('small-sample shows get no sort key, full-confidence shows keep their score', () => {
    assert.strictEqual(audienceSortScore({ audienceCombinedScore: 95, audienceSmallSample: true }), null);
    assert.strictEqual(audienceSortScore({ audienceCombinedScore: 95, audienceSmallSample: false }), 95);
    assert.strictEqual(audienceSortScore({ audienceCombinedScore: 80 }), 80);
    assert.strictEqual(audienceSortScore({ audienceCombinedScore: null }), null);
  });
  test('sorting a 13-review 95 against a 931-review 90 puts the big sample first', () => {
    const shows = [
      { id: 'small', audienceCombinedScore: 95, audienceSmallSample: true },
      { id: 'big', audienceCombinedScore: 90 },
    ];
    const sorted = [...shows].sort((a, b) => (audienceSortScore(b) ?? -1) - (audienceSortScore(a) ?? -1));
    assert.deepStrictEqual(sorted.map((s) => s.id), ['big', 'small']);
  });
});

describe('consumers use the right bar', () => {
  const read = (f: string) => fs.readFileSync(path.join(__dirname, '../../', f), 'utf8');
  // Anything that ranks, averages or predicts must use the full-confidence bar.
  for (const f of ['src/lib/data-show-ranks.ts', 'src/lib/data-topic-pages.ts', 'src/lib/data-tony-predictions.ts']) {
    test(`${f} uses hasFullConfidenceAudienceReviews, not the display bar`, () => {
      const src = read(f);
      assert.ok(/hasFullConfidenceAudienceReviews\(/.test(src), `${f} should call hasFullConfidenceAudienceReviews`);
      assert.ok(!/hasEnoughAudienceReviews\(/.test(src), `${f} must not rank/average on the display bar`);
    });
  }
  test('ranked audience-buzz page uses the full-confidence bar', () => {
    const src = read('src/app/audience-buzz/page.tsx');
    assert.ok(/total >= FULL_CONFIDENCE_AUDIENCE_REVIEWS/.test(src));
    assert.ok(!/MIN_AUDIENCE_REVIEWS/.test(src));
  });
  test('fantasy config uses the full-confidence value', () => {
    assert.ok(/audience-grade\.json'\)\.fullConfidenceReviews/.test(read('scripts/generate-fantasy-config.js')));
  });
});
