/**
 * Tests for src/lib/data-show-ranks.ts
 *
 * Uses synthetic ComputedShow fixtures via __rebuildIndexForTests so the
 * assertions don't depend on the live catalogue. Bench measures the index
 * build time against the REAL catalogue (data-core.getAllShows()).
 *
 * Run:
 *   npx tsx --test scripts/test-show-ranks.ts
 *
 * Why .ts (not .mjs) and tsx: the production module uses @/lib/* path
 * aliases. tsx resolves these through tsconfig.json paths when loading .ts
 * files — node's native ESM loader doesn't. .mjs would require manual
 * compilation. .ts via tsx is the cleanest path.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert';

import {
  getShowRanks,
  __rebuildIndexForTests,
  __getPoolTotalForTests,
} from '@/lib/data-show-ranks';
import type { ComputedShow } from '@/lib/data-types';

// ─────────────────────────────────────────────────────────────────────────────
// Synthetic fixtures
// ─────────────────────────────────────────────────────────────────────────────

function fixture(overrides: Partial<ComputedShow> & { id: string }): ComputedShow {
  return {
    id: overrides.id,
    slug: overrides.slug ?? overrides.id,
    title: overrides.title ?? 'Show X',
    category: overrides.category ?? 'broadway',
    type: overrides.type ?? 'musical',
    status: overrides.status ?? 'open',
    openingDate: overrides.openingDate ?? '2026-01-15',
    criticScore: overrides.criticScore ?? { score: 80, reviewCount: 10, tier1Count: 3, tier2Count: 2, reviews: [] } as ComputedShow['criticScore'],
    compositeScore: overrides.compositeScore ?? 80,
    ...overrides,
  } as ComputedShow;
}

const BW_MUS_HIGH = fixture({
  id: 'bw-mus-high',
  category: 'broadway', type: 'musical', status: 'open',
  criticScore: { score: 92, reviewCount: 14, tier1Count: 5, tier2Count: 4, reviews: [] } as ComputedShow['criticScore'],
  compositeScore: 92,
});
const BW_MUS_MID = fixture({
  id: 'bw-mus-mid',
  category: 'broadway', type: 'musical', status: 'open',
  criticScore: { score: 87, reviewCount: 12, tier1Count: 4, tier2Count: 3, reviews: [] } as ComputedShow['criticScore'],
  compositeScore: 87,
});
const BW_MUS_TIE_A = fixture({
  id: 'bw-mus-tie-a',
  category: 'broadway', type: 'musical', status: 'open',
  criticScore: { score: 80.2, reviewCount: 10, tier1Count: 3, tier2Count: 2, reviews: [] } as ComputedShow['criticScore'],
  compositeScore: 80.2,
});
const BW_MUS_TIE_B = fixture({
  id: 'bw-mus-tie-b',
  category: 'broadway', type: 'musical', status: 'open',
  // Rounds to same 80 as TIE_A — should share rank
  criticScore: { score: 79.8, reviewCount: 10, tier1Count: 3, tier2Count: 2, reviews: [] } as ComputedShow['criticScore'],
  compositeScore: 79.8,
});
const BW_PLAY = fixture({
  id: 'bw-play',
  category: 'broadway', type: 'play', status: 'open',
  criticScore: { score: 75, reviewCount: 10, tier1Count: 3, tier2Count: 2, reviews: [] } as ComputedShow['criticScore'],
  compositeScore: 75,
});
const BW_CLOSED = fixture({
  id: 'bw-closed',
  category: 'broadway', type: 'musical', status: 'closed',
  openingDate: '2018-04-19',
  criticScore: { score: 88, reviewCount: 11, tier1Count: 3, tier2Count: 3, reviews: [] } as ComputedShow['criticScore'],
  compositeScore: 88,
});
const WE_PLAY = fixture({
  id: 'we-play',
  category: 'west-end', type: 'play', status: 'open',
  criticScore: { score: 82, reviewCount: 8, tier1Count: 2, tier2Count: 2, reviews: [] } as ComputedShow['criticScore'],
  compositeScore: 82,
});

const FIXTURES = [BW_MUS_HIGH, BW_MUS_MID, BW_MUS_TIE_A, BW_MUS_TIE_B, BW_PLAY, BW_CLOSED, WE_PLAY];

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('data-show-ranks — pool semantics', () => {
  test('openMarket pool counts open + previews shows in the same market', () => {
    __rebuildIndexForTests(FIXTURES);
    const total = __getPoolTotalForTests('broadway', 'critic', 'openMarket', 'all');
    assert.equal(total, 5, '5 open BW shows (HIGH, MID, TIE_A, TIE_B, PLAY)');
  });

  test('format slice narrows the pool', () => {
    __rebuildIndexForTests(FIXTURES);
    assert.equal(__getPoolTotalForTests('broadway', 'critic', 'openMarket', 'musical'), 4);
    assert.equal(__getPoolTotalForTests('broadway', 'critic', 'openMarket', 'play'), 1);
  });

  test('closed show is not in openMarket pool', () => {
    __rebuildIndexForTests(FIXTURES);
    const ranks = getShowRanks(BW_CLOSED.id, { format: 'all' });
    assert.ok(ranks);
    assert.equal(ranks.critic.openMarket, null);
  });

  test('pool <3 returns null cells (WE pool has only 1 show)', () => {
    __rebuildIndexForTests(FIXTURES);
    const ranks = getShowRanks(WE_PLAY.id, { format: 'all' });
    assert.ok(ranks);
    assert.equal(ranks.critic.openMarket, null);
  });
});

describe('data-show-ranks — rank assignment + competition tie-break', () => {
  test('shows ranked by rounded critic score', () => {
    __rebuildIndexForTests(FIXTURES);
    const high = getShowRanks(BW_MUS_HIGH.id, { format: 'all' });
    const mid = getShowRanks(BW_MUS_MID.id, { format: 'all' });
    assert.ok(high && mid);
    assert.equal(high.critic.openMarket?.rank, 1);
    assert.equal(mid.critic.openMarket?.rank, 2);
    assert.equal(high.critic.openMarket?.total, 5);
  });

  test('ties share rank; next show jumps past tied positions (competition rank)', () => {
    __rebuildIndexForTests(FIXTURES);
    const a = getShowRanks(BW_MUS_TIE_A.id, { format: 'all' });
    const b = getShowRanks(BW_MUS_TIE_B.id, { format: 'all' });
    const play = getShowRanks(BW_PLAY.id, { format: 'all' });
    assert.ok(a && b && play);
    // TIE_A and TIE_B both round to 80 → share rank #3 (HIGH=92, MID=87, then tied 80s).
    assert.equal(a.critic.openMarket?.rank, b.critic.openMarket?.rank, 'tied shows share rank');
    assert.equal(a.critic.openMarket?.rank, 3);
    // Next-best (BW_PLAY at 75) jumps past the tied slot → rank #5, not #4.
    // This is the difference from dense rank: "#N of M" means "N-1 shows scored higher".
    assert.equal(play.critic.openMarket?.rank, 5,
      'next show after a tie jumps past tied positions (competition rank, not dense)');
  });
});

describe('data-show-ranks — null handling', () => {
  test('unknown showId returns null', () => {
    __rebuildIndexForTests(FIXTURES);
    assert.equal(getShowRanks('does-not-exist'), null);
  });

  test('format=play on a musical returns null', () => {
    __rebuildIndexForTests(FIXTURES);
    assert.equal(getShowRanks(BW_MUS_HIGH.id, { format: 'play' }), null);
  });

  test('show without metric value gets null cell', () => {
    const noScore = fixture({
      id: 'no-score',
      criticScore: undefined as unknown as ComputedShow['criticScore'],
      compositeScore: null as unknown as ComputedShow['compositeScore'],
    });
    __rebuildIndexForTests([...FIXTURES, noScore]);
    const ranks = getShowRanks(noScore.id, { format: 'all' });
    assert.ok(ranks);
    assert.equal(ranks.critic.openMarket, null);
    assert.equal(ranks.overall.openMarket, null);
  });
});

describe('data-show-ranks — bench against real catalogue', () => {
  test('index builds in <5s on production catalogue', async () => {
    const { getAllShows } = await import('@/lib/data-core');
    const realShows = getAllShows();
    const start = Date.now();
    __rebuildIndexForTests(realShows);
    const elapsed = Date.now() - start;
    console.log(`bench: rebuilt index over ${realShows.length} shows in ${elapsed}ms`);
    assert.ok(elapsed < 5000, `index build took ${elapsed}ms (expected <5000)`);
  });
});
