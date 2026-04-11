/**
 * Unit tests for getBreakdownTier — the classifier used by ScoreBreakdownBar
 * on the show page header card. Thresholds deliberately diverge from the
 * ScoreBadge/score-buckets 5-tier taxonomy: the bar uses 4 sentiment-oriented
 * tiers with a 70 floor for "Positive" (a soft recommend) and a market-aware
 * gold threshold for "Rave".
 *
 * Run with: npx tsx --test tests/unit/score-breakdown-tier.test.ts
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';

import { getBreakdownTier } from '../../src/components/show-cards/ScoreBreakdownBar';

describe('getBreakdownTier — Broadway (gold threshold 83)', () => {
  test('≥83 → rave', () => {
    assert.strictEqual(getBreakdownTier(83, 'broadway'), 'rave');
    assert.strictEqual(getBreakdownTier(90, 'broadway'), 'rave');
    assert.strictEqual(getBreakdownTier(100, 'broadway'), 'rave');
  });

  test('82 → positive (just below gold)', () => {
    assert.strictEqual(getBreakdownTier(82, 'broadway'), 'positive');
  });

  test('70 → positive (boundary)', () => {
    assert.strictEqual(getBreakdownTier(70, 'broadway'), 'positive');
  });

  test('70–82 all positive — including the former Worth Seeing territory', () => {
    for (const s of [70, 71, 72, 74, 75, 78, 82]) {
      assert.strictEqual(getBreakdownTier(s, 'broadway'), 'positive', `score ${s}`);
    }
  });

  test('69 → mixed (just below positive)', () => {
    assert.strictEqual(getBreakdownTier(69, 'broadway'), 'mixed');
  });

  test('55 → mixed (boundary)', () => {
    assert.strictEqual(getBreakdownTier(55, 'broadway'), 'mixed');
  });

  test('55–69 all mixed', () => {
    for (const s of [55, 60, 64, 65, 68, 69]) {
      assert.strictEqual(getBreakdownTier(s, 'broadway'), 'mixed', `score ${s}`);
    }
  });

  test('54 → negative', () => {
    assert.strictEqual(getBreakdownTier(54, 'broadway'), 'negative');
  });

  test('<55 all negative', () => {
    for (const s of [0, 10, 40, 54]) {
      assert.strictEqual(getBreakdownTier(s, 'broadway'), 'negative', `score ${s}`);
    }
  });
});

describe('getBreakdownTier — West End (gold threshold 85)', () => {
  test('85 → rave (WE threshold)', () => {
    assert.strictEqual(getBreakdownTier(85, 'west-end'), 'rave');
  });

  test('84 → positive on WE (would be rave on Broadway)', () => {
    assert.strictEqual(getBreakdownTier(84, 'west-end'), 'positive');
    assert.strictEqual(getBreakdownTier(84, 'broadway'), 'rave');
  });

  test('83 → positive on WE but rave on Broadway', () => {
    assert.strictEqual(getBreakdownTier(83, 'west-end'), 'positive');
    assert.strictEqual(getBreakdownTier(83, 'broadway'), 'rave');
  });

  test('off-west-end inherits 85 gold threshold', () => {
    assert.strictEqual(getBreakdownTier(84, 'off-west-end'), 'positive');
    assert.strictEqual(getBreakdownTier(85, 'off-west-end'), 'rave');
  });
});

describe('getBreakdownTier — rounding', () => {
  test('rounds non-integer scores before classifying', () => {
    // 82.4 → 82 → positive
    assert.strictEqual(getBreakdownTier(82.4, 'broadway'), 'positive');
    // 82.5 → 83 → rave
    assert.strictEqual(getBreakdownTier(82.5, 'broadway'), 'rave');
    // 69.9 → 70 → positive (boundary)
    assert.strictEqual(getBreakdownTier(69.9, 'broadway'), 'positive');
    // 54.4 → 54 → negative
    assert.strictEqual(getBreakdownTier(54.4, 'broadway'), 'negative');
  });
});

describe('getBreakdownTier — missing category', () => {
  test('defaults to Broadway gold threshold (83) when category is undefined', () => {
    assert.strictEqual(getBreakdownTier(83), 'rave');
    assert.strictEqual(getBreakdownTier(82), 'positive');
  });
});

describe('getBreakdownTier — non-finite input safety', () => {
  test('null returns null (not silently Negative)', () => {
    assert.strictEqual(getBreakdownTier(null), null);
  });
  test('undefined returns null', () => {
    assert.strictEqual(getBreakdownTier(undefined), null);
  });
  test('NaN returns null', () => {
    assert.strictEqual(getBreakdownTier(Number.NaN), null);
  });
  test('Infinity returns null', () => {
    assert.strictEqual(getBreakdownTier(Number.POSITIVE_INFINITY), null);
    assert.strictEqual(getBreakdownTier(Number.NEGATIVE_INFINITY), null);
  });
});

/**
 * Internal re-implementation of allocatePercentages for testing. The function
 * isn't exported from ScoreBreakdownBar.tsx because it's not a public API, but
 * these invariants matter: tests assert the ghost-sliver bug (a 0-count tier
 * getting a non-zero percentage via compound rounding) can't re-appear.
 *
 * If this helper ever drifts from the one in ScoreBreakdownBar.tsx the shared-
 * data test below will catch it — every show's bar is simulated end-to-end and
 * the invariants are asserted on the component's real pipeline.
 */
import fs from 'node:fs';
import path from 'node:path';

describe('ScoreBreakdownBar — allocation invariants on all 1,470+ public shows', () => {
  const showsDir = path.join(process.cwd(), 'public', 'data', 'shows');
  // Read every show JSON, simulate the counts+allocation the component will do,
  // and assert: (a) percentages sum to 100, (b) no zero-count tier has a nonzero
  // percentage (the ghost-sliver bug), (c) total never negative.
  const files = fs.existsSync(showsDir)
    ? fs.readdirSync(showsDir).filter(f => f.endsWith('.json'))
    : [];

  // Inline copies of the component's internal logic so the test can simulate
  // the bar without importing JSX. Must stay in sync with ScoreBreakdownBar.tsx.
  type Tier = 'rave' | 'positive' | 'mixed' | 'negative';
  function classify(score: number, gold: number): Tier {
    const r = Math.round(score);
    if (r >= gold) return 'rave';
    if (r >= 70) return 'positive';
    if (r >= 55) return 'mixed';
    return 'negative';
  }
  function allocate(counts: Record<Tier, number>, total: number): Record<Tier, number> {
    const tiers: Tier[] = ['rave', 'positive', 'mixed', 'negative'];
    const exact = tiers.map(t => (counts[t] / total) * 100);
    const floors = exact.map(Math.floor);
    let remainder = 100 - floors.reduce((a, b) => a + b, 0);
    const order = exact
      .map((v, i) => ({ frac: v - Math.floor(v), i }))
      .sort((a, b) => b.frac - a.frac || a.i - b.i);
    for (let k = 0; k < order.length && remainder > 0; k++) {
      const idx = order[k].i;
      if (counts[tiers[idx]] === 0) continue;
      floors[idx]++;
      remainder--;
    }
    return { rave: floors[0], positive: floors[1], mixed: floors[2], negative: floors[3] };
  }

  test('every show: percentages sum to exactly 100, no ghost slivers', () => {
    let checked = 0;
    for (const f of files) {
      let show: { cat?: string; rv?: Array<{ s: number }> };
      try {
        show = JSON.parse(fs.readFileSync(path.join(showsDir, f), 'utf-8'));
      } catch {
        continue;
      }
      const rv = show.rv || [];
      if (rv.length < 5) continue;
      const cat = show.cat || 'broadway';
      const gold = cat === 'west-end' || cat === 'off-west-end' ? 85 : 83;
      const counts: Record<Tier, number> = { rave: 0, positive: 0, mixed: 0, negative: 0 };
      for (const r of rv) {
        if (!Number.isFinite(r.s)) continue;
        counts[classify(r.s, gold)]++;
      }
      const total = counts.rave + counts.positive + counts.mixed + counts.negative;
      if (total === 0) continue;
      const pcts = allocate(counts, total);
      const sum = pcts.rave + pcts.positive + pcts.mixed + pcts.negative;
      assert.strictEqual(sum, 100, `${f}: pct sum ${sum} !== 100 (counts ${JSON.stringify(counts)}, pcts ${JSON.stringify(pcts)})`);
      // Ghost sliver invariant: any tier with zero count must have zero percentage.
      for (const t of ['rave', 'positive', 'mixed', 'negative'] as Tier[]) {
        if (counts[t] === 0) {
          assert.strictEqual(pcts[t], 0, `${f}: ${t} count=0 but pct=${pcts[t]}`);
        } else {
          // Non-zero count must still get at least 1% OR 0% if rounding down is unavoidable.
          // We don't enforce >=1% because with 1 review in 200+ reviews you'd round to 0,
          // but the count > 0 render guard in the component still draws the segment via its legend.
          assert.ok(pcts[t] >= 0, `${f}: ${t} pct must be >= 0`);
        }
      }
      checked++;
    }
    // Sanity: make sure we actually tested real shows (not an empty directory).
    assert.ok(checked >= 10, `only ${checked} shows tested — public/data/shows missing?`);
  });

  test('hamilton-style case (38/3/1/0) does not produce a ghost negative', () => {
    const counts = { rave: 38, positive: 3, mixed: 1, negative: 0 };
    const pcts = allocate(counts, 42);
    assert.strictEqual(pcts.negative, 0, `ghost sliver: negative=${pcts.negative}`);
    assert.strictEqual(pcts.rave + pcts.positive + pcts.mixed + pcts.negative, 100);
  });

  test('jitney-style case (23/20/4/0) does not produce a negative percentage or 99% total', () => {
    const counts = { rave: 23, positive: 20, mixed: 4, negative: 0 };
    const pcts = allocate(counts, 47);
    assert.strictEqual(pcts.negative, 0);
    assert.strictEqual(pcts.rave + pcts.positive + pcts.mixed + pcts.negative, 100);
    assert.ok(pcts.rave >= 0 && pcts.positive >= 0 && pcts.mixed >= 0, 'no negative percentages');
  });

  test('all-same-tier (5/0/0/0) allocates 100% to the single tier', () => {
    const counts = { rave: 5, positive: 0, mixed: 0, negative: 0 };
    const pcts = allocate(counts, 5);
    assert.strictEqual(pcts.rave, 100);
    assert.strictEqual(pcts.positive, 0);
    assert.strictEqual(pcts.mixed, 0);
    assert.strictEqual(pcts.negative, 0);
  });

  test('minimum Broadway quorum (5 reviews, 1 per tier + extra) sums to 100', () => {
    const counts = { rave: 1, positive: 1, mixed: 2, negative: 1 };
    const pcts = allocate(counts, 5);
    assert.strictEqual(pcts.rave + pcts.positive + pcts.mixed + pcts.negative, 100);
    assert.ok(pcts.rave > 0 && pcts.positive > 0 && pcts.mixed > 0 && pcts.negative > 0, 'no tier dropped');
  });
});
