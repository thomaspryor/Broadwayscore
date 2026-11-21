/**
 * BRO-5811: the OG card, /embed widget and /api/badge must make the show
 * page's TBD decision, coverage floor included. Calls the real helper
 * (CLAUDE.md rule 15) and pins the three routes to it.
 *
 * Run: npx tsx --test tests/unit/show-score-tbd.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isShowScoreTBD } from '../../src/lib/show-score-tbd';

const NOW = Date.parse('2026-10-20T12:00:00Z');
const show = (over: Record<string, unknown> = {}): any => ({
  id: 'x', category: 'broadway', status: 'open',
  criticScore: { score: 80, reviewCount: 12, tier1Count: 3, tier2Count: 4 }, ...over,
});

test('plain gate: enough reviews shows the score; too few, previews, upcoming or no score is TBD', () => {
  assert.equal(isShowScoreTBD(show(), NOW), false);
  assert.equal(isShowScoreTBD(show({ criticScore: { score: 80, reviewCount: 1, tier1Count: 0, tier2Count: 0 } }), NOW), true);
  assert.equal(isShowScoreTBD(show({ status: 'previews' }), NOW), true);
  assert.equal(isShowScoreTBD(show({ status: 'upcoming' }), NOW), true);
  assert.equal(isShowScoreTBD(show({ criticScore: undefined }), NOW), true);
});

test('coverage floor: incomplete census holds a never-public score, ack releases it', () => {
  const held = show({ cov: { state: 'incomplete', liveCount: 3, candidateCount: 9, computedAt: null } });
  assert.equal(isShowScoreTBD(held, NOW), true);
  assert.equal(isShowScoreTBD({ ...held, coverageAcked: true }, NOW), false);
});

test('regression floor: a score public for 24h+ stays shown, but never without a score', () => {
  const stamp = new Date(NOW - 25 * 3600 * 1000).toISOString();
  assert.equal(isShowScoreTBD(show({ status: 'previews', scorePublicSince: stamp }), NOW), false);
  assert.equal(isShowScoreTBD(show({ criticScore: { score: null, reviewCount: 0 }, scorePublicSince: stamp }), NOW), true);
});

test('per-show score routes use isShowScoreTBD, not a review-count-only gate', () => {
  for (const rel of ['src/app/show/[slug]/opengraph-image.tsx', 'src/app/embed/[slug]/route.ts', 'src/app/api/badge/[slug]/route.ts']) {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', rel), 'utf8');
    assert.match(src, /isShowScoreTBD\(show\)/, `${rel} must decide TBD via isShowScoreTBD`);
    assert.doesNotMatch(src, /hasEnoughReviews\(/, `${rel} re-derives TBD from review count alone (skips the coverage floor)`);
  }
});
