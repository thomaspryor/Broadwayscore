/**
 * Cross-implementation parity test: engine.ts vs compute-critic-score.js
 *
 * These two modules MUST produce identical scores on identical input.
 * engine.ts runs at Next.js build time (show pages).
 * compute-critic-score.js runs in Node scripts (mobile data, gold lists, homepage archive).
 *
 * Historical incident (2026-04-12): Three independent drift classes shipped to production
 * because no test compared the two implementations directly. This test prevents that.
 *
 * Run: npx tsx --test tests/unit/scoring-parity.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';

import { computeCriticScore as engineScore, type RawReview } from '../../src/lib/engine';

const require = createRequire(import.meta.url);
const { computeCriticScore: sharedScore } = require('../../scripts/lib/compute-critic-score');

// The shared module needs an outlet registry; engine.ts has its own internal lookup.
// For synthetic tests, use a minimal registry that matches engine.ts's built-in data.
const registry = {
  'nytimes':      { tier: 1, displayName: 'The New York Times' },
  'vulture':      { tier: 1, displayName: 'Vulture' },
  'variety':      { tier: 1, displayName: 'Variety' },
  'nysr':         { tier: 2, displayName: 'New York Stage Review' },
  'theatermania': { tier: 2, displayName: 'TheaterMania' },
  'broadwayworld':{ tier: 2, displayName: 'BroadwayWorld' },
  'nystagereview':{ tier: 2, displayName: 'New York Stage Review' },
  'blog-unknown': { tier: 3, displayName: 'Some Blog' },
};

function assertParity(reviews: RawReview[], label: string) {
  const e = engineScore(reviews);
  const s = sharedScore(reviews, registry);

  if (!e && !s) return; // Both null — fine
  assert.ok(e, `${label}: engine returned null but shared didn't`);
  assert.ok(s, `${label}: shared returned null but engine didn't`);

  const scoreDrift = Math.abs(e!.score - s.s);
  assert.ok(
    scoreDrift < 0.02,
    `${label}: SCORE DRIFT — engine=${e!.score}, shared=${s.s}, drift=${scoreDrift.toFixed(4)}`
  );

  assert.equal(
    e!.reviewCount, s.rc,
    `${label}: REVIEW COUNT — engine=${e!.reviewCount}, shared=${s.rc}`
  );

  assert.equal(
    e!.tier1Count, s.t1,
    `${label}: T1 COUNT — engine=${e!.tier1Count}, shared=${s.t1}`
  );
}

describe('Scoring parity: engine.ts ↔ compute-critic-score.js', () => {

  it('single T1 review', () => {
    const reviews: RawReview[] = [
      { showId: 'test', outletId: 'nytimes', criticName: 'A', assignedScore: 85, publishDate: '2024-01-01' } as RawReview,
    ];
    assertParity(reviews, 'single-T1');
  });

  it('multi-tier mix (T1 + T2 + T3)', () => {
    const reviews: RawReview[] = [
      { showId: 'test', outletId: 'nytimes',      criticName: 'A', assignedScore: 90, publishDate: '2024-01-01' } as RawReview,
      { showId: 'test', outletId: 'theatermania',  criticName: 'B', assignedScore: 70, publishDate: '2024-01-01' } as RawReview,
      { showId: 'test', outletId: 'blog-unknown',  criticName: 'C', assignedScore: 50, publishDate: '2024-01-01' } as RawReview,
    ];
    assertParity(reviews, 'multi-tier');
  });

  it('multi-critic same outlet (outletShare normalization)', () => {
    const reviews: RawReview[] = [
      { showId: 'test', outletId: 'nysr', criticName: 'Critic A', assignedScore: 100, publishDate: '2024-01-01' } as RawReview,
      { showId: 'test', outletId: 'nysr', criticName: 'Critic B', assignedScore: 60,  publishDate: '2024-01-02' } as RawReview,
      { showId: 'test', outletId: 'nytimes', criticName: 'Critic C', assignedScore: 80, publishDate: '2024-01-01' } as RawReview,
    ];
    assertParity(reviews, 'multi-critic');
  });

  it('same critic re-reviews (dedup to most recent)', () => {
    const reviews: RawReview[] = [
      { showId: 'test', outletId: 'nytimes', criticName: 'Same', assignedScore: 90, publishDate: '2024-01-01' } as RawReview,
      { showId: 'test', outletId: 'nytimes', criticName: 'Same', assignedScore: 70, publishDate: '2024-06-01' } as RawReview,
    ];
    assertParity(reviews, 'same-critic-dedup');
  });

  it('designation bumps and floors', () => {
    const reviews: RawReview[] = [
      { showId: 'test', outletId: 'nytimes', criticName: 'A', assignedScore: 50, publishDate: '2024-01-01', designation: 'critics-pick' } as RawReview,
      { showId: 'test', outletId: 'variety', criticName: 'B', assignedScore: 80, publishDate: '2024-01-01' } as RawReview,
    ];
    assertParity(reviews, 'designation');
  });

  it('confidence weight: excerpt contentTier', () => {
    const reviews: RawReview[] = [
      { showId: 'test', outletId: 'nytimes', criticName: 'A', assignedScore: 90, publishDate: '2024-01-01', contentTier: 'complete' } as RawReview,
      { showId: 'test', outletId: 'theatermania', criticName: 'B', assignedScore: 70, publishDate: '2024-01-01', contentTier: 'excerpt' } as RawReview,
    ];
    assertParity(reviews, 'confidence-weight');
  });

  it('empty input', () => {
    const e = engineScore([]);
    const s = sharedScore([], registry);
    assert.equal(e, null);
    assert.equal(s, null);
  });
});

describe('Scoring parity: real-data cross-check (10 shows)', () => {
  it('engine.ts and shared module agree on real reviews.json data', () => {
    const reviewsPath = resolve('data/reviews.json');
    const registryPath = resolve('data/outlet-registry.json');
    if (!existsSync(reviewsPath) || !existsSync(registryPath)) {
      // Data files optional in CI runners without core data checkout
      return;
    }

    const reviews = JSON.parse(readFileSync(reviewsPath, 'utf8')).reviews;
    const realRegistry = JSON.parse(readFileSync(registryPath, 'utf8')).outlets;

    // Group by show
    const byShow: Record<string, RawReview[]> = {};
    for (const r of reviews) {
      if (!byShow[r.showId]) byShow[r.showId] = [];
      byShow[r.showId].push(r);
    }

    // Pick 10 shows with the most reviews (most likely to surface drift)
    const showIds = Object.entries(byShow)
      .sort((a, b) => b[1].length - a[1].length)
      .slice(0, 10)
      .map(([id]) => id);

    let perfect = 0;
    const drifted: Array<{ id: string; engine: number; shared: number; drift: number }> = [];

    for (const showId of showIds) {
      const revs = byShow[showId];
      const e = engineScore(revs);
      const s = sharedScore(revs, realRegistry);
      if (!e || !s) continue;

      const drift = Math.abs(e.score - s.s);
      if (drift < 0.02) {
        perfect++;
      } else {
        drifted.push({ id: showId, engine: e.score, shared: s.s, drift });
      }
    }

    assert.equal(
      drifted.length, 0,
      `Score drift on ${drifted.length} shows:\n${drifted.map(d =>
        `  ${d.id}: engine=${d.engine} shared=${d.shared} drift=${d.drift.toFixed(4)}`
      ).join('\n')}`
    );
  });
});
