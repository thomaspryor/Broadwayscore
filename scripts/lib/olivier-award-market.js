/**
 * Maps a show's market category to the Olivier/Tony scoring "market" that
 * src/lib/awards-scoring.ts:computeSiteAwardScore uses to pick the Olivier
 * weight table (olivier_we vs olivier_bway). West End productions' Olivier
 * wins carry far more prestige weight for a London show than the same win
 * would as a secondary credit on a Broadway transfer's page — the two tables
 * exist precisely to keep West End show pages from under-scoring their own
 * marquee award.
 */

function categoryToAwardsMarket(category) {
  return category === 'west-end' || category === 'off-west-end' ? 'west-end' : 'broadway';
}

module.exports = { categoryToAwardsMarket };
