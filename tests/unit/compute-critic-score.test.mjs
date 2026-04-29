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

describe('computeCriticScore — critic-level dedup', () => {
  it('KEEPS distinct critics from the same outlet (multi-critic outlets like NYSR)', () => {
    const reviews = [
      { criticName: 'Critic A', outletId: 'nysr', assignedScore: 100, publishDate: '2024-04-19' },
      { criticName: 'Critic B', outletId: 'nysr', assignedScore: 60,  publishDate: '2024-04-20' },
    ];
    const result = computeCriticScore(reviews, outletRegistry);
    // Both critics counted — each at outletShare=0.5 — but outlet still
    // contributes one full T2 vote total.
    assert.equal(result.rc, 2, 'distinct critics at same outlet both count');
    // Critic A: 100 * 0.75 (T2) * 1.0 (conf) * 0.5 (share) = 37.5
    // Critic B:  60 * 0.75       * 1.0       * 0.5         = 22.5
    // Total weighted: 60. Total weight: 0.75 * 0.5 + 0.75 * 0.5 = 0.75
    // 60 / 0.75 = 80 — equivalent to averaging the two critics
    assert.equal(result.s, 80);
  });

  it('dedups when the SAME critic re-reviews at the same outlet (most recent wins)', () => {
    // Critic A re-reviews after a cast change — only the most recent should count
    const reviews = [
      { criticName: 'Same Critic', outletId: 'nysr', assignedScore: 100, publishDate: '2024-04-19' },
      { criticName: 'Same Critic', outletId: 'nysr', assignedScore: 60,  publishDate: '2024-04-20' },
    ];
    const result = computeCriticScore(reviews, outletRegistry);
    assert.equal(result.rc, 1, 'same critic deduped to most recent');
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

  it('multi-critic outlet contributes one full tier-vote, not N votes', () => {
    // Vulture (T1, 80) + NYSR (T2, two critics: 100 and 60)
    // OLD behavior: NYSR deduped to 60 → (80 * 1.0 + 60 * 0.75) / 1.75 = 71.43
    // NEW behavior: NYSR keeps both, each at half-weight → outlet still counts as one T2 vote
    //   Vulture:  80 * 1.0 * 1.0 * 1.0  = 80     weight 1.0
    //   NYSR-A:  100 * 0.75 * 1.0 * 0.5 = 37.5   weight 0.375
    //   NYSR-B:   60 * 0.75 * 1.0 * 0.5 = 22.5   weight 0.375
    //   total:   140 / 1.75 = 80
    // The NYSR average (80) is what NYSR contributes — same total weight as before
    const reviews = [
      { criticName: 'A', outletId: 'vulture', assignedScore: 80, publishDate: '2024-04-19' },
      { criticName: 'B', outletId: 'nysr',    assignedScore: 100, publishDate: '2024-04-19' },
      { criticName: 'C', outletId: 'nysr',    assignedScore: 60,  publishDate: '2024-04-20' },
    ];
    const result = computeCriticScore(reviews, outletRegistry);
    assert.equal(result.rc, 3, 'all three critics surfaced');
    assert.equal(result.s, 80);
  });

  it('handles missing publishDate — newer defined date wins over null for same critic', () => {
    const reviews = [
      { criticName: 'Same A', outletId: 'nysr', assignedScore: 50, publishDate: null },
      { criticName: 'Same A', outletId: 'nysr', assignedScore: 90, publishDate: '2024-04-20' },
    ];
    const result = computeCriticScore(reviews, outletRegistry);
    assert.equal(result.rc, 1);
    assert.equal(result.s, 90);
  });

  it('treats reviews with no criticName as one shared "unknown" bucket per outlet', () => {
    // Two reviews from same outlet with no criticName — treated as the same author,
    // dedup picks most recent. This preserves single-vote semantics for anonymous reviews.
    const reviews = [
      { criticName: null, outletId: 'nysr', assignedScore: 100, publishDate: '2024-04-19' },
      { criticName: null, outletId: 'nysr', assignedScore: 60,  publishDate: '2024-04-20' },
    ];
    const result = computeCriticScore(reviews, outletRegistry);
    assert.equal(result.rc, 1, 'anonymous reviews share one bucket');
    assert.equal(result.s, 60);
  });
});

describe('computeCriticScore — tier weighting (regression coverage)', () => {
  it('applies tier weights correctly', () => {
    const reviews = [
      { criticName: 'A', outletId: 'nyt',    assignedScore: 100, publishDate: '2024-01-01' }, // T1 w=1.0
      { criticName: 'B', outletId: 'nysr',   assignedScore: 60,  publishDate: '2024-01-01' }, // T2 w=0.75
      { criticName: 'C', outletId: 'blog-a', assignedScore: 0,   publishDate: '2024-01-01' }, // T3 w=0.40
    ];
    const result = computeCriticScore(reviews, outletRegistry);
    // v5 weights: T1=1.0, T2=0.75, T3=0.40 (was 0.35)
    // (100*1.0 + 60*0.75 + 0*0.40) / (1.0 + 0.75 + 0.40) = 145 / 2.15 ≈ 67.44
    assert.equal(result.s, 67.44);
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

describe('Gold-list compute parity with engine.ts', () => {
  it('OUTLET_TIERS override wins over registry tier (synthetic, no real data required)', () => {
    // Locks in the April 10, 2026 Stereophonic fix. The scenario: an outlet
    // is listed in src/config/outlet-tiers.json (the authoritative override)
    // as T1, but the same outlet is T2 in outlet-registry.json. The shared
    // module must use T1 — otherwise the homepage and show page scores drift
    // for any show whose reviews include that outlet (5 UK outlets today).
    //
    // Stage review (assigned 100) + a T2 baseline review.
    // If override works (Stage T1, TheaterMania T2):
    //   (100 * 1.0 + 80 * 0.75) / (1.0 + 0.75) = 160/1.75 ≈ 91.43
    // If override fails (Stage treated as T2):
    //   (100 * 0.75 + 80 * 0.75) / 1.5 = 90.00
    // The 1.43-point gap is enough to prove which path ran.
    const registryWithWrongTier = {
      'thestage':     { tier: 2, displayName: 'The Stage' }, // intentionally wrong — outlet-tiers.json must win
      'theatermania': { tier: 2, displayName: 'TheaterMania' },
    };
    const reviews = [
      { criticName: 'Critic A', outletId: 'thestage',     assignedScore: 100, publishDate: '2024-01-01' },
      { criticName: 'Critic B', outletId: 'theatermania', assignedScore: 80,  publishDate: '2024-01-01' },
    ];
    const result = computeCriticScore(reviews, registryWithWrongTier);
    assert.ok(result, 'should compute a score');
    assert.equal(result.t1, 1, 'The Stage should be promoted to T1 by outlet-tiers.json override');
    // Floating-point tolerant compare. The key assertion: the result must be
    // closer to 91.43 (override applied) than to 90.00 (override ignored).
    assert.ok(
      Math.abs(result.s - 91.43) < 0.05,
      `expected ~91.43 (override applied), got ${result.s} — if ~90, the override is being ignored`
    );
  });

  it('real-data smoke test — a Gold-List-worthy show produces a plausible score', () => {
    // Lighter-weight sanity check using whichever show currently tops the
    // Broadway Critical Gold List. Avoids hardcoding Stereophonic-specific
    // numbers (rc, t1, rounded score) that break when reviews are cleaned
    // up or re-scored. If the #1 show on the live gold list ever computes
    // to a score outside [70, 100] with fewer than 5 reviews, something is
    // fundamentally broken and the test will fail informatively.
    const fs = require('fs');
    const path = require('path');
    const reviewsPath = path.resolve('data/reviews.json');
    const registryPath = path.resolve('data/outlet-registry.json');
    const goldListPath = path.resolve('data/gold-lists-computed.json');
    if (!fs.existsSync(reviewsPath) || !fs.existsSync(registryPath) || !fs.existsSync(goldListPath)) {
      // Data files optional in CI runners that don't check out core data.
      return;
    }
    const gl = JSON.parse(fs.readFileSync(goldListPath, 'utf8'));
    // Find a recent Broadway top-10 show from any season
    let topShow = null;
    for (const season of Object.keys(gl.lists['critical-gold'] || {})) {
      const entries = gl.lists['critical-gold'][season];
      if (entries && entries.length > 0) {
        topShow = entries[0]; // rank 1
        break;
      }
    }
    if (!topShow) return; // empty gold list in test env — skip

    const reviews = JSON.parse(fs.readFileSync(reviewsPath, 'utf8')).reviews;
    const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8')).outlets;
    const showRevs = reviews.filter(r => r.showId === topShow.showId);
    if (showRevs.length < 5) return; // tolerate data shifts

    const result = computeCriticScore(showRevs, registry);
    assert.ok(result, 'should compute a score');
    // Behavioral assertions (robust to review count shifts):
    assert.ok(result.s >= 70 && result.s <= 100, `expected Gold-List #1 score in [70,100], got ${result.s} for ${topShow.showId}`);
    assert.ok(result.rc >= 5, `expected rc >= 5 for a gold-list-worthy show, got ${result.rc} for ${topShow.showId}`);
    assert.ok(result.t1 >= 1, `expected at least 1 tier-1 review for a top Broadway show, got ${result.t1} for ${topShow.showId}`);
    // The gold-list entry value matches what our shared module computes (within 0.5 — gold list rounds to 1 decimal).
    // This is the real parity assertion: gold list pipeline ↔ live compute agree.
    assert.ok(
      Math.abs(result.s - topShow.value) < 0.5,
      `parity drift: gold-list has ${topShow.value} but compute now gives ${result.s} for ${topShow.showId}`
    );
  });
});

describe('OUTLET_TIERS source-of-truth sanity checks', () => {
  it('src/config/outlet-tiers.json is loadable and has expected shape', () => {
    // Post April 2026: outlet-tiers.json is THE single source of truth for
    // outlet tier data. Both scoring.ts (TypeScript side) and
    // compute-critic-score.js (JS side) load from the same file — drift
    // between the two code paths is impossible by construction. This test
    // just verifies the JSON is well-formed and contains the 5 UK outlets
    // that used to be silently wrong (thestage, timeout-london, financialtimes,
    // daily-mail, artsdesk).
    const tiers = require('../../src/config/outlet-tiers.json');

    assert.ok(Object.keys(tiers).length >= 80, `expected 80+ outlets, got ${Object.keys(tiers).length}`);

    // Sanity: every entry has tier/name/scoreFormat
    // v5 (2026-04-29): T4 added (0.20), so valid tiers are now [1, 2, 3, 4]
    for (const [id, entry] of Object.entries(tiers)) {
      assert.ok([1, 2, 3, 4].includes(entry.tier), `${id}: invalid tier ${entry.tier}`);
      assert.ok(typeof entry.name === 'string' && entry.name.length > 0, `${id}: missing name`);
      assert.ok(typeof entry.scoreFormat === 'string', `${id}: missing scoreFormat`);
      // v5: optional `tiers: { nyc, london }` for region-aware lookup
      if (entry.tiers) {
        if (entry.tiers.nyc != null) assert.ok([1, 2, 3, 4].includes(entry.tiers.nyc), `${id}: invalid tiers.nyc ${entry.tiers.nyc}`);
        if (entry.tiers.london != null) assert.ok([1, 2, 3, 4].includes(entry.tiers.london), `${id}: invalid tiers.london ${entry.tiers.london}`);
      }
    }

    // Regression guard: the 5 UK outlets the April 2026 Stereophonic
    // incident surfaced. v5 default tier reflects PRIMARY region (London for UK).
    assert.equal(tiers['thestage']?.tier, 1, 'The Stage must be T1 default (London-primary)');
    assert.equal(tiers['timeout-london']?.tier, 1, 'Time Out London must be T1 default');
    assert.equal(tiers['financialtimes']?.tier, 1, 'Financial Times must be T1 default');
    assert.equal(tiers['daily-mail']?.tier, 1, 'Daily Mail default tier is now T1 (London-primary; v5 — was T2 pre-v5)');
    assert.equal(tiers['artsdesk']?.tier, 2, 'The Arts Desk T2');
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
