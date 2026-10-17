// TESTS-VS-DERIVED-DATA-EXEMPT: parity test — the same core data fed through the website path (data-core/engine.ts) and the slim-file path (slim-critic-score.js); asserts equality, no factual pins.
/**
 * BRO-4312: every page that displays a Critic Score must show the same value
 * the slim file's `cs` carries (the value scripts/lib/canonical-critic-scores.ts
 * getCriticScore() reads for posts, emails and external claims).
 *
 * Website path: getAllShows() (src/lib/data-core.ts → engine.ts computeShowData)
 * gives criticScore; pages show it only when hasEnoughReviews() passes
 * (HomePageClient, ShowListCard, MiniShowCard, BrowseListClient, FeaturedRowServer).
 * Slim path: scripts/lib/slim-critic-score.js computeSlimCriticScore(), the exact
 * decision scripts/generate-mobile-show-details.js writes as `cs`.
 *
 * A failure here is a real divergence, never noise: both paths read the same
 * data files in this process. It caught the BRO-4312 gap (7 curated historical
 * shows badged on the site, no slim `cs`) and would catch an input-pipeline split
 * like the 2026-06-02 In the Heights incident (69 vs 78).
 *
 * Also pins the methodology page's displayed constants to the ones the shared
 * scorer computes with, since engine.ts now delegates the math.
 *
 * Run: npx tsx --test tests/unit/critic-score-canonical-parity.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';

import { TIER_WEIGHTS, DESIGNATION_BUMPS, DESIGNATION_FLOORS, TOP_CRITICS } from '../../src/config/scoring';

const require = createRequire(import.meta.url);
const { computeSlimCriticScore } = require('../../scripts/lib/slim-critic-score');
const { loadReviewsWithBlog } = require('../../scripts/lib/load-reviews-with-blog');
const shared = require('../../scripts/lib/compute-critic-score');

const DATA_READY = ['data/shows.json', 'data/reviews.json', 'data/outlet-registry.json']
  .every((p) => existsSync(resolve(p)));

describe('Critic Score: website display == slim cs (every show)', () => {
  it('each show displays exactly the canonical slim-file score, or neither shows one', { skip: !DATA_READY && 'core data not checked out' }, async () => {
    // Imported lazily: data-core statically imports data/*.json.
    const { getAllShows } = await import('../../src/lib/data-core');
    const { hasEnoughReviews } = await import('../../src/config/score-buckets');
    const { CURATED_HISTORICAL_SHOWS } = await import('../../src/config/scoring');

    const rawShows: Array<{ id: string }> = JSON.parse(readFileSync(resolve('data/shows.json'), 'utf8')).shows;
    const rawById = new Map(rawShows.map((s) => [s.id, s]));
    const registry = JSON.parse(readFileSync(resolve('data/outlet-registry.json'), 'utf8')).outlets || {};
    const byShow = new Map<string, object[]>();
    for (const r of loadReviewsWithBlog() as Array<{ showId: string }>) {
      if (!byShow.has(r.showId)) byShow.set(r.showId, []);
      byShow.get(r.showId)!.push(r);
    }

    const mismatches: string[] = [];
    let compared = 0;
    let scored = 0;
    for (const show of getAllShows()) {
      const raw = rawById.get(show.id);
      if (!raw) continue;
      compared++;
      const c = show.criticScore;
      const siteDisplayed = c && hasEnoughReviews(
        c.reviewCount, show.category, (c.tier1Count || 0) + (c.tier2Count || 0), CURATED_HISTORICAL_SHOWS.has(show.id),
      ) ? c.score : null;
      const slim = computeSlimCriticScore(raw, byShow.get(show.id) || [], registry);
      if (slim.cs != null) scored++;
      if (siteDisplayed !== slim.cs || (slim.cs != null && c!.reviewCount !== slim.rc)) {
        mismatches.push(`${show.id}: site=${siteDisplayed}/${c?.reviewCount ?? '-'} slim=${slim.cs}/${slim.rc ?? '-'}`);
      }
    }
    assert.ok(compared > 500, `compared only ${compared} shows; data-core and shows.json disagree on ids`);
    assert.ok(scored > 300, `only ${scored} shows scored; the slim path is not loading reviews`);
    assert.deepStrictEqual(mismatches.slice(0, 25), [], `${mismatches.length} shows display a different Critic Score than the slim cs`);
  });
});

describe('Critic Score: methodology constants == computing constants', () => {
  it('scoring.ts (shown on /methodology) matches scripts/lib/compute-critic-score.js (used to compute)', () => {
    assert.deepStrictEqual({ ...shared.TIER_WEIGHTS }, { ...TIER_WEIGHTS });
    assert.deepStrictEqual({ ...shared.DESIGNATION_BUMPS }, { ...DESIGNATION_BUMPS });
    assert.deepStrictEqual({ ...shared.DESIGNATION_FLOORS }, { ...DESIGNATION_FLOORS });
    assert.deepStrictEqual([...shared.TOP_CRITICS].sort(), [...TOP_CRITICS].sort());
  });
});

// Website code must not re-derive the display gate from the bare market minimum
// (it drops the +2 T3-only rule and the curated carve-out). ScoreBadge, browse
// lists and the SEO schema all did (BRO-4312); use displaysCriticScore()
// (src/lib/critic-score-display.ts) or hasEnoughReviews().
export function findBareMinimumGates(source: string): number[] {
  const lines = source.split('\n');
  const hits: number[] = [];
  lines.forEach((line, i) => {
    if (/^\s*(\/\/|\*)/.test(line)) return;
    if (/getMarketMinReviews\(/.test(line) && /reviewCount/.test(line)) { hits.push(i + 1); return; }
    // Hard-coded 3/4/5 thresholds on reviewCount, unless the line (or the one
    // above) carries `display-gate-ok:` naming why it is not the badge gate.
    if (/reviewCount[^;\n]*(?:>=|<|>|<=)\s*[345]\b/.test(line)
      && !/display-gate-ok:/.test(line) && !/display-gate-ok:/.test(lines[i - 1] || '')) { hits.push(i + 1); return; }
    const m = line.match(/\b(?:const|let)\s+([\w$]+)\s*=\s*getMarketMinReviews\(/);
    if (!m) return;
    const v = m[1];
    const use = new RegExp(`reviewCount[^;\\n]*(?:>=|<)\\s*${v}\\b|\\b${v}\\b\\s*(?:<=|>)[^;\\n]*reviewCount`);
    if (lines.slice(i, i + 8).some((l) => use.test(l))) hits.push(i + 1);
  });
  return hits;
}

describe('Critic Score: no bare-minimum display gates in src/', () => {
  // tour-listing.ts applies the tour rule (+2 with no T1/T2) on purpose and is
  // covered by its own parity tests; og/route.tsx's show mode has no callers.
  const ALLOW = new Set(['src/lib/tour-listing.ts', 'src/app/api/og/route.tsx']);
  it('flags the shapes that shipped', () => {
    assert.deepStrictEqual(findBareMinimumGates('if (show.criticScore?.reviewCount >= getMarketMinReviews(cat)) x();'), [1]);
    assert.deepStrictEqual(findBareMinimumGates('let minReviews = getMarketMinReviews(category);\nif (tier === 0) minReviews += 2;\nif (reviewCount < minReviews) tbd();'), [1]);
    assert.deepStrictEqual(findBareMinimumGates('const n = getMarketMinReviews(c);\nconst text = `needs ${n} reviews`;'), []);
    assert.deepStrictEqual(findBareMinimumGates('if ((show.criticScore?.reviewCount ?? 0) < 3) return false;'), [1]);
    assert.deepStrictEqual(findBareMinimumGates('// display-gate-ok: lists every new show, TBD included\nif ((show.criticScore?.reviewCount ?? 0) < 3) return false;'), []);
  });
  it('src/ uses the shared gate', () => {
    const { readdirSync, statSync } = require('fs') as typeof import('fs');
    const walk = (d: string): string[] => readdirSync(d).flatMap((f: string) => {
      const p = `${d}/${f}`;
      return statSync(p).isDirectory() ? walk(p) : (/\.(ts|tsx)$/.test(f) && !/\.test\./.test(f) ? [p] : []);
    });
    const bad = walk('src')
      .filter((p) => !ALLOW.has(p))
      .flatMap((p) => findBareMinimumGates(readFileSync(p, 'utf8')).map((l) => `${p}:${l}`));
    assert.deepStrictEqual(bad, [], 'compare reviewCount through displaysCriticScore()/hasEnoughReviews(), not getMarketMinReviews()');
  });
});
