// TESTS-VS-DERIVED-DATA-EXEMPT: structural checks only (category-market
// mapping is pure code; the data-integrity block asserts count>0 and
// classifiability, never a specific show's win/nom facts) — no pinned claim
// can rot when data/precursors/olivier.json is re-scraped.

/**
 * BRO-573 — Olivier Award info on West End shows.
 *
 * Pins the market-selection bug this ticket fixes: AwardScoreCard used to
 * hardcode computeSiteAwardScore(showId, 'broadway') for every show, so a
 * West End show's Olivier wins were scored on the Broadway weight table
 * (olivier_bway) instead of the West End one (olivier_we) that already
 * existed in src/lib/awards-scoring.ts — silently under-scoring the show's
 * own marquee award. The fix threads show.category through
 * ShowPageBelowFold -> AwardsCard -> AwardScoreCard and picks the market via
 * categoryToMarket() (src/lib/awards-scoring.ts), which wraps the pure
 * function under test here per CLAUDE.md rule 15 (extract + require, no
 * re-implemented logic in the test).
 *
 * Run: node --test tests/unit/olivier-awards.test.mjs
 *
 * The source-of-truth function is scripts/lib/olivier-award-market.js:
 * categoryToAwardsMarket, imported directly (not mirrored) by
 * src/lib/awards-scoring.ts:categoryToMarket.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const { categoryToAwardsMarket } = require('../../scripts/lib/olivier-award-market.js');
const { classifyCategory } = require('../../scripts/lib/classify-category.js');

describe('categoryToAwardsMarket — show category -> Olivier scoring market', () => {
  it('routes West End shows to the west-end market (olivier_we weight table)', () => {
    assert.equal(categoryToAwardsMarket('west-end'), 'west-end');
  });

  it('routes Off-West End shows to the west-end market too', () => {
    assert.equal(categoryToAwardsMarket('off-west-end'), 'west-end');
  });

  it('routes Broadway shows to the broadway market', () => {
    assert.equal(categoryToAwardsMarket('broadway'), 'broadway');
  });

  it('routes Off-Broadway and regional shows to the broadway market (no OWE-style Olivier table)', () => {
    assert.equal(categoryToAwardsMarket('off-broadway'), 'broadway');
    assert.equal(categoryToAwardsMarket('regional'), 'broadway');
  });

  it('defaults unknown/missing category to broadway (existing computeSiteAwardScore default)', () => {
    assert.equal(categoryToAwardsMarket(undefined), 'broadway');
    assert.equal(categoryToAwardsMarket('made-up-category'), 'broadway');
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Data-integrity gate over data/awards.json + data/shows.json: every real
// West End show carrying Olivier data must (a) map to the west-end market,
// and (b) have its Olivier category names classify to a real scoring tier —
// an unclassified category silently contributes 0 points and never renders
// in the OlivierAwardsPanel breakdown, which is exactly the "fields not
// correctly mapped" failure mode BRO-573's acceptance criteria calls out.
// ──────────────────────────────────────────────────────────────────────────
describe('West End Olivier data — real dataset sanity', () => {
  const showsPath = resolve(__dirname, '../../data/shows.json');
  const awardsPath = resolve(__dirname, '../../data/awards.json');
  const showsRaw = JSON.parse(readFileSync(showsPath, 'utf8'));
  const showList = Array.isArray(showsRaw) ? showsRaw : showsRaw.shows;
  const awards = JSON.parse(readFileSync(awardsPath, 'utf8'));

  const categoryById = new Map(showList.map(s => [s.id, s.category]));
  const westEndShowsWithOlivier = Object.entries(awards.shows)
    .filter(([id, entry]) => entry.olivier && categoryById.get(id) === 'west-end');

  it('finds at least one real West End show with Olivier award data', () => {
    assert.ok(westEndShowsWithOlivier.length > 0, 'expected data/awards.json to have west-end shows with olivier data');
  });

  it('maps every West End show with Olivier data to the west-end scoring market', () => {
    for (const [id] of westEndShowsWithOlivier) {
      assert.equal(categoryToAwardsMarket(categoryById.get(id)), 'west-end', `${id} should score on the west-end Olivier table`);
    }
  });

  it('classifies every Olivier win/nomination category for West End shows to a scoring tier', () => {
    const unclassified = new Set();
    for (const [, entry] of westEndShowsWithOlivier) {
      const cats = [...(entry.olivier.wins ?? []), ...(entry.olivier.nominatedFor ?? [])];
      for (const cat of cats) {
        if (!classifyCategory(cat)) unclassified.add(cat);
      }
    }
    assert.deepEqual([...unclassified], [], 'unclassified Olivier categories score 0 and never render — extend classifyCategory');
  });

  // Regression for a bug an independent review caught before merge: the show-page
  // panel's sortByImportance()/isMajorCategory() (src/config/awards.ts) are hardcoded
  // to exact Tony strings ("Best Musical", "Best Direction of a Musical"), which never
  // match Olivier's own naming ("Best New Musical", "Best Director") — so every Olivier
  // marquee win rendered with the same dim styling and fell to the bottom of the sorted
  // list. The fix (AwardScoreCard.tsx's sortOlivierByImportance/isMajorOlivierCategory)
  // derives ranking from classifyCategory's ceremony-agnostic S/A+/A/B/C tier instead of
  // a Tony-only string list. This pins that Olivier's real top-line categories land in
  // the "major" S/A tier under that tier system, not just "classified at all".
  it('tiers Olivier marquee categories (Best New Musical/Play, Best Director, lead acting) as S/A — the "major" tiers', () => {
    const marquee = ['Best New Musical', 'Best New Play', 'Best Revival', 'Best Musical Revival', 'Best Director', 'Best Actor', 'Best Actress', 'Best Actor in a Musical', 'Best Actress in a Musical'];
    for (const cat of marquee) {
      const tier = classifyCategory(cat)?.tier;
      assert.ok(tier === 'S' || tier === 'A' || tier === 'A+', `${cat} classified as tier ${tier}, expected S/A/A+`);
    }
  });
});
