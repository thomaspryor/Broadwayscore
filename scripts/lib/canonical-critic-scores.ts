/**
 * canonical-critic-scores.ts — THE only sanctioned way to get a show's Critic
 * Score for any analysis, post, email, or external claim.
 *
 * SOURCE OF TRUTH: `public/data/shows/{id}.json` (the slim files served to the
 * live site). The `cs` field there is computed by
 * `scripts/generate-mobile-data.js` from raw review-text files via
 * `loadReviewsWithBlog()` + `compute-critic-score.js`. By reading the slim
 * files directly, this helper guarantees parity with the live site by
 * definition — there is no second pipeline to drift.
 *
 * Why this version exists: the previous implementation read `data/reviews.json`
 * via `getAllShows()` → `engine.ts`, which applies different review-inclusion
 * filters than the slim-file generator. For In the Heights (2008) the helper
 * returned 69 while the live site (and the slim file) had 78 — same scorer,
 * different filtered inputs. The 2026-06-02 incident shipped a guest-post doc
 * with the helper's fabricated numbers because nothing reconciled to prod.
 *
 * Display convention: integer rounding (the site does this — external copy
 * must match). Use `getCriticScore(showId)` which already rounds; only use
 * `getCriticScoreRaw(showId)` if you have a specific internal reason for a
 * float and aren't publishing it.
 */

import { readFileSync, readdirSync, existsSync } from 'fs';
import { resolve, join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const SLIM_DIR = resolve(dirname(__filename), '..', '..', 'public', 'data', 'shows');

let cache: Map<string, number | null> | null = null;
let cacheRaw: Map<string, number | null> | null = null;

function buildCache() {
  if (cache && cacheRaw) return;
  cache = new Map();
  cacheRaw = new Map();
  if (!existsSync(SLIM_DIR)) {
    throw new Error(
      `canonical-critic-scores: ${SLIM_DIR} does not exist. ` +
      `Run \`node scripts/generate-mobile-data.js\` first, or ensure the slim ` +
      `files are present in this worktree.`
    );
  }
  for (const f of readdirSync(SLIM_DIR)) {
    if (!f.endsWith('.json')) continue;
    const id = f.slice(0, -5);
    let raw: number | null = null;
    try {
      const j = JSON.parse(readFileSync(join(SLIM_DIR, f), 'utf8'));
      raw = typeof j.cs === 'number' ? j.cs : null;
    } catch {
      raw = null;
    }
    cacheRaw.set(id, raw);
    cache.set(id, raw == null ? null : Math.round(raw));
  }
}

/** Reset the cache. Call between runs if slim files change mid-process. */
export function resetCache(): void {
  cache = null;
  cacheRaw = null;
}

/** Canonical Critic Score for a show, rounded to integer the way the site displays it. */
export function getCriticScore(showId: string): number | null {
  buildCache();
  return cache!.get(showId) ?? null;
}

/** Raw (unrounded) Critic Score from the slim file. Use only for internal sort/tiebreak; never publish externally. */
export function getCriticScoreRaw(showId: string): number | null {
  buildCache();
  return cacheRaw!.get(showId) ?? null;
}

/** Full map of {showId → integer Critic Score} for batch analyses.
 *  Returns a defensive copy — callers can't mutate the internal cache. */
export function getCriticScoreMap(): Map<string, number | null> {
  buildCache();
  return new Map(cache!);
}

/** CLI: `npx tsx scripts/lib/canonical-critic-scores.ts > /tmp/critic-scores.json`
 *  Dumps the integer map as JSON so JS scripts (which can't import TS) can read it. */
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const out: Record<string, number | null> = {};
  for (const [id, score] of getCriticScoreMap()) out[id] = score;
  process.stdout.write(JSON.stringify(out, null, 2));
}
