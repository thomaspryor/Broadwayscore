/**
 * Pure helpers for pulling Broadway shows Theatr files under a non-Theatre
 * genre (BRO-5943: "Billy Crystal 860" is listed as 'Billy Crystal', About:
 * Other, so the genreCategory == 'Theatre' query never saw it).
 */

const BROADWAY_EVENT_CATEGORIES = ['Broadway', 'Off & Off-Off Broadway'];

// Keep only records whose eventCategory is Broadway / Off & Off-Off Broadway.
function filterBroadwayCategories(records) {
  return (records || []).filter(r => r && BROADWAY_EVENT_CATEGORIES.includes(r.eventCategory));
}

// Merge extra-genre records into the Theatre-genre records. Primary wins on id
// collision; extras without a Broadway-ish eventCategory are dropped. Order:
// primary first, then new extras.
function mergeTheatrShows(primary, extra) {
  const merged = [...(primary || [])];
  const seen = new Set(merged.map(r => r && r.id));
  for (const r of filterBroadwayCategories(extra)) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    merged.push(r);
  }
  return merged;
}

module.exports = { BROADWAY_EVENT_CATEGORIES, filterBroadwayCategories, mergeTheatrShows };
