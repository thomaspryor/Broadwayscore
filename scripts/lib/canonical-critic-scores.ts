/**
 * canonical-critic-scores.ts — THE only sanctioned way to get a show's Critic
 * Score for any analysis, post, email, or external claim.
 *
 * Why this exists: a 2026-05-30 near-miss had a Reddit post about to ship with
 * critic scores computed as a raw mean of reviews.json `assignedScore` values,
 * which is NOT the same number the site displays on a show's page. The site
 * uses tier-weighted compositeScore (T1 outlets 1.0, T2 0.75, T3 0.35) computed
 * by `computeCriticScore()` in src/lib/engine.ts. Anything labeled "critic
 * score" externally must match what the site shows.
 *
 * RULE: in any analysis script (or any code that produces external-facing
 * numbers), import from this module. Do NOT iterate reviews.json and compute
 * your own average — that produces a non-canonical number.
 *
 * Display convention: integer rounding (the site does this — external copy
 * must match). Use `getCriticScore(showId)` which already rounds; only use
 * `getCriticScoreRaw(showId)` if you have a specific internal reason for a
 * float and aren't publishing it.
 */

import { getBroadwayShows } from '../../src/lib/data-core';

let cache: Map<string, number | null> | null = null;
let cacheRaw: Map<string, number | null> | null = null;

function buildCache() {
  if (cache && cacheRaw) return;
  cache = new Map();
  cacheRaw = new Map();
  for (const s of getBroadwayShows()) {
    cacheRaw.set(s.id, s.compositeScore ?? null);
    cache.set(s.id, s.compositeScore == null ? null : Math.round(s.compositeScore));
  }
}

/** Canonical Critic Score for a show, rounded to integer the way the site displays it. */
export function getCriticScore(showId: string): number | null {
  buildCache();
  return cache!.get(showId) ?? null;
}

/** Raw (unrounded) Critic Score. Use only for internal sort/tiebreak; never publish externally. */
export function getCriticScoreRaw(showId: string): number | null {
  buildCache();
  return cacheRaw!.get(showId) ?? null;
}

/** Full map of {showId → integer Critic Score} for batch analyses. */
export function getCriticScoreMap(): Map<string, number | null> {
  buildCache();
  return cache!;
}

/** CLI: `npx tsx scripts/lib/canonical-critic-scores.ts > /tmp/critic-scores.json`
 *  Dumps the integer map as JSON so JS scripts (which can't import TS) can read it. */
if (import.meta.url === `file://${process.argv[1]}`) {
  const out: Record<string, number | null> = {};
  for (const [id, score] of getCriticScoreMap()) out[id] = score;
  process.stdout.write(JSON.stringify(out, null, 2));
}
