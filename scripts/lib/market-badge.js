'use strict';

/**
 * Should a show card render its market pill (OFF-BROADWAY / WEST END /
 * Off-WE / REGIONAL / TOUR)? One decision for every CategoryBadge callsite
 * and the Off-Broadway inline label on ShowListCard (BRO-7313).
 *
 * Opera shows never get a market pill: FormatPill already says OPERA, and an
 * Off-West-End opera used to show OPERA + Off-WE side by side. Broadway (or a
 * missing category) has no pill either. Mirrors the opening-digest email
 * (BRO-7311, scripts/send-opening-digest.js metadataPills).
 *
 * @param {string|null|undefined} category  show.category ('off-west-end', ...)
 * @param {boolean} isOpera                 isOperaShow(show), i.e. type === 'opera'
 * @returns {boolean}
 */
function showsMarketBadge(category, isOpera) {
  if (isOpera) return false;
  // Intentionally NOT isBroadwayCategory: this module is bundled into client
  // components, and venue-classification.js pulls in path/__dirname + data JSON.
  // Same semantics (missing category = Broadway).
  if (!category || category === 'broadway') return false;
  return true;
}

/**
 * Which pill a search dropdown shows for a result (HeaderSearch,
 * ShowSearchDropdown, CompareShowPicker). Those always show one pill, so an
 * opera gets 'opera' (labelled "Opera") instead of its market (BRO-7313:
 * Met Opera results read "Off-Bway"). search-shows.json sets type only for
 * operas.
 *
 * @param {string|null|undefined} category
 * @param {boolean} isOpera
 * @returns {string} 'opera' or the category, defaulting to 'broadway'
 */
function searchPillMarket(category, isOpera) {
  if (isOpera) return 'opera';
  return category || 'broadway';
}

module.exports = { showsMarketBadge, searchPillMarket };
