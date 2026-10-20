// TESTS-VS-DERIVED-DATA-EXEMPT: parity test, the same core data fed through the website path (data-core/engine.ts + ScoreBadge/score-buckets) and the app feed path (scripts/lib/mobile-critic-score.js); asserts equality, no factual pins.
/**
 * The iOS app shows `cr.l` from public/data/mobile-shows.json as the tier
 * label, gates its cards and badges on `cr.q` and its show page on `cr.pq`.
 * Each must say what the same website surface says:
 *
 *   l   == ScoreBadge.getScoreTier(round(score), category).label
 *   q   == hasEnoughReviews(reviewCount, category, T1+T2, curated-historical),
 *          the card/badge gate (ShowListCard)
 *   pq  == !showTBD on the show page (src/app/show/[slug]/page.tsx): q's gate,
 *          previews/upcoming, then applyCoverageFloor with the show's
 *          scorePublicSince / cov.state / coverageAcked from data-core
 *
 * Before this, the generator kept its own label function that ignored the
 * market (West End 84 read "Critical Gold" in the app, "Recommended" on the
 * site), compared the unrounded score (82.6 read "Recommended" in the app,
 * "Critical Gold" on the site) and said "Skippable" where the site says
 * "Mixed"; and the feed had no review-count flag at all.
 *
 * Run: npx tsx --test tests/unit/mobile-feed-website-parity.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';

import { getScoreTier } from '../../src/components/show-cards/ScoreBadge';
import { getScoreLabel, getGoldThreshold as siteGoldThreshold } from '../../src/config/score-buckets';

const require = createRequire(import.meta.url);
const tiers = require('../../scripts/lib/score-tiers');
const { buildMobileCriticScore } = require('../../scripts/lib/mobile-critic-score');
const { shouldHideReviews } = require('../../scripts/lib/should-hide-reviews');
const { loadReviewsWithBlog } = require('../../scripts/lib/load-reviews-with-blog');
const { loadCoverageFloorInputs, coverageFloorOptsForShow } = require('../../scripts/lib/coverage-floor-inputs');

const CATEGORIES = [undefined, 'broadway', 'off-broadway', 'off-off-broadway', 'west-end', 'off-west-end', 'regional', 'tour'];

describe('score tier label: app feed == website badge', () => {
  it('getScoreTierLabel equals ScoreBadge.getScoreTier for every score 0-100 (0.01 steps) in every market', () => {
    const misses: string[] = [];
    for (const cat of CATEGORIES) {
      for (let i = 0; i <= 10000; i++) {
        const score = i / 100;
        const site = getScoreTier(score, cat)?.label;
        const feed = tiers.getScoreTierLabel(score, cat);
        if (site !== feed) misses.push(`${cat ?? '(none)'} ${score}: site ${site}, feed ${feed}`);
      }
    }
    assert.deepEqual(misses.slice(0, 10), [], `${misses.length} disagreements`);
  });

  it('score-buckets getScoreLabel (unrounded) uses the same tiers and labels', () => {
    for (const cat of CATEGORIES) {
      assert.equal(siteGoldThreshold(cat), tiers.getGoldThreshold(cat));
      for (let i = 0; i <= 10000; i++) {
        const score = i / 100;
        assert.equal(getScoreLabel(score, cat), tiers.SCORE_TIER_LABELS[tiers.getScoreTierId(score, cat)], `${cat} ${score}`);
      }
    }
  });

  it('the cases the audit found', () => {
    assert.equal(tiers.getScoreTierLabel(84.3, 'west-end'), 'Recommended'); // West End Gold is 85
    assert.equal(tiers.getScoreTierLabel(84.3, 'broadway'), 'Critical Gold');
    assert.equal(tiers.getScoreTierLabel(82.6, 'broadway'), 'Critical Gold'); // displays as 83
    assert.equal(tiers.getScoreTierLabel(82.6, 'west-end'), 'Recommended');
    assert.equal(tiers.getScoreTierLabel(64.1, 'broadway'), 'Mixed');
    assert.equal(tiers.getScoreTierLabel(74.5, undefined), 'Recommended'); // displays as 75
    assert.equal(tiers.getScoreTierLabel(null, 'broadway'), null);
  });
});

const DATA_READY = ['data/shows.json', 'data/reviews.json', 'data/outlet-registry.json']
  .every((p) => existsSync(resolve(p)));

describe('cr.q, cr.pq and cr.l: app feed == website, every show', () => {
  it('each scored show gets the website badge label and the show page TBD decision', { skip: !DATA_READY && 'core data not checked out' }, async () => {
    // Imported lazily: data-core statically imports data/*.json.
    const { getAllShows } = await import('../../src/lib/data-core');
    const { hasEnoughReviews, applyCoverageFloor } = await import('../../src/config/score-buckets');
    const { CURATED_HISTORICAL_SHOWS } = await import('../../src/config/scoring');

    type RawShow = { id: string; category?: string; type?: string; status?: string; openingDate?: string };
    const rawShows: RawShow[] = JSON.parse(readFileSync(resolve('data/shows.json'), 'utf8')).shows;
    const rawById = new Map(rawShows.map((s) => [s.id, s]));
    const registry = JSON.parse(readFileSync(resolve('data/outlet-registry.json'), 'utf8')).outlets || {};
    const byShow = new Map<string, object[]>();
    for (const r of loadReviewsWithBlog() as Array<{ showId: string }>) {
      if (!byShow.has(r.showId)) byShow.set(r.showId, []);
      byShow.get(r.showId)!.push(r);
    }

    // The feed reads the floor inputs with the loader generate-mobile-data.js
    // uses; the site side reads what data-core attached to each show. One
    // clock for both, so a stamp crossing 24h mid-test cannot flake.
    const floorInputs = loadCoverageFloorInputs(resolve('data'));
    const now = Date.now();

    const mismatches: string[] = [];
    let compared = 0;
    let gated = 0;
    let pageDiffersFromCard = 0;
    for (const show of getAllShows()) {
      const cs = show.criticScore;
      const raw = rawById.get(show.id);
      if (!cs || !raw || shouldHideReviews(raw)) continue;
      const feed = buildMobileCriticScore(raw, byShow.get(show.id) || [], registry, { ...coverageFloorOptsForShow(floorInputs, raw), now });
      if (!feed) {
        mismatches.push(`${show.id}: website has a score, feed has none`);
        continue;
      }
      compared++;
      const siteQ = hasEnoughReviews(
        cs.reviewCount || 0, show.category, (cs.tier1Count || 0) + (cs.tier2Count || 0), CURATED_HISTORICAL_SHOWS.has(show.id),
      ) ? 1 : 0;
      if (siteQ === 0) gated++;
      const siteL = getScoreTier(Math.round(cs.score), show.category)?.label;
      // Same expression as the show page's showTBD.
      const sitePageTBD = applyCoverageFloor(
        !siteQ || show.status === 'previews' || show.status === 'upcoming',
        { scorePublicSince: show.scorePublicSince, coverageState: show.cov?.state, coverageAcked: show.coverageAcked, now },
      );
      const sitePQ = sitePageTBD ? 0 : 1;
      if (sitePQ !== siteQ) pageDiffersFromCard++;
      if (feed.q !== siteQ) mismatches.push(`${show.id}: q feed ${feed.q}, site ${siteQ}`);
      if (feed.pq !== sitePQ) mismatches.push(`${show.id}: pq feed ${feed.pq}, site ${sitePQ}`);
      if (feed.l !== siteL) mismatches.push(`${show.id}: l feed ${feed.l}, site ${siteL}`);
      if (feed.s !== cs.score) mismatches.push(`${show.id}: s feed ${feed.s}, site ${cs.score}`);
    }
    assert.ok(compared > 100, `only ${compared} shows compared; data looks incomplete`);
    assert.ok(gated > 0, 'no show is below the review-count gate; the q check would be vacuous');
    assert.ok(pageDiffersFromCard > 0, 'no show page differs from its card; the pq check would be vacuous');
    assert.deepEqual(mismatches.slice(0, 20), [], `${mismatches.length} mismatches over ${compared} shows`);
  });
});

describe('the show page gate the feed mirrors has not moved', () => {
  it('src/app/show/[slug]/page.tsx still computes showTBD as cr.pq does', () => {
    // If the website's show-page rule changes, buildMobileCriticScore must
    // change with it (and the app's isShowPageScoreTBD reads the result).
    const page = readFileSync(resolve('src/app/show/[slug]/page.tsx'), 'utf8').replace(/\s+/g, ' ');
    assert.ok(
      page.includes("const showTBD = applyCoverageFloor( !hasEnoughReviews(reviewCount, show.category, tier1Count + tier2Count, isCuratedHistoricalShow) || show.status === 'previews' || show.status === 'upcoming', { scorePublicSince: show.scorePublicSince, coverageState: show.cov?.state, coverageAcked: show.coverageAcked }, );"),
      'the show page TBD gate changed: update scripts/lib/mobile-critic-score.js (pq) to match',
    );
  });
});
