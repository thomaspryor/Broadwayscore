'use strict';

const { buildSiblingIndex, classifyMarketRouting } = require('./market-routing');
const { detectSiblingMisfile } = require('./sibling-misfile');
const { isWithinPriorRun, isWithinTourLeg } = require('./wrong-production-autoclear');
const { computeProductionWindow, isPostInProductionWindow } = require('./production-window');

// BRO-6733: use the same page-level production vote as the archive writer.
// A transfer can open within the tile guard's 180-day closing grace period.
// Only dates printed on the source page vote; outlet URL slugs do not.
function showScoreSiblingPriorRunSources(tiles, show, allShows) {
  const siblingIndex = buildSiblingIndex(allShows);
  const ctx = { category: show.category, siblingIndex };
  const window = computeProductionWindow(show, allShows);
  const dated = tiles.map((tile) => {
    const date = tile.date;
    const inherited = isWithinPriorRun(date, show.priorRuns) || isWithinTourLeg(date, show.tourLegs);
    const inOwnRun = date && Number.isFinite(Date.parse(date))
      && isPostInProductionWindow({ created_utc: Date.parse(date) / 1000 }, show, window);
    return { publishDate: inherited || inOwnRun ? null : date };
  });
  // Carried-over tiles describe other productions, not the page's own run.
  const page = detectSiblingMisfile(show.id, dated.filter((_, i) => !tiles[i].previousProduction), ctx);
  const sources = new Map();
  for (let i = 0; i < tiles.length; i++) {
    const tile = tiles[i];
    if (!tile.date || !Number.isFinite(Date.parse(tile.date))) {
      // A dated tile can identify its own run on a mixed-production page.
      // Only undated links inherit the source page's production identity.
      if (page.misfiled && !tile.previousProduction) sources.set(tile.url, `show-score-page-sibling:${page.targetId}`);
      continue;
    }
    if (!dated[i].publishDate) continue; // own run or declared inherited coverage
    const decision = classifyMarketRouting({ showId: show.id, ...ctx, ...dated[i] });
    if (decision.action === 'reroute') {
      sources.set(tile.url, `show-score-tile-sibling:${decision.targetShowId}`);
    } else if (page.misfiled && !tile.previousProduction) {
      // A late review can miss the opening-date vote while still falling
      // beyond this closed run and on the confirmed sibling's source page.
      sources.set(tile.url, `show-score-page-sibling:${page.targetId}`);
    }
  }
  return sources;
}

module.exports = { showScoreSiblingPriorRunSources };
