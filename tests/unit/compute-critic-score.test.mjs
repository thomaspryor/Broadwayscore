/**
 * Unit tests for scripts/lib/compute-critic-score.js — the SINGLE SOURCE OF TRUTH
 * for tier-weighted composite scoring in build-time scripts.
 *
 * These tests lock in parity with src/lib/engine.ts::computeCriticScore() so that
 * the homepage/mobile score computed by generate-mobile-* and generate-homepage-archive
 * stays in sync with the show-page score computed by engine.ts at Next.js build time.
 *
 * Historical incident: Stereophonic showed 88 on the show page but 89 on the homepage
 * because this module was missing the outlet-level dedup that engine.ts added later.
 *
 * Run: node --test tests/unit/compute-critic-score.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { computeCriticScore } = require('../../scripts/lib/compute-critic-score');

// Minimal outlet registry for these tests
const outletRegistry = {
  'nyt': { tier: 1, displayName: 'The New York Times' },
  'vulture': { tier: 1, displayName: 'Vulture' },
  'variety': { tier: 1, displayName: 'Variety' },
  'nysr': { tier: 2, displayName: 'New York Stage Review' },
  'theatermania': { tier: 2, displayName: 'TheaterMania' },
  'blog-a': { tier: 3, displayName: 'Blog A' },
};

describe('computeCriticScore — outlet-level dedup', () => {
  it('keeps the MOST RECENT review when an outlet has multiple reviews (by publishDate)', () => {
    const reviews = [
      { criticName: 'Critic A', outletId: 'nysr', assignedScore: 100, publishDate: '2024-04-19' },
      { criticName: 'Critic B', outletId: 'nysr', assignedScore: 60,  publishDate: '2024-04-20' },
    ];
    const result = computeCriticScore(reviews, outletRegistry);
    assert.equal(result.rc, 1, 'should dedup to 1 review');
    // The most-recent review (Critic B, 60) is kept, not the older one (100)
    assert.equal(result.s, 60);
  });

  it('does NOT dedup across different outlets (same critic, different outlets)', () => {
    const reviews = [
      { criticName: 'Charles Isherwood', outletId: 'nyt',     assignedScore: 90, publishDate: '2024-04-19' },
      { criticName: 'Charles Isherwood', outletId: 'variety', assignedScore: 80, publishDate: '2024-04-19' },
    ];
    const result = computeCriticScore(reviews, outletRegistry);
    assert.equal(result.rc, 2, 'same critic at different outlets counts twice');
    // Both T1 (tier 1) — equal weights → simple average
    assert.equal(result.s, 85);
  });

  it('drops the older duplicate so composite score changes accordingly', () => {
    // Two NYSR reviews: 100 (older) + 60 (newer). Without dedup, avg would be 80.
    // With dedup, only 60 counts.
    const reviews = [
      { criticName: 'A', outletId: 'vulture', assignedScore: 80, publishDate: '2024-04-19' },
      { criticName: 'B', outletId: 'nysr',    assignedScore: 100, publishDate: '2024-04-19' },
      { criticName: 'C', outletId: 'nysr',    assignedScore: 60,  publishDate: '2024-04-20' },
    ];
    const result = computeCriticScore(reviews, outletRegistry);
    assert.equal(result.rc, 2, 'two outlets after dedup');
    // Vulture (T1, w=1.0, score=80) + NYSR (T2, w=0.75, score=60)
    // weighted = (80 * 1.0 + 60 * 0.75) / (1.0 + 0.75) = (80 + 45) / 1.75 ≈ 71.43
    assert.equal(result.s, 71.43);
  });

  it('handles missing publishDate — newer defined date wins over null', () => {
    const reviews = [
      { criticName: 'A', outletId: 'nysr', assignedScore: 50, publishDate: null },
      { criticName: 'B', outletId: 'nysr', assignedScore: 90, publishDate: '2024-04-20' },
    ];
    const result = computeCriticScore(reviews, outletRegistry);
    assert.equal(result.rc, 1);
    assert.equal(result.s, 90);
  });
});

describe('computeCriticScore — tier weighting (regression coverage)', () => {
  it('applies tier weights correctly', () => {
    const reviews = [
      { criticName: 'A', outletId: 'nyt',    assignedScore: 100, publishDate: '2024-01-01' }, // T1 w=1.0
      { criticName: 'B', outletId: 'nysr',   assignedScore: 60,  publishDate: '2024-01-01' }, // T2 w=0.75
      { criticName: 'C', outletId: 'blog-a', assignedScore: 0,   publishDate: '2024-01-01' }, // T3 w=0.35
    ];
    const result = computeCriticScore(reviews, outletRegistry);
    // (100*1.0 + 60*0.75 + 0*0.35) / (1.0 + 0.75 + 0.35) = 145 / 2.1 ≈ 69.05
    assert.equal(result.s, 69.05);
    assert.equal(result.rc, 3);
    assert.equal(result.t1, 1);
  });

  it('top critics are promoted to T1 regardless of outlet tier', () => {
    const reviews = [
      { criticName: 'Jesse Green', outletId: 'blog-a', assignedScore: 100, publishDate: '2024-01-01' },
      { criticName: 'Other',       outletId: 'blog-a', assignedScore: 0,   publishDate: '2024-01-02' },
    ];
    // After dedup (same outlet), Other (newer) wins — but this test is about tier promotion,
    // so use different outlets:
    const reviews2 = [
      { criticName: 'Jesse Green', outletId: 'blog-a', assignedScore: 100, publishDate: '2024-01-01' },
      { criticName: 'Other',       outletId: 'nyt',    assignedScore: 0,   publishDate: '2024-01-01' },
    ];
    const result = computeCriticScore(reviews2, outletRegistry);
    // Jesse Green promoted to T1 even though at blog-a.
    // (100*1.0 + 0*1.0) / (1.0 + 1.0) = 50
    assert.equal(result.s, 50);
    assert.equal(result.t1, 2);
  });
});

describe('OUTLET_TIER_OVERRIDES parity with scoring.ts', () => {
  it('outlet-tier-overrides.json matches src/config/scoring.ts OUTLET_TIERS', () => {
    // Drift detection: scoring.ts OUTLET_TIERS is the source of truth for
    // tier assignments on the show page (engine.ts uses it). scripts/lib
    // cannot import TS directly, so we mirror the tier data into a JSON
    // file. This test parses scoring.ts and diffs it against the JSON.
    // If they drift, regenerate the JSON with:
    //   node -e 'const s=require("fs").readFileSync("src/config/scoring.ts","utf8");const m=s.match(/export const OUTLET_TIERS[^{]*{([\\s\\S]*?)^};/m);const r={};const re=/[\\x27"]([a-z0-9_-]+)[\\x27"]:\\s*{\\s*tier:\\s*(\\d)/g;let x;while((x=re.exec(m[1]))!==null)r[x[1]]=Number(x[2]);require("fs").writeFileSync("scripts/lib/outlet-tier-overrides.json", JSON.stringify(Object.keys(r).sort().reduce((a,k)=>(a[k]=r[k],a),{}), null, 2)+"\\n")'
    const fs = require('fs');
    const path = require('path');
    const overrides = require('../../scripts/lib/outlet-tier-overrides.json');

    const src = fs.readFileSync(path.resolve('src/config/scoring.ts'), 'utf8');
    const match = src.match(/export const OUTLET_TIERS[^{]*{([\s\S]*?)^};/m);
    assert.ok(match, 'OUTLET_TIERS block not found in scoring.ts');

    const parsedFromSource = {};
    const lineRe = /['"]([a-z0-9_-]+)['"]:\s*{\s*tier:\s*(\d)/g;
    let m;
    while ((m = lineRe.exec(match[1])) !== null) {
      parsedFromSource[m[1]] = Number(m[2]);
    }

    // Every source entry must be in the JSON with the same tier
    for (const [outletId, tier] of Object.entries(parsedFromSource)) {
      assert.equal(
        overrides[outletId],
        tier,
        `OUTLET drift: scoring.ts has ${outletId}=T${tier} but outlet-tier-overrides.json has T${overrides[outletId]}. Regenerate the JSON.`
      );
    }
    // And no extra entries in the JSON that scoring.ts doesn't have
    for (const outletId of Object.keys(overrides)) {
      assert.ok(
        parsedFromSource[outletId] !== undefined,
        `OUTLET drift: outlet-tier-overrides.json has ${outletId} but scoring.ts does not. Regenerate the JSON.`
      );
    }
  });
});

describe('computeCriticScore — edge cases', () => {
  it('returns null for empty input', () => {
    assert.equal(computeCriticScore([], outletRegistry), null);
    assert.equal(computeCriticScore(null, outletRegistry), null);
    assert.equal(computeCriticScore(undefined, outletRegistry), null);
  });

  it('skips reviews with no score', () => {
    const reviews = [
      { criticName: 'A', outletId: 'nyt',  assignedScore: 80, publishDate: '2024-01-01' },
      { criticName: 'B', outletId: 'nysr', assignedScore: null, publishDate: '2024-01-01' },
    ];
    const result = computeCriticScore(reviews, outletRegistry);
    assert.equal(result.rc, 1);
    assert.equal(result.s, 80);
  });
});
